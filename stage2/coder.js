#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');
const readline = require('readline');
const { spawn } = require('child_process');
const debug = require('debug')('ai-coder');

const API_KEY = process.env.OPENROUTER_API_KEY;
const API_URL = process.env.OPENROUTER_API_URL || 'https://openrouter.ai/api/v1/chat/completions';
const MODEL_NAME = process.env.OPENROUTER_MODEL_NAME || 'anthropic/claude-3.5-sonnet';

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
    cyan: '\x1b[36m'
};

const SYSTEM_PROMPT = `You are an expert developer. You will help modify code files.
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

const USER_PROMPT_TEMPLATE = `Request: {{USER_REQUEST}}

Current files:

{{FILES}}

Respond with clear explanation and complete file contents.`;

let currentFiles = new Set();
let conversationHistory = [];

const displayHelpAndExit = () => {
    console.log(`
ai-coder [options] <command>
  -k, --key <key>            API key (default: $OPENROUTER_API_KEY)
  -u, --url <url>            API URL (default: ${API_URL})
  -m, --model <model_name>   LLM model name (default: ${MODEL_NAME})
  -h, --help                 Show this help

Commands:
    ask [file1] [file2] [fileN]     Ask about code (just show LLM response)
    commit [file1] [file2] [fileN]   Create git commit based on changes
    repl [file1] [file2] [fileN]     Start interactive REPL session

REPL Commands:
    /help                    Show this help
    /add <file>             Add file to context
    /drop <file>            Remove file from context
    /files                  List current files
    /commit                 Commit changes
    /run <command>          Execute shell command
    /clear                  Clear conversation history
    /quit                   Exit REPL
`);
    process.exit(0);
};

class REPLSession {
    constructor(options) {
        this.options = options;
        this.rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            prompt: `${colors.green}ai-coder>${colors.reset} `
        });
    }

    async start(initialFiles) {
        initialFiles.forEach(f => currentFiles.add(f));
        console.log(`${colors.bright}AI Coder REPL${colors.reset}\nType ${colors.cyan}/help${colors.reset} for commands\n`);
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
    }

    async handleCommand(cmd) {
        const [command, ...args] = cmd.slice(1).split(' ');
        
        switch (command) {
            case 'help':
                displayHelpAndExit();
                break;

            case 'add':
                if (args[0]) {
                    currentFiles.add(args[0]);
                    console.log(`${colors.green}Added file:${colors.reset} ${args[0]}`);
                }
                break;

            case 'drop':
                if (args[0] && currentFiles.has(args[0])) {
                    currentFiles.delete(args[0]);
                    console.log(`${colors.yellow}Removed file:${colors.reset} ${args[0]}`);
                }
                break;

            case 'files':
                console.log('\nCurrent files:');
                currentFiles.forEach(f => console.log(`  ${colors.cyan}${f}${colors.reset}`));
                console.log();
                break;

            case 'commit':
                await this.handleCommit();
                break;

            case 'run':
                if (args.length > 0) {
                    const cmd = args.join(' ');
                    await this.executeCommand(cmd);
                }
                break;

            case 'clear':
                conversationHistory = [];
                console.log(`${colors.yellow}Conversation history cleared${colors.reset}`);
                break;

            case 'quit':
                process.exit(0);
                break;

            default:
                console.log(`${colors.red}Unknown command:${colors.reset} ${command}`);
        }
        this.rl.prompt();
    }

    async executeCommand(cmd) {
        return new Promise((resolve) => {
            const proc = spawn(cmd, [], { shell: true });
            let output = '';

            proc.stdout.on('data', (data) => {
                output += data;
                process.stdout.write(data);
            });

            proc.stderr.on('data', (data) => {
                output += data;
                process.stderr.write(data);
            });

            proc.on('close', () => {
                conversationHistory.push({
                    role: 'system',
                    content: `Executed command: ${cmd}\nOutput:\n${output}`
                });
                resolve();
            });
        });
    }

    async handleQuery(query) {
        try {
            let controller = new AbortController();
            process.on('SIGINT', () => {
                controller.abort();
                console.log('\nRequest aborted');
                this.rl.prompt();
            });

            const fileContents = Array.from(currentFiles).map(file => {
                try {
                    const content = fs.readFileSync(file, 'utf8');
                    return `${file}\n\`\`\`\n${content}\n\`\`\`\n`;
                } catch (err) {
                    console.error(`${colors.red}Error reading file ${file}:${colors.reset} ${err.message}`);
                    return '';
                }
            }).join('\n');

            const userPrompt = USER_PROMPT_TEMPLATE
                .replace('{{USER_REQUEST}}', query)
                .replace('{{FILES}}', fileContents);

            conversationHistory.push({ role: 'user', content: query });

            const messages = [
                { role: 'system', content: SYSTEM_PROMPT },
                ...conversationHistory
            ];

            const response = await this.streamLLMResponse(messages, controller.signal);
            conversationHistory.push({ role: 'assistant', content: response });
            
        } catch (err) {
            if (err.name === 'AbortError') {
                console.log('\nRequest aborted');
            } else {
                console.error(`${colors.red}Error:${colors.reset}`, err);
            }
        }
        this.rl.prompt();
    }

    async streamLLMResponse(messages, signal) {
        const requestData = {
            model: this.options.model,
            messages,
            stream: true
        };

        const options = {
            hostname: new URL(this.options.url).hostname,
            path: new URL(this.options.url).pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.options.key}`
            },
            signal
        };

        return new Promise((resolve, reject) => {
            let fullResponse = '';
            const req = https.request(options, (res) => {
                res.on('data', (chunk) => {
                    const lines = chunk.toString().split('\n');
                    for (const line of lines) {
                        if (line.trim() === '') continue;
                        if (line.includes('[DONE]')) continue;
                        
                        try {
                            const parsed = JSON.parse(line.replace(/^data: /, ''));
                            const content = parsed.choices[0]?.delta?.content || '';
                            process.stdout.write(content);
                            fullResponse += content;
                        } catch (e) {
                            debug('Error parsing chunk:', e);
                        }
                    }
                });

                res.on('end', () => resolve(fullResponse));
            });

            req.on('error', (error) => {
                if (error.name === 'AbortError') {
                    reject(error);
                } else {
                    console.error(`${colors.red}Network error:${colors.reset}`, error);
                    reject(error);
                }
            });

            req.write(JSON.stringify(requestData));
            req.end();
        });
    }

    async handleCommit() {
        const gitCmd = spawn('git', ['show', '--color=never']);
        let gitOutput = '';
        
        gitCmd.stdout.on('data', (data) => {
            gitOutput += data;
        });

        gitCmd.stderr.on('data', (data) => {
            console.error(`${colors.red}Git error:${colors.reset}`, data.toString());
        });

        gitCmd.on('close', async () => {
            const commitPrompt = `Please generate a clear and concise commit message for these changes:\n\n${gitOutput}`;
            
            try {
                const requestData = {
                    model: this.options.model,
                    messages: [
                        { role: 'system', content: 'Generate a clear git commit message for the given changes.' },
                        { role: 'user', content: commitPrompt }
                    ],
                    stream: false
                };

                const response = await this.makeRequest(requestData);
                const commitMsg = response.choices[0].message.content.trim();

                const gitCommit = spawn('git', ['commit', '-a', '-F', '-']);
                gitCommit.stdin.write(commitMsg);
                gitCommit.stdin.end();

                gitCommit.on('close', () => {
                    console.log(`${colors.green}Changes committed${colors.reset}`);
                    this.rl.prompt();
                });
            } catch (err) {
                console.error(`${colors.red}Error generating commit message:${colors.reset}`, err);
                this.rl.prompt();
            }
        });
    }

    async makeRequest(requestData) {
        const options = {
            hostname: new URL(this.options.url).hostname,
            path: new URL(this.options.url).pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.options.key}`
            }
        };

        return new Promise((resolve, reject) => {
            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch (err) {
                        reject(err);
                    }
                });
            });

            req.on('error', reject);
            req.write(JSON.stringify(requestData));
            req.end();
        });
    }
}

async function main() {
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
        console.error(`${colors.red}API key is required. Set OPENROUTER_API_KEY env variable or use --key option.${colors.reset}`);
        process.exit(1);
    }

    const command = parsedArgs._[0];
    const files = parsedArgs._.slice(1);

    if (command === 'repl') {
        const repl = new REPLSession(parsedArgs);
        await repl.start(files);
    } else {
        console.error(`${colors.red}Invalid command:${colors.reset} ${command}`);
        displayHelpAndExit();
    }
}

main().catch(err => {
    console.error(`${colors.red}Fatal error:${colors.reset}`, err);
    process.exit(1);
});