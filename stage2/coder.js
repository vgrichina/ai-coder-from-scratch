#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');
const debug = require('debug')('ai-coder');
const readline = require('readline');

const API_KEY = process.env.OPENROUTER_API_KEY;
const API_URL = process.env.OPENROUTER_API_URL || 'https://openrouter.ai/api/v1/chat/completions';
const MODEL_NAME = process.env.OPENROUTER_MODEL_NAME || 'anthropic/claude-3.5-sonnet';

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

// ANSI color codes
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m'
};

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
    repl [file1] [file2] [fileN]            Start interactive REPL session with file context.

Commands in REPL mode:
    /help                    Show this help
    /add <file>             Add file to context
    /drop <file>            Remove file from context
    /files                  List current files in context
    /commit                 Commit changes to files
    /run <command>          Execute shell command
    /exit                   Exit REPL
`);
    process.exit(0);
};

class LLMClient {
    constructor(apiKey, apiUrl, model) {
        this.apiKey = apiKey;
        this.apiUrl = apiUrl;
        this.model = model;
        this.currentRequest = null;
    }

    async makeRequest(messages, onChunk) {
        const options = {
            hostname: new URL(this.apiUrl).hostname,
            path: new URL(this.apiUrl).pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`
            }
        };

        return new Promise((resolve, reject) => {
            let response = '';
            
            this.currentRequest = https.request(options, res => {
                res.on('data', chunk => {
                    const lines = chunk.toString().split('\n').filter(line => line.trim());
                    for (const line of lines) {
                        if (line.includes('[DONE]')) continue;
                        if (!line.startsWith('data: ')) continue;
                        
                        try {
                            const data = JSON.parse(line.slice(6));
                            const content = data.choices[0].delta.content;
                            if (content) {
                                response += content;
                                onChunk?.(content);
                            }
                        } catch (err) {
                            debug('Error parsing chunk:', err);
                        }
                    }
                });

                res.on('end', () => {
                    this.currentRequest = null;
                    resolve(response);
                });
            });

            this.currentRequest.on('error', error => {
                this.currentRequest = null;
                reject(error);
            });

            const requestData = {
                model: this.model,
                messages,
                stream: true
            };

            this.currentRequest.write(JSON.stringify(requestData));
            this.currentRequest.end();
        });
    }

    abort() {
        if (this.currentRequest) {
            this.currentRequest.destroy();
            this.currentRequest = null;
        }
    }
}

class REPLSession {
    constructor(llmClient) {
        this.llmClient = llmClient;
        this.files = new Set();
        this.history = [];
        this.rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            prompt: `${colors.green}ai-coder>${colors.reset} `
        });
    }

    async start(initialFiles) {
        initialFiles.forEach(f => this.files.add(f));
        
        console.log(`${colors.cyan}AI Coder REPL started. Type /help for commands.${colors.reset}\n`);
        
        this.rl.prompt();

        this.rl.on('line', async (line) => {
            line = line.trim();
            if (!line) {
                this.rl.prompt();
                return;
            }

            if (line.startsWith('/')) {
                await this.handleCommand(line);
            } else {
                await this.handleQuery(line);
            }
        });

        // Handle Ctrl+C
        this.rl.on('SIGINT', () => {
            this.llmClient.abort();
            console.log('\nRequest aborted');
            this.rl.prompt();
        });
    }

    async handleCommand(cmd) {
        const parts = cmd.split(' ');
        const command = parts[0];
        const args = parts.slice(1);

        switch (command) {
            case '/help':
                displayHelpAndExit();
                break;

            case '/add':
                if (args.length === 0) {
                    console.log(`${colors.red}Error: File name required${colors.reset}`);
                } else {
                    args.forEach(file => this.files.add(file));
                    console.log(`${colors.green}Added files: ${args.join(', ')}${colors.reset}`);
                }
                break;

            case '/drop':
                if (args.length === 0) {
                    console.log(`${colors.red}Error: File name required${colors.reset}`);
                } else {
                    args.forEach(file => this.files.delete(file));
                    console.log(`${colors.green}Removed files: ${args.join(', ')}${colors.reset}`);
                }
                break;

            case '/files':
                console.log(`${colors.cyan}Current files:${colors.reset}`);
                for (const file of this.files) {
                    console.log(`  ${file}`);
                }
                break;

            case '/run':
                if (args.length === 0) {
                    console.log(`${colors.red}Error: Command required${colors.reset}`);
                } else {
                    const cmd = args.join(' ');
                    try {
                        const { stdout, stderr } = await require('util').promisify(require('child_process').exec)(cmd);
                        const output = stdout + stderr;
                        console.log(output);
                        this.history.push(`Command: ${cmd}\nOutput: ${output}`);
                    } catch (err) {
                        console.error(`${colors.red}Error executing command:${colors.reset}`, err);
                    }
                }
                break;

            case '/commit':
                await this.commitChanges();
                break;

            case '/exit':
                console.log('Goodbye!');
                process.exit(0);
                break;

            default:
                console.log(`${colors.red}Unknown command: ${command}${colors.reset}`);
        }

        this.rl.prompt();
    }

    async handleQuery(query) {
        const fileContents = Array.from(this.files).map(file => {
            try {
                const content = fs.readFileSync(file, 'utf8');
                return `${file}\n\`\`\`\n${content}\n\`\`\`\n`;
            } catch (err) {
                console.error(`${colors.red}Error reading file ${file}: ${err.message}${colors.reset}`);
                return '';
            }
        }).join('\n');

        const historyContext = this.history.length > 0 ? 
            '\nPrevious conversation:\n' + this.history.join('\n') : '';

        const messages = [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: `${query}\n\nFiles:\n${fileContents}${historyContext}` }
        ];

        try {
            const response = await this.llmClient.makeRequest(messages, 
                chunk => process.stdout.write(chunk));
            
            this.history.push(`User: ${query}\nAssistant: ${response}`);
            console.log('\n');
        } catch (err) {
            console.error(`${colors.red}Error:${colors.reset}`, err);
        }

        this.rl.prompt();
    }

    async commitChanges() {
        // Get git diff
        const { stdout: diff } = await require('util').promisify(require('child_process').exec)('git diff HEAD');
        
        const messages = [
            { role: 'system', content: 'Generate a concise git commit message for these changes.' },
            { role: 'user', content: `Changes:\n${diff}` }
        ];

        try {
            const commitMsg = await this.llmClient.makeRequest(messages);
            
            // Add files first
            await require('util').promisify(require('child_process').exec)('git add .');
            
            // Create commit
            const gitProcess = spawn('git', ['commit', '-F', '-']);
            gitProcess.stdin.write(commitMsg);
            gitProcess.stdin.end();

            console.log(`${colors.green}Changes committed${colors.reset}`);
        } catch (err) {
            console.error(`${colors.red}Error committing changes:${colors.reset}`, err);
        }
    }
}

// Main
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

const llmClient = new LLMClient(parsedArgs.key, parsedArgs.url, parsedArgs.model);

if (command === 'repl') {
    const repl = new REPLSession(llmClient);
    repl.start(files);
} else if (!['ask', 'commit'].includes(command)) {
    console.error(`Invalid command: ${command}`);
    displayHelpAndExit();
} else {
    // Handle non-interactive commands
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

        const messages = [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: `${userInput.trim()}\n\nFiles:\n${fileContents}` }
        ];

        try {
            const response = await llmClient.makeRequest(messages, 
                chunk => process.stdout.write(chunk));

            if (command === 'commit') {
                // Parse and apply file changes
                const fileChanges = response.split(/\n(?=[\w-]+\.[a-zA-Z]+\n```)/);
                for (const change of fileChanges) {
                    const match = change.match(/^([\w-]+\.[a-zA-Z]+)\n```[^\n]*\n([\s\S]*?)\n```/);
                    if (match) {
                        const [, filename, content] = match;
                        fs.writeFileSync(filename, content);
                        await require('util').promisify(require('child_process').exec)(`git add "${filename}"`);
                    }
                }

                // Generate and apply commit message
                const { stdout: diff } = await require('util').promisify(require('child_process').exec)('git diff --cached');
                const commitMessages = [
                    { role: 'system', content: 'Generate a concise git commit message for these changes.' },
                    { role: 'user', content: `Original request: ${userInput.trim()}\n\nChanges:\n${diff}` }
                ];
                
                const commitMsg = await llmClient.makeRequest(commitMessages);
                const gitProcess = spawn('git', ['commit', '-F', '-']);
                gitProcess.stdin.write(commitMsg);
                gitProcess.stdin.end();
            }
        } catch (err) {
            console.error('Error:', err);
            process.exit(1);
        }
    });
}