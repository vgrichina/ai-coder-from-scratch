#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');
const readline = require('readline');
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
    cyan: '\x1b[36m',
};

class Coder {
    constructor(apiKey, apiUrl, model) {
        this.apiKey = apiKey;
        this.apiUrl = apiUrl;
        this.model = model;
        this.files = new Set();
        this.conversation = [];
        this.currentRequest = null;
        this.rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            prompt: `${colors.green}ai-coder>${colors.reset} `
        });
    }

    async start(initialFiles = []) {
        initialFiles.forEach(file => this.files.add(file));
        console.log(`${colors.cyan}AI Coder REPL${colors.reset}`);
        console.log('Type /help for available commands');
        
        this.rl.on('line', async (line) => {
            line = line.trim();
            if (!line) {
                this.rl.prompt();
                return;
            }

            try {
                if (line.startsWith('/')) {
                    await this.handleCommand(line);
                } else {
                    // Treat as chat with context
                    await this.chat(line);
                }
            } catch (error) {
                console.error(`${colors.red}Error:${colors.reset}`, error.message);
            }
            
            this.rl.prompt();
        });

        // Handle Ctrl+C during LLM response
        process.on('SIGINT', () => {
            if (this.currentRequest) {
                this.currentRequest.destroy();
                this.currentRequest = null;
                console.log('\nAborted current request');
                this.rl.prompt();
            } else {
                process.exit(0);
            }
        });

        this.rl.prompt();
    }

    async handleCommand(cmd) {
        const [command, ...args] = cmd.slice(1).split(' ');
        
        switch (command) {
            case 'help':
                console.log(`
Available commands:
    /help           - Show this help
    /files          - List current files in context
    /add <file>     - Add file to context
    /drop <file>    - Remove file from context
    /commit <prompt>- Generate and commit changes
    /run <command>  - Execute shell command
    /clear          - Clear conversation history
    /quit           - Exit REPL
                `);
                break;

            case 'files':
                console.log('Current files in context:');
                for (const file of this.files) {
                    console.log(`  ${file}`);
                }
                break;

            case 'add':
                if (!args[0]) {
                    console.log(`${colors.red}Error: File path required${colors.reset}`);
                    break;
                }
                try {
                    fs.accessSync(args[0], fs.constants.R_OK);
                    this.files.add(args[0]);
                    console.log(`Added ${args[0]} to context`);
                } catch (err) {
                    console.log(`${colors.red}Error: Cannot access file ${args[0]}${colors.reset}`);
                }
                break;

            case 'drop':
                if (this.files.delete(args[0])) {
                    console.log(`Removed ${args[0]} from context`);
                } else {
                    console.log(`${colors.red}File ${args[0]} was not in context${colors.reset}`);
                }
                break;

            case 'commit':
                if (args.length === 0) {
                    console.log(`${colors.red}Error: Commit message required${colors.reset}`);
                    break;
                }
                await this.handleCommit(args.join(' '));
                break;

            case 'run':
                if (args.length === 0) {
                    console.log(`${colors.red}Error: Command required${colors.reset}`);
                    break;
                }
                await this.runCommand(args.join(' '));
                break;

            case 'clear':
                this.conversation = [];
                console.log('Conversation history cleared');
                break;

            case 'quit':
                process.exit(0);
                break;

            default:
                console.log(`${colors.red}Unknown command: ${command}${colors.reset}`);
        }
    }

    async chat(message) {
        const fileContents = Array.from(this.files).map(file => {
            try {
                const content = fs.readFileSync(file, 'utf8');
                return `${file}\n\`\`\`\n${content}\n\`\`\`\n`;
            } catch (err) {
                return '';
            }
        }).join('\n');

        const systemPrompt = `You are an expert developer helping to understand and modify code. 
If you're asked to modify code, always show the complete file content with filename and content between \`\`\` marks.
Never use ... or partial files. Include filename alone on a line. Be concise in explanations.`;

        this.conversation.push({ role: 'user', content: message });

        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Context files:\n${fileContents}\n\nRequest: ${message}` },
            ...this.conversation
        ];

        await this.streamLLMResponse(messages);
    }

    async handleCommit(prompt) {
        // First, generate the changes
        const fileContents = Array.from(this.files).map(file => {
            try {
                const content = fs.readFileSync(file, 'utf8');
                return `${file}\n\`\`\`\n${content}\n\`\`\`\n`;
            } catch (err) {
                return '';
            }
        }).join('\n');

        const messages = [
            {
                role: 'system',
                content: `You are an expert developer. Generate code changes based on the request.
For each modified file, show the complete new content with filename on a line, followed by content between \`\`\` marks.
Start with a very brief one-line summary of changes.`
            },
            {
                role: 'user',
                content: `Context files:\n${fileContents}\n\nRequested changes: ${prompt}`
            }
        ];

        console.log(`${colors.cyan}Generating changes...${colors.reset}`);
        const response = await this.streamLLMResponse(messages);

        // Apply changes
        const files = new Set();
        let currentFile = null;
        let content = '';
        let isInCode = false;

        for (const line of response.split('\n')) {
            if (line.startsWith('```')) {
                if (isInCode) {
                    // End of code block
                    if (currentFile) {
                        fs.writeFileSync(currentFile, content.trimEnd());
                        files.add(currentFile);
                        content = '';
                    }
                }
                isInCode = !isInCode;
                continue;
            }

            if (isInCode) {
                content += line + '\n';
            } else if (line.trim() && !line.startsWith('```')) {
                currentFile = line.trim();
            }
        }

        // Git operations
        if (files.size > 0) {
            // Add changed files
            for (const file of files) {
                await this.runCommand(`git add "${file}"`);
            }

            // Get diff for commit message
            const diff = await new Promise((resolve) => {
                const git = spawn('git', ['diff', '--cached']);
                let output = '';
                git.stdout.on('data', (data) => output += data);
                git.stderr.on('data', (data) => console.error(data.toString()));
                git.on('close', () => resolve(output));
            });

            // Generate commit message
            const commitMessages = [
                {
                    role: 'system',
                    content: 'Generate a concise git commit message (title and description) based on the changes and original request.'
                },
                {
                    role: 'user',
                    content: `Original request: ${prompt}\n\nChanges:\n${diff}`
                }
            ];

            console.log(`${colors.cyan}Generating commit message...${colors.reset}`);
            const commitMessage = await this.streamLLMResponse(commitMessages);

            // Commit changes
            const gitCommit = spawn('git', ['commit', '-F', '-']);
            gitCommit.stdin.write(commitMessage);
            gitCommit.stdin.end();

            gitCommit.on('close', (code) => {
                if (code === 0) {
                    console.log(`${colors.green}Changes committed successfully${colors.reset}`);
                } else {
                    console.log(`${colors.red}Error committing changes${colors.reset}`);
                }
            });
        }
    }

    async runCommand(command) {
        return new Promise((resolve) => {
            const proc = spawn(command, [], { shell: true });
            
            proc.stdout.on('data', (data) => {
                process.stdout.write(data);
            });
            
            proc.stderr.on('data', (data) => {
                process.stderr.write(data);
            });
            
            proc.on('close', (code) => {
                this.conversation.push({
                    role: 'user',
                    content: `Executed command: ${command}\nExit code: ${code}`
                });
                resolve();
            });
        });
    }

    async streamLLMResponse(messages) {
        return new Promise((resolve, reject) => {
            const requestData = {
                model: this.model,
                messages: messages,
                stream: true
            };

            const options = {
                hostname: new URL(this.apiUrl).hostname,
                path: new URL(this.apiUrl).pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.apiKey}`
                }
            };

            let fullResponse = '';
            this.currentRequest = https.request(options, (res) => {
                res.on('data', (chunk) => {
                    const lines = chunk.toString().split('\n');
                    for (const line of lines) {
                        if (line.trim() === '') continue;
                        if (line.includes('[DONE]')) continue;
                        
                        try {
                            const parsed = JSON.parse(line.replace(/^data: /, ''));
                            const content = parsed.choices[0]?.delta?.content || '';
                            if (content) {
                                process.stdout.write(content);
                                fullResponse += content;
                            }
                        } catch (e) {
                            // Ignore parse errors from incomplete chunks
                        }
                    }
                });

                res.on('end', () => {
                    this.currentRequest = null;
                    this.conversation.push({ role: 'assistant', content: fullResponse });
                    console.log('\n');
                    resolve(fullResponse);
                });
            });

            this.currentRequest.on('error', (error) => {
                this.currentRequest = null;
                reject(error);
            });

            this.currentRequest.write(JSON.stringify(requestData));
            this.currentRequest.end();
        });
    }
}

// Main
if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(`
ai-coder [options] [file1] [file2] [fileN]
  -k, --key <key>            API key (default: $OPENROUTER_API_KEY)
  -u, --url <url>            API URL (default: ${API_URL})
  -m, --model <model_name>   LLM model name (default: ${MODEL_NAME})
  -h, --help                 Show this help

Start REPL with optional initial files in context.
    `);
    process.exit(0);
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

if (!parsedArgs.key) {
    console.error('API key is required. Set OPENROUTER_API_KEY env variable or use --key option.');
    process.exit(1);
}

const coder = new Coder(parsedArgs.key, parsedArgs.url, parsedArgs.model);
coder.start(parsedArgs._);