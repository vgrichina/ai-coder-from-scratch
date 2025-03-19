#!/usr/bin/env node

let fs = require('fs');
let path = require('path');
let { spawnSync } = require('child_process');
let https = require('https');
let debug = require('debug')('ai-coder');
let readline = require('readline');

// Parse command line arguments
let args = process.argv.slice(2);
let options = {
  key: process.env.OPENROUTER_API_KEY,
  url: 'https://openrouter.ai/api/v1/chat/completions',
  model: 'anthropic/claude-3.5-sonnet'
};

// Function to display help
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

// Parse command line options
let command = null;
let files = [];

for (let i = 0; i < args.length; i++) {
  let arg = args[i];
  
  if (arg === '-h' || arg === '--help') {
    showHelp();
    process.exit(0);
  } else if (arg === '-k' || arg === '--key') {
    options.key = args[++i];
  } else if (arg === '-u' || arg === '--url') {
    options.url = args[++i];
  } else if (arg === '-m' || arg === '--model') {
    options.model = args[++i];
  } else if (!command && ['ask', 'commit'].includes(arg)) {
    command = arg;
  } else {
    files.push(arg);
  }
}

// If no command is provided, show help
if (!command) {
  showHelp();
  process.exit(0);
}

// Validate API key
if (!options.key) {
  console.error('Error: No API key provided. Set OPENROUTER_API_KEY environment variable or use --key option');
  process.exit(1);
}

// Read user input from stdin
let userInput = '';
let rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Handle input line by line
let lines = [];
rl.on('line', (line) => {
  lines.push(line);
});

rl.on('close', async () => {
  userInput = lines.join('\n');
  
  try {
    if (command === 'ask') {
      await handleAskCommand(userInput, files, options);
    } else if (command === 'commit') {
      await handleCommitCommand(userInput, files, options);
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
    debug('Stack trace:', error.stack);
    process.exit(1);
  }
});

// Read file contents and prepare file context
async function getFilesContext(files) {
  let filesContext = '';
  
  for (let file of files) {
    try {
      if (fs.existsSync(file)) {
        let content = fs.readFileSync(file, 'utf8');
        filesContext += `${file}\n\`\`\`\n${content}\n\`\`\`\n\n`;
      } else {
        console.error(`Warning: File not found: ${file}`);
      }
    } catch (error) {
      debug(`Error reading file ${file}:`, error);
      throw new Error(`Failed to read file ${file}: ${error.message}`);
    }
  }
  
  return filesContext;
}

// Make API request to LLM
async function callLLM(options, messages) {
  return new Promise((resolve, reject) => {
    let urlObj = new URL(options.url);
    
    debug('Sending request to LLM:', JSON.stringify(messages, null, 2));
    
    let requestData = JSON.stringify({
      model: options.model,
      messages: messages,
      stream: false
    });
    
    let apiRequest = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      port: urlObj.port || 443,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(requestData),
        'Authorization': `Bearer ${options.key}`
      }
    };
    
    let req = https.request(apiRequest, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        if (res.statusCode !== 200) {
          debug('Error response from API:', data);
          reject(new Error(`API request failed with status ${res.statusCode}: ${data}`));
          return;
        }
        
        try {
          let response = JSON.parse(data);
          debug('Received response from LLM:', JSON.stringify(response, null, 2));
          resolve(response);
        } catch (error) {
          debug('Error parsing response:', error);
          reject(new Error(`Failed to parse LLM response: ${error.message}`));
        }
      });
    });
    
    req.on('error', (error) => {
      debug('Request error:', error);
      reject(new Error(`API request failed: ${error.message}`));
    });
    
    req.write(requestData);
    req.end();
  });
}

// Handle the ask command
async function handleAskCommand(prompt, files, options) {
  // Load prompt templates
  let systemPrompt = fs.readFileSync(path.join(__dirname, 'system_prompt.txt'), 'utf8');
  let userPromptTemplate = fs.readFileSync(path.join(__dirname, 'ask_prompt.txt'), 'utf8');
  
  // Get file contents
  let filesContext = await getFilesContext(files);
  
  // Prepare messages
  let userPrompt = userPromptTemplate
    .replace('{{USER_REQUEST}}', prompt)
    .replace('{{FILES}}', filesContext);
  
  let messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ];
  
  // Make API request
  let response = await callLLM(options, messages);
  
  // Display the response
  console.log(response.choices[0].message.content);
}

// Handle the commit command
async function handleCommitCommand(prompt, files, options) {
  // First, generate code changes
  let systemPrompt = fs.readFileSync(path.join(__dirname, 'system_prompt.txt'), 'utf8');
  let userPromptTemplate = fs.readFileSync(path.join(__dirname, 'commit_prompt.txt'), 'utf8');
  
  // Get file contents
  let filesContext = await getFilesContext(files);
  
  // Prepare messages for code changes
  let userPrompt = userPromptTemplate
    .replace('{{USER_REQUEST}}', prompt)
    .replace('{{FILES}}', filesContext);
  
  let messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ];
  
  // Get code changes
  let response = await callLLM(options, messages);
  let content = response.choices[0].message.content;
  
  // Extract file changes
  let fileRegex = /^(.+?)\n```\n([\s\S]+?)\n```/gm;
  let match;
  let fileChanges = [];
  
  while ((match = fileRegex.exec(content)) !== null) {
    fileChanges.push({
      filename: match[1].trim(),
      content: match[2]
    });
  }
  
  // Apply file changes
  for (let change of fileChanges) {
    try {
      debug(`Writing file: ${change.filename}`);
      fs.writeFileSync(change.filename, change.content, 'utf8');
      console.log(`Updated: ${change.filename}`);
    } catch (error) {
      debug(`Error writing file ${change.filename}:`, error);
      throw new Error(`Failed to update file ${change.filename}: ${error.message}`);
    }
  }
  
  // Generate commit message
  let summaryPromptTemplate = fs.readFileSync(path.join(__dirname, 'summary_prompt.txt'), 'utf8');
  let summaryPrompt = summaryPromptTemplate
    .replace('{{USER_REQUEST}}', prompt)
    .replace('{{FILES}}', filesContext);
  
  let summaryMessages = [
    { role: 'system', content: "You are a helpful assistant that creates concise git commit messages." },
    { role: 'user', content: summaryPrompt }
  ];
  
  let summaryResponse = await callLLM(options, summaryMessages);
  let summary = summaryResponse.choices[0].message.content.trim();
  
  // Format full commit message
  let commitMessage = `${summary}\n\nOriginal prompt:\n\n${prompt}`;
  
  // Commit the changes
  try {
    let gitResult = spawnSync('git', ['commit', '-a', '-F', '-'], {
      input: commitMessage,
      encoding: 'utf8'
    });
    
    if (gitResult.status === 0) {
      console.log('Successfully committed changes');
    } else {
      console.error('Failed to commit changes:', gitResult.stderr);
    }
  } catch (error) {
    debug('Git error:', error);
    throw new Error(`Failed to execute git command: ${error.message}`);
  }
}
