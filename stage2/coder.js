#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');
const { exec } = require('child_process');
const { URL } = require('url');
const readline = require('readline');
const debug = require('debug')('ai-coder');

// Default configurations
let API_KEY = process.env.OPENROUTER_API_KEY || '';
let API_URL = 'https://openrouter.ai/api/v1/chat/completions';
let MODEL = 'anthropic/claude-3.5-sonnet';

// Parse command line arguments
let args = process.argv.slice(2);
let command = null;
let files = [];

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightBlue: '\x1b[94m'
};

function showHelp() {
  console.log(`
ai-coder [options] <command>
  -k, --key <key>            API key (default: $OPENROUTER_API_KEY)
  -u, --url <url>            API URL (default: https://openrouter.ai/api/v1/chat/completions)
  -m, --model <model_name>   LLM model name (default: anthropic/claude-3.5-sonnet)
  -h, --help                 Show this help

Commands:
    ask [file1] [file2] [fileN]             Ask about code (just show LLM response). Files are provided to LLM as a context.
    commit [file1] [file2] [fileN]          Create git commit based on given prompt. Files are provided to LLM as a context and then edited.
    repl [file1] [file2] [fileN]            Start REPL session with file management and command execution.
`);
}

// Parse arguments
while (args.length > 0) {
  const arg = args.shift();
  
  if (arg === '-h' || arg === '--help') {
    showHelp();
    process.exit(0);
  } else if (arg === '-k' || arg === '--key') {
    API_KEY = args.shift() || '';
  } else if (arg === '-u' || arg === '--url') {
    API_URL = args.shift() || API_URL;
  } else if (arg === '-m' || arg === '--model') {
    MODEL = args.shift() || MODEL;
  } else if (!command) {
    command = arg;
  } else {
    files.push(arg);
  }
}

// Check if API key is provided
if (!API_KEY) {
  console.error('Error: API key is required. Set OPENROUTER_API_KEY environment variable or use --key option.');
  process.exit(1);
}

// If no command is provided, show help
if (!command) {
  showHelp();
  process.exit(0);
}

// Read files and format their content for the prompt
async function readFiles(fileList) {
  let content = '';
  
  for (let file of fileList) {
    try {
      if (fs.existsSync(file)) {
        let data = fs.readFileSync(file, 'utf8');
        content += `${file}\n\`\`\`\n${data}\n\`\`\`\n\n`;
      } else {
        console.error(`Warning: File not found: ${file}`);
      }
    } catch (error) {
      console.error(`Error reading file ${file}:`, error.message);
    }
  }
  
  return content.trim();
}

// System prompts
const SYSTEM_PROMPT_CODE = `
You are an expert software developer AI assistant. Your task is to help with coding questions and implement code changes.

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
- Ask questions if the request is unclear
`;

const SYSTEM_PROMPT_COMMIT = `
You are an expert software developer AI assistant. Your task is to implement code changes based on the user's request.

When creating or modifying files, always show the complete file content like this:

filename.py
\`\`\`
def hello():
    print("hello world")
\`\`\`

Rules:
- Show the filename alone on a line
- Show complete file content between \`\`\` marks
- Never use ... or partial files
- Ensure output format is exactly as shown above to enable automatic file updates
- If a file should be created, include it in the same format
- Ask questions if the request is unclear
`;

// Make streaming API request to the LLM
function streamLLM(messages, onData, onComplete, onError) {
  try {
    let currentRequest = null;
    let aborted = false;
    
    const requestData = {
      model: MODEL,
      messages: messages,
      stream: true
    };
    
    debug('Sending request to LLM API:', JSON.stringify(requestData, null, 2));
    
    // Parse API URL
    const parsedUrl = new URL(API_URL);
    
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`
      }
    };
    
    debug('API request options:', JSON.stringify(options));
    
    const req = https.request(options, (res) => {
      currentRequest = req;
      let accumulatedResponse = '';
      
      res.on('data', (chunk) => {
        if (aborted) return;
        
        const text = chunk.toString();
        
        // Handle stream chunks
        const lines = text.split('\n');
        for (const line of lines) {
          if (!line.trim() || line.includes('[DONE]')) continue;
          
          try {
            const jsonStr = line.replace(/^data: /, '').trim();
            if (!jsonStr) continue;
            
            const json = JSON.parse(jsonStr);
            const content = json.choices[0].delta?.content || '';
            if (content) {
              accumulatedResponse += content;
              onData(content);
            }
          } catch (e) {
            debug(`Error parsing stream chunk: ${e.message}, chunk: ${line}`);
          }
        }
      });
      
      res.on('end', () => {
        if (!aborted) {
          onComplete(accumulatedResponse);
        }
      });
      
      res.on('error', (error) => {
        if (!aborted) {
          onError(new Error(`Network error: ${error.message}`));
        }
      });
    });
    
    req.on('error', (error) => {
      if (!aborted) {
        onError(new Error(`Request error: ${error.message}`));
      }
    });
    
    req.write(JSON.stringify(requestData));
    req.end();
    
    // Return an abort function
    return () => {
      if (currentRequest && !aborted) {
        aborted = true;
        currentRequest.abort();
        debug('LLM request aborted');
      }
    };
  } catch (error) {
    onError(new Error(`Error setting up API request: ${error.message}`));
    return () => {}; // Return empty abort function
  }
}

// Non-streaming LLM call for commit messages
function callLLM(systemPrompt, userPrompt) {
  return new Promise((resolve, reject) => {
    try {
      const requestData = {
        model: MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        stream: false
      };
      
      debug('Sending request to LLM API:', JSON.stringify(requestData, null, 2));
      
      // Parse API URL
      const parsedUrl = new URL(API_URL);
      
      const options = {
        hostname: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'POST',
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${API_KEY}`
        }
      };
      
      debug('API request options:', JSON.stringify(options));
      
      const req = https.request(options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          try {
            debug('Response received from LLM API:', data);
            
            if (res.statusCode >= 200 && res.statusCode < 300) {
              const response = JSON.parse(data);
              const content = response.choices[0].message.content;
              resolve(content);
            } else {
              reject(new Error(`API request failed with status ${res.statusCode}: ${data}`));
            }
          } catch (error) {
            reject(new Error(`Failed to parse API response: ${error.message}`));
          }
        });
      });
      
      req.on('error', (error) => {
        reject(new Error(`Network error: ${error.message}`));
      });
      
      req.write(JSON.stringify(requestData));
      req.end();
      
    } catch (error) {
      reject(new Error(`Error setting up API request: ${error.message}`));
    }
  });
}

// Ask about code and display the response
async function askAboutCode(userPrompt) {
  try {
    let fullResponse = '';
    let isCancelled = false;
    
    // Setup interrupt handling
    const abortRequest = streamLLM(
      [
        { role: 'system', content: SYSTEM_PROMPT_CODE },
        { role: 'user', content: userPrompt }
      ],
      (chunk) => {
        process.stdout.write(chunk);
      },
      (response) => {
        fullResponse = response;
        console.log('\n');
      },
      (error) => {
        if (!isCancelled) {
          console.error('\nError:', error.message);
        }
      }
    );
    
    // Handle Ctrl+C
    const onSigInt = () => {
      isCancelled = true;
      abortRequest();
      console.log('\n\n[Request cancelled]');
      process.removeListener('SIGINT', onSigInt);
    };
    
    process.on('SIGINT', onSigInt);
    
    return fullResponse;
  } catch (error) {
    console.error('Error asking about code:', error.message);
    debug('Stack trace:', error.stack);
    return '';
  }
}

// Generate commit message from LLM response
async function generateCommitMessage(diff) {
  try {
    // System prompt for commit message generation
    let commitSystemPrompt = 'Generate a concise and descriptive git commit message based on the changes. Keep it under 50 characters.';
    
    const response = await callLLM(commitSystemPrompt, `Summarize these changes in a git commit message:\n\n${diff}`);
    return response.trim();
  } catch (error) {
    console.error('Error generating commit message:', error.message);
    return 'Changes from AI-coder';
  }
}

// Parse and update files from LLM response
function parseAndUpdateFiles(response) {
  const fileUpdates = [];
  
  // Regular expression to find files in the response
  const filePattern = /^([^\n]+?)\n```\n([\s\S]*?)\n```/gm;
  let match;
  
  while ((match = filePattern.exec(response)) !== null) {
    let filename = match[1].trim();
    let content = match[2];
    
    fileUpdates.push({ filename, content });
  }
  
  return fileUpdates;
}

// Create git commit based on LLM response
async function createCommit(userPrompt, originalPrompt) {
  try {
    let fullResponse = '';
    let isCancelled = false;
    
    console.log(`${colors.green}Generating changes...${colors.reset}`);
    
    // Setup interrupt handling
    const abortRequest = streamLLM(
      [
        { role: 'system', content: SYSTEM_PROMPT_COMMIT },
        { role: 'user', content: userPrompt }
      ],
      (chunk) => {
        process.stdout.write(chunk);
        fullResponse += chunk;
      },
      async (response) => {
        console.log('\n');
        
        // Parse file updates from response
        const fileUpdates = parseAndUpdateFiles(response);
        
        if (fileUpdates.length === 0) {
          console.error(`${colors.red}No valid file updates found in the response${colors.reset}`);
          return;
        }
        
        // Update files
        let changedFiles = [];
        for (let update of fileUpdates) {
          try {
            const fileExists = fs.existsSync(update.filename);
            let oldContent = '';
            
            if (fileExists) {
              oldContent = fs.readFileSync(update.filename, 'utf8');
            }
            
            if (!fileExists || oldContent !== update.content) {
              // Ensure the directory exists for the file
              const dir = path.dirname(update.filename);
              if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
              }
              
              fs.writeFileSync(update.filename, update.content, 'utf8');
              changedFiles.push(update.filename);
              console.log(`${colors.green}${fileExists ? 'Updated' : 'Created'} ${update.filename}${colors.reset}`);
            } else {
              console.log(`${colors.yellow}No changes to ${update.filename}${colors.reset}`);
            }
          } catch (error) {
            console.error(`${colors.red}Error processing ${update.filename}: ${error.message}${colors.reset}`);
          }
        }
        
        if (changedFiles.length === 0) {
          console.log(`${colors.yellow}No files were changed.${colors.reset}`);
          return;
        }
        
        // Get git diff
        const { stdout: diff } = await execPromise(`git diff HEAD ${changedFiles.join(' ')}`);
        
        // Add new files to git
        for (const file of changedFiles) {
          try {
            await execPromise(`git add "${file}"`);
          } catch (error) {
            console.error(`${colors.red}Error adding file to git: ${error.message}${colors.reset}`);
          }
        }
        
        // Generate commit message
        console.log(`${colors.gray}Generating commit message...${colors.reset}`);
        const summary = await generateCommitMessage(diff);
        
        // Format full commit message
        const commitMessage = `${summary}\n\nOriginal prompt:\n\n${originalPrompt}`;
        
        // Create git commit
        try {
          const { stdout, stderr } = await execPromise('git commit -F -', commitMessage);
          console.log(`${colors.green}Git commit created successfully:${colors.reset}`);
          console.log(stdout);
          if (stderr) console.error(stderr);
        } catch (error) {
          console.error(`${colors.red}Error creating git commit: ${error.message}${colors.reset}`);
        }
      },
      (error) => {
        if (!isCancelled) {
          console.error(`\n${colors.red}Error: ${error.message}${colors.reset}`);
        }
      }
    );
    
    // Handle Ctrl+C
    const onSigInt = () => {
      isCancelled = true;
      abortRequest();
      console.log(`\n\n${colors.red}[Request cancelled]${colors.reset}`);
      process.removeListener('SIGINT', onSigInt);
    };
    
    process.on('SIGINT', onSigInt);
    
    return fullResponse;
  } catch (error) {
    console.error(`${colors.red}Error creating commit: ${error.message}${colors.reset}`);
    debug('Stack trace:', error.stack);
    return '';
  }
}

// Execute commands as a promise
function execPromise(command, input = undefined) {
  return new Promise((resolve, reject) => {
    const proc = exec(command, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
    
    if (input !== undefined) {
      proc.stdin.write(input);
      proc.stdin.end();
    }
  });
}

const startReplSession = async (initialFiles) => {
  let activeFiles = [...initialFiles];
  const conversationHistory = [];
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${colors.brightGreen}ai-coder>${colors.reset} `,
    terminal: true
  });
  
  let isProcessing = false;
  
  const showFiles = () => {
    if (activeFiles.length === 0) {
      console.log(`${colors.yellow}No files in context${colors.reset}`);
    } else {
      console.log(`${colors.green}Files in context:${colors.reset}`);
      activeFiles.forEach((file, idx) => {
        console.log(`${colors.gray}${idx + 1}.${colors.reset} ${file}`);
      });
    }
  };
  
  const addFile = (filename) => {
    if (!filename) {
      console.log(`${colors.red}Please specify a file to add${colors.reset}`);
      return;
    }
    
    if (!fs.existsSync(filename)) {
      console.log(`${colors.red}File not found: ${filename}${colors.reset}`);
      return;
    }
    
    if (!activeFiles.includes(filename)) {
      activeFiles.push(filename);
      console.log(`${colors.green}Added ${filename} to context${colors.reset}`);
    } else {
      console.log(`${colors.yellow}${filename} is already in context${colors.reset}`);
    }
  };
  
  const dropFile = (arg) => {
    if (!arg) {
      console.log(`${colors.red}Please specify a file to drop${colors.reset}`);
      return;
    }
    
    // Check if arg is a number (index)
    if (/^\d+$/.test(arg)) {
      const idx = parseInt(arg) - 1;
      if (idx >= 0 && idx < activeFiles.length) {
        const removed = activeFiles.splice(idx, 1)[0];
        console.log(`${colors.green}Removed ${removed} from context${colors.reset}`);
      } else {
        console.log(`${colors.red}Invalid file index${colors.reset}`);
      }
    } else {
      // Treat as filename
      const idx = activeFiles.indexOf(arg);
      if (idx !== -1) {
        activeFiles.splice(idx, 1);
        console.log(`${colors.green}Removed ${arg} from context${colors.reset}`);
      } else {
        console.log(`${colors.red}File not in context: ${arg}${colors.reset}`);
      }
    }
  };
  
  const runCommand = async (cmd) => {
    if (!cmd) {
      console.log(`${colors.red}Please specify a command to run${colors.reset}`);
      return;
    }
    
    console.log(`${colors.gray}Running: ${cmd}${colors.reset}`);
    try {
      const { stdout, stderr } = await execPromise(cmd);
      
      console.log(`${colors.brightBlue}=== Command Output ===${colors.reset}`);
      if (stdout) console.log(stdout);
      if (stderr) console.error(`${colors.red}${stderr}${colors.reset}`);
      console.log(`${colors.brightBlue}=== End Output ===${colors.reset}`);
      
      // Add command and output to conversation history
      conversationHistory.push({ 
        role: 'user', 
        content: `I ran this command: \`${cmd}\`\n\nOutput:\n\`\`\`\n${stdout}${stderr ? '\nError: ' + stderr : ''}\n\`\`\`` 
      });
    } catch (error) {
      console.error(`${colors.red}Command failed: ${error.message}${colors.reset}`);
      conversationHistory.push({ 
        role: 'user', 
        content: `I ran this command: \`${cmd}\`\n\nThe command failed with error:\n\`\`\`\n${error.message}\n\`\`\`` 
      });
    }
  };
  
  const processMessage = async (prompt) => {
    try {
      // Prepare file contents
      let filesContent = '';
      if (activeFiles.length > 0) {
        filesContent = await readFiles(activeFiles);
      }
      
      // Construct user message
      let userMessage = prompt;
      if (filesContent) {
        userMessage += `\n\nCurrent files:\n${filesContent}`;
      }
      
      // Add user message to conversation history
      conversationHistory.push({ role: 'user', content: userMessage });
      
      // Prepare messages for LLM
      const messages = [
        { role: 'system', content: SYSTEM_PROMPT_CODE },
        ...conversationHistory
      ];
      
      // Make LLM request with streaming
      let fullResponse = '';
      let isCancelled = false;
      
      const abortRequest = streamLLM(
        messages,
        (chunk) => {
          process.stdout.write(chunk);
          fullResponse += chunk;
        },
        (response) => {
          console.log('\n');
          isProcessing = false;
          rl.prompt();
          
          // Add assistant response to conversation history
          conversationHistory.push({ role: 'assistant', content: response });
        },
        (error) => {
          if (!isCancelled) {
            console.error(`\n${colors.red}Error: ${error.message}${colors.reset}`);
          }
          isProcessing = false;
          rl.prompt();
        }
      );
      
      // Handle Ctrl+C
      const onSigInt = () => {
        if (isProcessing) {
          isCancelled = true;
          abortRequest();
          console.log(`\n\n${colors.red}[Request cancelled]${colors.reset}`);
          isProcessing = false;
          rl.prompt();
        } else {
          // If not processing, exit on Ctrl+C
          rl.close();
        }
      };
      
      process.once('SIGINT', onSigInt);
    } catch (error) {
      console.error(`${colors.red}Error processing message: ${error.message}${colors.reset}`);
      isProcessing = false;
      rl.prompt();
    }
  };
  
  const processCommit = async (prompt) => {
    try {
      // Prepare file contents
      let filesContent = '';
      if (activeFiles.length > 0) {
        filesContent = await readFiles(activeFiles);
      }
      
      // Construct user message
      let userMessage = `Make the following changes:\n${prompt}\n\n`;
      if (filesContent) {
        userMessage += `Current files:\n${filesContent}`;
      }
      
      // Create commit
      isProcessing = true;
      await createCommit(userMessage, prompt);
      
      // Add both request and imagined response to history
      conversationHistory.push({ role: 'user', content: `Please make the following code changes: ${prompt}` });
      conversationHistory.push({ 
        role: 'assistant', 
        content: `I've committed the changes you requested. Let me know if you need further adjustments.` 
      });
      
      isProcessing = false;
      rl.prompt();
    } catch (error) {
      console.error(`${colors.red}Error processing commit: ${error.message}${colors.reset}`);
      isProcessing = false;
      rl.prompt();
    }
  };
  
  // Show welcome message and initial files
  console.log(`${colors.brightBlue}Welcome to AI-Coder REPL${colors.reset}`);
  console.log(`${colors.gray}Commands: /commit <prompt>, /run <command>, /add <file>, /drop <file>, /files, /help, /exit${colors.reset}`);
  showFiles();
  
  rl.prompt();
  
  rl.on('line', async (line) => {
    if (isProcessing) {
      console.log(`${colors.yellow}Please wait for the current operation to complete...${colors.reset}`);
      return;
    }
    
    const input = line.trim();
    
    if (input === '/exit' || input === '/quit') {
      rl.close();
      return;
    }
    
    if (input === '/help') {
      console.log(`${colors.brightBlue}Available commands:${colors.reset}`);
      console.log(`  ${colors.cyan}/commit <prompt>${colors.reset} - Generate code changes and commit them`);
      console.log(`  ${colors.cyan}/run <command>${colors.reset} - Run a shell command and include output in conversation`);
      console.log(`  ${colors.cyan}/add <file>${colors.reset} - Add a file to context`);
      console.log(`  ${colors.cyan}/drop <file|index>${colors.reset} - Remove a file from context`);
      console.log(`  ${colors.cyan}/files${colors.reset} - Show files in context`);
      console.log(`  ${colors.cyan}/help${colors.reset} - Show this help message`);
      console.log(`  ${colors.cyan}/exit${colors.reset} or ${colors.cyan}/quit${colors.reset} - Exit REPL`);
      rl.prompt();
      return;
    }
    
    if (input === '/files') {
      showFiles();
      rl.prompt();
      return;
    }
    
    if (input.startsWith('/add ')) {
      addFile(input.substring(5).trim());
      rl.prompt();
      return;
    }
    
    if (input.startsWith('/drop ')) {
      dropFile(input.substring(6).trim());
      rl.prompt();
      return;
    }
    
    if (input.startsWith('/run ')) {
      const cmd = input.substring(5).trim();
      isProcessing = true;
      await runCommand(cmd);
      isProcessing = false;
      rl.prompt();
      return;
    }
    
    if (input.startsWith('/commit ')) {
      const prompt = input.substring(8).trim();
      if (!prompt) {
        console.log(`${colors.red}Please provide a prompt for the commit${colors.reset}`);
        rl.prompt();
        return;
      }
      
      isProcessing = true;
      await processCommit(prompt);
      return;
    }
    
    if (input === '') {
      rl.prompt();
      return;
    }
    
    // Process as regular message
    isProcessing = true;
    await processMessage(input);
  });
  
  rl.on('close', () => {
    console.log(`${colors.brightBlue}Goodbye!${colors.reset}`);
    process.exit(0);
  });
};

// Process standard commands
const processStandardCommand = async () => {
  if (command === 'repl') {
    await startReplSession(files);
    return;
  }
  
  // Read user input from stdin
  let userInput = '';
  process.stdin.on('data', chunk => {
    userInput += chunk;
  });
  
  process.stdin.on('end', async () => {
    try {
      userInput = userInput.trim();
      debug('User input received:', userInput);
      
      // Read file contents
      let filesContent = '';
      if (files.length > 0) {
        filesContent = await readFiles(files);
      }
      
      // Process the command
      if (command === 'ask') {
        // Construct user message
        let userMessage = userInput;
        if (filesContent) {
          userMessage += `\n\nCurrent files:\n${filesContent}`;
        }
        
        await askAboutCode(userMessage);
      } else if (command === 'commit') {
        // Construct user message for commit
        let userMessage = `Make the following changes:\n${userInput}\n\n`;
        if (filesContent) {
          userMessage += `Current files:\n${filesContent}`;
        }
        
        await createCommit(userMessage, userInput);
      } else {
        console.error(`Unknown command: ${command}`);
        showHelp();
        process.exit(1);
      }
    } catch (error) {
      console.error('Error:', error.message);
      debug('Stack trace:', error.stack);
      process.exit(1);
    }
  });
};

processStandardCommand();