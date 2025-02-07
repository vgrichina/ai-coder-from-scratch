const fs = require('fs');
const https = require('https');
const readline = require('readline');
const util = require('util');
const child_process = require('child_process');
const debug = require('debug')('ai-coder');

const API_KEY = process.env.OPENROUTER_API_KEY;
if (!API_KEY) {
    console.error('Please set OPENROUTER_API_KEY environment variable');
    process.exit(1);
}

const API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'anthropic/claude-3.5-sonnet';

let fileContent = {};
let conversation = [];
let commitMessages = [];

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'ai-coder> '
});

rl.on('line', async (line) => {
    if (line.startsWith('/')) {
        await handleCommand(line);
    } else {
        await handleCoding(line);
    }
    rl.prompt();
});

async function handleCommand(line) {
    const [command, ...args] = line.slice(1).split(' ');
    switch (command) {
        case 'ask':
            const question = args.join(' ');
            await askQuestion(question);
            break;
        case 'add':
            const filename = args[0];
            await addFile(filename);
            break;
        case 'drop':
            const fileToRemove = args[0];
            await removeFile(fileToRemove);
            break;
        case 'commit':
            await commit();
            break;
        case 'undo':
            await undo();
            break;
        case 'run':
            const cmd = args.join(' ');
            await runCommand(cmd);
            break;
        case 'help':
            showHelp();
            break;
        default:
            console.log(`Unknown command: ${command}`);
    }
}

async function handleCoding(prompt) {
    const systemPrompt = fs.readFileSync(__dirname + '/system_prompt.txt', 'utf8');
    const userPrompt = `${prompt}\n\nFiles:\n${Object.entries(fileContent).map(([filename, content]) => `${filename}\n\`\`\`\n${content}\n\`\`\``).join('\n')}`;
    const messages = [
        { role: 'system', content: systemPrompt },
        ...conversation,
        { role: 'user', content: userPrompt }
    ];

    debug('>>> GPT\n', systemPrompt, '\n', userPrompt);

    try {
        const response = await makeAPIRequest(messages);
        const code = response.choices[0].message.content;
        debug('<<< GPT\n', code);

        const codeBlocks = extractCodeBlocks(code);
        for (const { filename, content } of codeBlocks) {
            fileContent[filename] = content;
            console.log(`${filename}\n\`\`\`\n${content}\n\`\`\``);
        }

        conversation.push({ role: 'user', content: userPrompt }, { role: 'assistant', content: code });
    } catch (err) {
        console.error('Error:', err);
    }
}

async function askQuestion(question) {
    const systemPrompt = fs.readFileSync(__dirname + '/system_prompt.txt', 'utf8');
    const userPrompt = `I have a question: ${question}`;
    const messages = [
        { role: 'system', content: systemPrompt },
        ...conversation,
        { role: 'user', content: userPrompt }
    ];

    debug('>>> GPT\n', systemPrompt, '\n', userPrompt);

    try {
        const response = await makeAPIRequest(messages);
        const answer = response.choices[0].message.content;
        debug('<<< GPT\n', answer);
        console.log(answer);
        conversation.push({ role: 'user', content: userPrompt }, { role: 'assistant', content: answer });
    } catch (err) {
        console.error('Error:', err);
    }
}

async function addFile(filename) {
    try {
        const content = fs.readFileSync(filename, 'utf8');
        fileContent[filename] = content;
        console.log(`Added ${filename}`);
    } catch (err) {
        console.error(`Error adding ${filename}:`, err);
    }
}

async function removeFile(filename) {
    try {
        delete fileContent[filename];
        console.log(`Removed ${filename}`);
    } catch (err) {
        console.error(`Error removing ${filename}:`, err);
    }
}

async function commit() {
    const commitMessage = `
${commitMessages.join('\n')}

Changes:
${Object.entries(fileContent).map(([filename, content]) => `- ${filename}: ${getDiffSummary(filename, content)}`).join('\n')}
`.trim();

    const gitignore = fs.existsSync('.gitignore') ? fs.readFileSync('.gitignore', 'utf8') : '';
    const filesToCommit = Object.keys(fileContent).filter(file => !gitignore.includes(file));

    if (filesToCommit.length === 0) {
        console.log('No changes to commit');
        return;
    }

    for (const file of filesToCommit) {
        fs.writeFileSync(file, fileContent[file]);
    }

    const gitCommit = util.promisify(child_process.exec);
    try {
        await gitCommit(`git add ${filesToCommit.join(' ')}`);
        await gitCommit(`git commit -m "${commitMessage.replace(/"/g, '\\"')}"`);
        console.log('Changes committed');
        commitMessages = [];
    } catch (err) {
        console.error('Error committing changes:', err);
    }
}

function getDiffSummary(filename, newContent) {
    try {
        const oldContent = fs.readFileSync(filename, 'utf8');
        const diff = require('diff').createPatch(filename, oldContent, newContent);
        const diffLines = diff.split('\n').slice(5, 10);
        return diffLines.join('\n');
    } catch (err) {
        return 'New file';
    }
}

async function undo() {
    const gitReset = util.promisify(child_process.exec);
    try {
        await gitReset('git reset --hard');
        console.log('Changes reverted');
        fileContent = {};
    } catch (err) {
        console.error('Error reverting changes:', err);
    }
}

async function runCommand(cmd) {
    const exec = util.promisify(child_process.exec);
    try {
        const { stdout, stderr } = await exec(cmd);
        console.log(stdout.trim());
        if (stderr) {
            console.error(stderr.trim());
        }
    } catch (err) {
        console.error('Error running command:', err);
    }
}

function showHelp() {
    const help = `
Commands:

    /ask <question>  Ask about code
    /add <file>      Add file to context
    /drop <file>     Remove file
    /commit          Create git commit
    /undo            Revert last change
    /run <cmd>       Execute shell command
    /help            Show this help

When no slash prefix, interpret as coding prompt
`;
    console.log(help);
}

async function makeAPIRequest(messages) {
    const requestData = {
        model: MODEL,
        messages,
        stream: false
    };

    const options = {
        hostname: 'openrouter.ai',
        path: '/api/v1/chat/completions',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${API_KEY}`
        }
    };

    return new Promise((resolve, reject) => {
        const req = https.request(options, res => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    const response = JSON.parse(data);
                    resolve(response);
                } catch (err) {
                    reject(err);
                }
            });
        });

        req.on('error', error => {
            reject(error);
        });

        req.write(JSON.stringify(requestData));
        req.end();
    });
}

function extractCodeBlocks(text) {
    const codeBlocks = [];
    const codeBlockRegex = /```(?:js|javascript)?\n([\s\S]*?)\n```\s*(?=\n|$)/g;
    let match;
    while ((match = codeBlockRegex.exec(text)) !== null) {
        const [_, content] = match;
        const filename = content.split('\n')[0].trim();
        codeBlocks.push({ filename, content: content.split('\n').slice(1).join('\n').trim() });
    }
    return codeBlocks;
}

console.log('Interactive coding assistant started');
rl.prompt();
