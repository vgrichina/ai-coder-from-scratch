#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');
const debug = require('debug')('ai-coder');

const API_KEY = process.env.OPENROUTER_API_KEY;
const API_URL = process.env.OPENROUTER_API_URL || 'https://openrouter.ai/api/v1/chat/completions';
const MODEL_NAME = process.env.OPENROUTER_MODEL_NAME || 'anthropic/claude-3.5-sonnet';

const displayHelpAndExit = () => {
    console.log(`
ai-coder [options] <command>
  -k, --key <key>            API key (default: $OPENROUTER_API_KEY)
  -u, --url <url>            API URL (default: ${API_URL})
  -m, --model <model_name>   LLM model name (default: ${MODEL_NAME})
  -h, --help                 Show this help

Commands:
    ask [file1] [file2] [fileN]             Ask about code (just show LLM response). Files are provided to LLM as a context.
    commit [file1] [file2] [fileN]          Create git commit based on given prompt. Files are provided to LLM as a context and then edited.

Prompt needs to be provided in stdin like:


echo "Hello, World in JS" | ai-coder commit hello.js


If no command is given - output help message.
`);
    process.exit(0);
};

if (process.argv.length < 3) {
    displayHelpAndExit();
}

const parsedArgs = require('minimist')(process.argv.slice(2), {
    string: ['k', 'key', 'u', 'url', 'm', 'model'],
    boolean: ['h', 'help'],
    alias: {
        k: 'key',
        u: 'url',
        m: 'model',
        h: 'help'
    },
    default: {
        key: API_KEY,
        url: API_URL,
        model: MODEL_NAME
    }
});

if (parsedArgs.help) {
    displayHelpAndExit();
}

if (!parsedArgs.key) {
    console.error('API key is required. Set OPENROUTER_API_KEY env variable or use --key option.');
    process.exit(1);
}

const command = parsedArgs._[0];
const files = parsedArgs._.slice(1);

if (!['ask', 'commit'].includes(command)) {
    console.error(`Invalid command: ${command}`);
    displayHelpAndExit();
}

const systemPrompt = fs.readFileSync(path.join(__dirname, 'system_prompt.txt'), 'utf8');
const userPromptTemplate = fs.readFileSync(path.join(__dirname, 'user_prompt.txt'), 'utf8');

let userInput = '';
process.stdin.on('data', chunk => {
    userInput += chunk;
});

process.stdin.on('end', async () => {
    const fileContents = files.map(file => {
        try {
            const content = fs.readFileSync(file, 'utf8');
            return `${file}\n\`\`\`\n${content}\n\`\`\`\n`;
        } catch (err) {
            console.error(`Error reading file ${file}: ${err.message}`);
            return '';
        }
    }).join('\n');

    const userPrompt = userPromptTemplate
        .replace('{{USER_REQUEST}}', userInput.trim())
        .replace('{{FILES}}', fileContents);

    debug('>>> System Prompt:\n%s', systemPrompt);
    debug('>>> User Prompt:\n%s', userPrompt);

    const requestData = {
        model: parsedArgs.model,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ],
        stream: false
    };

    const options = {
        hostname: new URL(parsedArgs.url).hostname,
        path: new URL(parsedArgs.url).pathname,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${parsedArgs.key}`
        }
    };

    const req = https.request(options, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
            try {
                const response = JSON.parse(data);
                const code = response.choices[0].message.content;
                debug('<<< GPT Response:\n%s', code);

                if (command === 'ask') {
                    console.log(code);
                } else if (command === 'commit') {
                    const match = code.match(/```(?:javascript|js)?\n([\s\S]*?)\n```\s*$/m);
                    if (match) {
                        const modifiedCode = match[1].trimEnd();
                        const commitSummary = response.choices[0].message.content.split('```')[0].trim();

                        const gitCommitTemplate = `${commitSummary}

Original prompt:

${userInput.trim()}
`;

                        const gitProcess = spawn('git', ['commit', '-a', '-F', '-']);
                        gitProcess.stdin.write(gitCommitTemplate);
                        gitProcess.stdin.end();

                        for (const file of files) {
                            fs.writeFileSync(file, modifiedCode);
                        }
                    } else {
                        console.error('No code found in response');
                    }
                }
            } catch (err) {
                console.error('Error parsing response:', err);
            }
        });
    });

    req.on('error', error => {
        console.error('Error:', error);
    });

    req.write(JSON.stringify(requestData));
    req.end();
});
