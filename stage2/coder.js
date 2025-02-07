#!/usr/bin/env node

const fs = require('fs');
const https = require('https');
const { spawn } = require('child_process');
const debug = require('debug')('ai-coder');
const readline = require('readline');

const API_KEY = process.env.OPENROUTER_API_KEY;
const API_URL = process.env.OPENROUTER_API_URL || 'https://openrouter.ai/api/v1/chat/completions';
const MODEL_NAME = process.env.OPENROUTER_MODEL_NAME || 'anthropic/claude-3.5-sonnet';

// Embedded prompts
const SYSTEM_PROMPT = `Act as an expert developer. You will help modify code files.
When editing files, always show the complete file content like this:

filename.py
\`\`\`
def hello():
    print("hello world")
\`\`\`

Rules:
- Show the filename alone on a line
- Show complete file content between \`\`\` marks
- Never use ... or partial files
- Ask questions if the request is unclear`;

const USER_PROMPT = `Request: {{USER_REQUEST}}

Files to modify:

{{FILES}}`;

const displayHelpAndExit = () => {
    console.log(`
ai-coder [options] <command>
  -k, --key <key>            API key (default: $OPENROUTER_API_KEY)
  -u, --url <url>            API URL (default: ${API_URL})
  -m, --model <model_name>   LLM model name (default: ${MODEL_NAME})
  -h, --help                 Show this help

Commands:
    ask [file1] [file2] [fileN]             Ask about code (just show LLM response)
    commit [file1] [file2] [fileN]          Create git commit based on changes
    repl [file1] [file2] [fileN]           Interactive REPL mode

REPL Commands:
    /add <file>     Add file to context
    /drop <file>    Remove file from context
    /files          List current files
    /commit         Commit changes
    /quit           Exit REPL
    /help           Show this help
`);
    process.exit(0);
};

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

if (parsedArgs.help || process.argv.length < 3) {
    displayHelpAndExit();
}

if (!parsedArgs.key) {
    console.error('API key is required. Set OPENROUTER_API_KEY env variable or use --key option.');
    process.exit(1);
}

const command = parsedArgs._[0];
let files = parsedArgs._.slice(1);

if (!['ask', 'commit', 'repl'].includes(command)) {
    console.error(`Invalid command: ${command}`);
    displayHelpAndExit();
}

class Conversation {
    constructor() {
        this.history = [];
    }

    addMessage(role, content) {
        this.history.push({ role, content });
    }

    getMessages() {
        return [
            { role: 'system', content: SYSTEM_PROMPT },
            ...this.history
        ];
    }
}

async function makeRequest(conversation, stream = false) {
    const requestData = {
        model: parsedArgs.model,
        messages: conversation.getMessages(),
        stream
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

    return new Promise((resolve, reject) => {
        const req = https.request(options, res => {
            if (stream) {
                resolve(res);
            } else {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch (err) {
                        reject(err);
                    }
                });
            }
        });

        req.on('error', reject);
        req.write(JSON.stringify(requestData));
        req.end();
    });
}

async function generateCommitMessage(files, userInput) {
    const gitShow = spawn('git', ['show', '--color=never']);
    let gitDiff = '';
    
    gitShow.stdout.on('data', data => {
        gitDiff += data;
    });

    await new Promise(resolve => gitShow.on('close', resolve));

    const conversation = new Conversation();
    conversation.addMessage('user', `Generate a concise commit message for these changes:

${gitDiff}

Original request: ${userInput}`);

    const response = await makeRequest(conversation);
    return response.choices[0].message.content.trim();
}

async function processFiles(code) {
    const fileMatches = code.matchAll(/^([^\n]+)\n```[^\n]*\n([\s\S]*?)\n```/gm);
    
    for (const match of fileMatches) {
        const [_, filename, content] = match;
        console.log(`Writing ${filename}...`);
        await fs.promises.writeFile(filename, content);
    }
}

async function handleCommit(userInput, files) {
    const fileContents = await Promise.all(files.map(async file => {
        try {
            const content = await fs.promises.readFile(file, 'utf8');
            return `${file}\n\`\`\`\n${content}\n\`\`\`\n`;
        } catch (err) {
            if (err.code === 'ENOENT') {
                return `${file} (new file)\n\`\`\`\n\`\`\`\n`;
            }
            throw err;
        }
    }));

    const conversation = new Conversation();
    const userPrompt = USER_PROMPT
        .replace('{{USER_REQUEST}}', userInput.trim())
        .replace('{{FILES}}', fileContents.join('\n'));
    
    conversation.addMessage('user', userPrompt);
    
    const response = await makeRequest(conversation);
    const code = response.choices[0].message.content;
    
    await processFiles(code);
    
    const commitMessage = await generateCommitMessage(files, userInput);
    
    const gitCommit = spawn('git', ['commit', '-a', '-F', '-']);
    gitCommit.stdin.write(commitMessage);
    gitCommit.stdin.end();
}

async function startRepl(initialFiles) {
    const conversation = new Conversation();
    let currentFiles = new Set(initialFiles);
    
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: 'ai-coder> '
    });

    const showHelp = () => {
        console.log(`
REPL Commands:
    /add <file>     Add file to context
    /drop <file>    Remove file from context
    /files          List current files
    /commit         Commit changes
    /quit           Exit REPL
    /help           Show this help
`);
    };

    rl.on('line', async (line) => {
        line = line.trim();
        
        if (line.startsWith('/')) {
            const [cmd, ...args] = line.slice(1).split(' ');
            
            switch (cmd) {
                case 'help':
                    showHelp();
                    break;
                    
                case 'add':
                    if (args[0]) {
                        currentFiles.add(args[0]);
                        console.log(`Added ${args[0]} to context`);
                    }
                    break;
                    
                case 'drop':
                    if (args[0] && currentFiles.has(args[0])) {
                        currentFiles.delete(args[0]);
                        console.log(`Removed ${args[0]} from context`);
                    }
                    break;
                    
                case 'files':
                    console.log('Current files:', [...currentFiles].join(', '));
                    break;
                    
                case 'commit':
                    await handleCommit(line, [...currentFiles]);
                    break;
                    
                case 'quit':
                    rl.close();
                    return;
                    
                default:
                    console.log('Unknown command. Type /help for available commands.');
            }
        } else if (line) {
            // Regular input - send to LLM
            const fileContents = await Promise.all([...currentFiles].map(async file => {
                try {
                    const content = await fs.promises.readFile(file, 'utf8');
                    return `${file}\n\`\`\`\n${content}\n\`\`\`\n`;
                } catch (err) {
                    console.error(`Error reading ${file}:`, err);
                    return '';
                }
            }));

            const userPrompt = USER_PROMPT
                .replace('{{USER_REQUEST}}', line)
                .replace('{{FILES}}', fileContents.join('\n'));
            
            conversation.addMessage('user', userPrompt);
            
            try {
                const stream = await makeRequest(conversation, true);
                
                stream.on('data', chunk => {
                    try {
                        const lines = chunk.toString().split('\n');
                        for (const line of lines) {
                            if (line.trim().startsWith('data: ')) {
                                const data = JSON.parse(line.slice(6));
                                if (data.choices[0].delta.content) {
                                    process.stdout.write(data.choices[0].delta.content);
                                }
                            }
                        }
                    } catch (err) {
                        // Ignore parsing errors for incomplete chunks
                    }
                });

                await new Promise(resolve => stream.on('end', resolve));
                console.log('\n');
            } catch (err) {
                console.error('Error:', err);
            }
        }
        
        rl.prompt();
    }).on('close', () => {
        console.log('Goodbye!');
        process.exit(0);
    });

    console.log('Welcome to ai-coder REPL! Type /help for available commands.');
    rl.prompt();
}

if (command === 'repl') {
    startRepl(files);
} else {
    let userInput = '';
    process.stdin.on('data', chunk => {
        userInput += chunk;
    });

    process.stdin.on('end', async () => {
        try {
            if (command === 'commit') {
                await handleCommit(userInput, files);
            } else if (command === 'ask') {
                const fileContents = await Promise.all(files.map(async file => {
                    const content = await fs.promises.readFile(file, 'utf8');
                    return `${file}\n\`\`\`\n${content}\n\`\`\`\n`;
                }));

                const conversation = new Conversation();
                const userPrompt = USER_PROMPT
                    .replace('{{USER_REQUEST}}', userInput.trim())
                    .replace('{{FILES}}', fileContents.join('\n'));
                
                conversation.addMessage('user', userPrompt);
                
                const stream = await makeRequest(conversation, true);
                
                stream.on('data', chunk => {
                    try {
                        const lines = chunk.toString().split('\n');
                        for (const line of lines) {
                            if (line.trim().startsWith('data: ')) {
                                const data = JSON.parse(line.slice(6));
                                if (data.choices[0].delta.content) {
                                    process.stdout.write(data.choices[0].delta.content);
                                }
                            }
                        }
                    } catch (err) {
                        // Ignore parsing errors for incomplete chunks
                    }
                });

                await new Promise(resolve => stream.on('end', resolve));
                console.log('\n');
            }
        } catch (err) {
            console.error('Error:', err);
            process.exit(1);
        }
    });
}