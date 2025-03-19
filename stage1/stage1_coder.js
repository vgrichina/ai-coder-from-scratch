#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');
const { exec } = require('child_process');
const { URL } = require('url');
const debug = require('debug')('ai-coder');

// Default configurations
let API_KEY = process.env.OPENROUTER_API_KEY || '';
let API_URL = 'https://openrouter.ai/api/v1/chat/completions';
let MODEL = 'anthropic/claude-3.5-sonnet';

// Parse command line arguments
let args = process.argv.slice(2);
let command = null;
let files = [];

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

// Read user input from stdin
let userInput = '';
process.stdin.on('data', chunk => {
  userInput += chunk;
});

process.stdin.on('end', async () => {
  try {
    userInput = userInput.trim();
    debug('User input received:', userInput);
    
    // Load prompt templates
    let systemPrompt = fs.readFileSync(path.join(__dirname, 'system_prompt.txt'), 'utf8');
    let userPrompt = fs.readFileSync(path.join(__dirname, 'user_prompt.txt'), 'utf8');
    
    // Read file contents
    let filesContent = '';
    if (files.length > 0) {
      filesContent = await readFiles(files);
    }
    
    // Replace placeholders in user prompt
    userPrompt = userPrompt.replace('{{USER_REQUEST}}', userInput);
    userPrompt = userPrompt.replace('{{FILES}}', filesContent);
    
    // Process the command
    if (command === 'ask') {
      await askAboutCode(systemPrompt, userPrompt);
    } else if (command === 'commit') {
      await createCommit(systemPrompt, userPrompt, files, userInput);
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

// Make API request to the LLM
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
async function askAboutCode(systemPrompt, userPrompt) {
  try {
    const response = await callLLM(systemPrompt, userPrompt);
    console.log(response);
  } catch (error) {
    console.error('Error asking about code:', error.message);
    debug('Stack trace:', error.stack);
  }
}

// Generate commit message from LLM response
async function generateCommitMessage(userPrompt) {
  try {
    // Simple system prompt for commit message generation
    let commitSystemPrompt = 'Generate a concise and descriptive git commit message based on the changes described. Keep it under 50 characters.';
    
    const response = await callLLM(commitSystemPrompt, `Summarize these changes in a git commit message:\n${userPrompt}`);
    return response.trim();
  } catch (error) {
    console.error('Error generating commit message:', error.message);
    return 'Changes from AI-coder';
  }
}

// Parse and update files from LLM response
function parseAndUpdateFiles(response, files) {
  const fileUpdates = [];
  
  // Regular expression to find files in the response
  const filePattern = /(.*?)\n```\n([\s\S]*?)\n```/g;
  let match;
  
  while ((match = filePattern.exec(response)) !== null) {
    let filename = match[1].trim();
    let content = match[2];
    
    // Only update files that were provided in the input
    if (files.includes(filename)) {
      fileUpdates.push({ filename, content });
    } else {
      console.warn(`Warning: File ${filename} was not in the input list and will not be updated.`);
    }
  }
  
  return fileUpdates;
}

// Create git commit based on LLM response
async function createCommit(systemPrompt, userPrompt, files, originalPrompt) {
  try {
    // Get response from LLM
    const response = await callLLM(systemPrompt, userPrompt);
    console.log("LLM Response:");
    console.log(response);
    
    // Parse file updates from response
    const fileUpdates = parseAndUpdateFiles(response, files);
    
    if (fileUpdates.length === 0) {
      console.error('No valid file updates found in the response');
      return;
    }
    
    // Update files
    for (let update of fileUpdates) {
      fs.writeFileSync(update.filename, update.content, 'utf8');
      console.log(`Updated ${update.filename}`);
    }
    
    // Generate commit message
    const summary = await generateCommitMessage(originalPrompt);
    
    // Format full commit message
    const commitMessage = `${summary}\n\nOriginal prompt:\n\n${originalPrompt}`;
    
    // Create git commit
    exec('git commit -a -F -', (error, stdout, stderr) => {
      if (error) {
        console.error(`Error creating git commit: ${error.message}`);
        debug('Git error details:', stderr);
        return;
      }
      
      console.log('Git commit created successfully:');
      console.log(stdout);
    }).stdin.end(commitMessage);
    
  } catch (error) {
    console.error('Error creating commit:', error.message);
    debug('Stack trace:', error.stack);
  }
}
