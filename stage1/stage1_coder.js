#!/usr/bin/env node

const fs = require('fs');
const https = require('https');
const debug = require('debug')('ai-coder');

const API_KEY = process.env.OPENROUTER_API_KEY || '';
const API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL_NAME = 'anthropic/claude-3.5-sonnet';

const help = `
ai-coder [options] <command>
  -k, --key <key>            API key (default: $OPENROUTER_API_KEY)
  -u, --url <url>            API URL (default: ${API_URL})
  -m, --model <model_name>   LLM model name (default: ${MODEL_NAME})
  -h, --help                 Show this help

Commands:
    ask [file1] [file2] [fileN]             Ask about code (just show LLM response)
    commit [file1] [file2] [fileN]          Create git commit based on given prompt

Prompt needs to be provided in stdin like:


echo "Hello, World in JS" | ai-coder commit hello.js


If no command is given - output help message.
`;

function parseArgs(args) {
    let key = API_KEY;
    let url = API_URL;
    let model = MODEL_NAME;
    let command = null;
    let files = [];

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        switch (arg) {
            case '-k':
            case '--key':
                key = args[++i];
                break;
            case '-u':
            case '--url':
                url = args[++i];
                break;
            case '-m':
            case '--model':
                model = args[++i];
                break;
            case '-h':
            case '--help':
                console.log(help);
                process.exit(0);
            default:
                if (!command) {
                    command = arg;
                } else {
                    files.push(arg);
                }
                break;
        }
    }

    return { key, url, model, command, files };
}

function getPrompt(files) {
    let prompt = '';
    for (const file of files) {
        try {
            const content = fs.readFileSync(file, 'utf8');
            prompt += `\`\`\`\n${content}\n\`\`\`\n`;
        } catch (err) {
            console.error(`Error reading file ${file}: ${err}`);
        }
    }
    return prompt;
}

async function askLLM(key, url, model, prompt) {
    const requestData = {
        model,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt }
        ]
    };

    const options = {
        hostname: new URL(url).hostname,
        path: new URL(url).pathname,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${key}`
        }
    };

    return new Promise((resolve, reject) => {
        const req = https.request(options, res => {
            let data = '';
            res.on('data', chunk => {
                data += chunk;
            });
            res.on('end', () => {
                try {
                    const response = JSON.parse(data);
                    resolve(response.choices[0].message.content);
                } catch (err) {
                    reject(`Error parsing response: ${err}`);
                }
            });
        });

        req.on('error', error => {
            reject(`Error: ${error}`);
        });

        req.write(JSON.stringify(requestData));
        req.end();
    });
}

async function gitCommit(files, prompt) {
    try {
        const summary = await askLLM(API_KEY, API_URL, MODEL_NAME, prompt);
        const commitMessage = `${summary.trim()}\n\nOriginal prompt:\n\n${prompt.trim()}`;
        const child = require('child_process').spawn('git', ['commit', '-a', '-m', commitMessage], { stdio: 'inherit' });
        child.on('exit', (code) => {
            if (code !== 0) {
                console.error(`Git commit failed with exit code ${code}`);
            }
        });
    } catch (err) {
        console.error(`Error creating git commit: ${err}`);
    }
}

async function main() {
    const { key, url, model, command, files } = parseArgs(process.argv.slice(2));

    if (!command) {
        console.log(help);
        return;
    }

    if (!key) {
        console.error('Please set OPENROUTER_API_KEY environment variable or provide --key option');
        return;
    }

    const prompt = getPrompt(files);

    try {
        if (command === 'ask') {
            const response = await askLLM(key, url, model, prompt);
            console.log(response);
        } else if (command === 'commit') {
            await gitCommit(files, prompt);
        } else {
            console.error(`Unknown command: ${command}`);
        }
    } catch (err) {
        console.error(`Error: ${err}`);
    }
}

const systemPrompt = `${fs.readFileSync(__dirname + '/system_prompt.txt', 'utf8')}`;

main().catch(err => {
    console.error(err);
    process.exit(1);
});
