const fs = require('fs');
const path = require('path');
const http = require('http');
const EventSource = require('eventsource');

const API_KEY = process.env.OPENROUTER_API_KEY || '';
const API_URL = 'https://openrouter.ai/api/v1/chat/completions';

let chatHistory = [];
let filesData = {};
let isInteractive = false;

function logError(err) {
  console.error(err);
}

function handleApiResponse(res) {
  let data = '';
  const stream = new EventSource(res.body);

  stream.onerror = (err) => {
    logError(err);
    stream.close();
  };

  stream.onmessage = (msg) => {
    const lines = msg.data.split('\n').slice(1, -1);
    for (const line of lines) {
      const token = line.slice(6);
      data += token;
      process.stdout.write(token);
    }
  };

  stream.onopen = () => {
    console.log('Received API response stream');
  };

  stream.onclose = () => {
    handleApiData(data);
    isInteractive = true;
    printPrompt();
  };
}

function handleApiData(data) {
  try {
    const resp = JSON.parse(data);
    const output = resp.output.trim();
    chatHistory.push({ role: 'user', content: resp.prompt });
    chatHistory.push({ role: 'assistant', content: output });

    if (output.startsWith('```')) {
      const filename = output.split('\n')[0].replace(/```/, '').trim();
      const content = output.split('```')[2];
      filesData[filename] = content;
    } else {
      const commitMessage = parseCommitMessage(output);
      if (commitMessage) {
        commitChanges(commitMessage);
      }
    }
  } catch (err) {
    logError(err);
  }
}

function parseCommitMessage(text) {
  const msgPattern = /^(?:feat|fix|chore|docs|test|refactor)\([a-z]+\):\s*(.+)/i;
  const match = text.trim().match(msgPattern);
  return match ? match[1] : null;
}

function printFiles() {
  for (const [filename, content] of Object.entries(filesData)) {
    console.log(`\n${filename}\n${content.trim()}`);
  }
}

function commitChanges(message) {
  console.log(`\nCommit: ${message}`);
  printFiles();
}

function handleCommand(cmd) {
  const [action, arg] = cmd.split(' ');
  switch (action) {
    case '/ask':
      chatHistory.push({ role: 'user', content: arg });
      sendRequestToApi();
      break;
    case '/add':
      filesData[arg] = '';
      break;
    case '/drop':
      delete filesData[arg];
      break;
    case '/commit':
      commitChanges('Code changes');
      break;
    case '/undo':
      console.log('Undo not implemented');
      break;
    case '/run':
      console.log('Execute:', arg);
      break;
    case '/help':
      printHelp();
      break;
    default:
      chatHistory.push({ role: 'user', content: cmd });
      sendRequestToApi();
  }
}

function printHelp() {
  const helpText = `
Interactive Mode Commands:
/ask <question>  Ask about code  
/add <file>      Add file to context
/drop <file>     Remove file
/commit          Create git commit 
/undo            Revert last change
/run <cmd>       Execute shell command
/help            Show this help
`;
  console.log(helpText.trim());
}

function printPrompt() {
  process.stdout.write('ai-coder> ');
}


function sendRequestToApi() {
  const body = JSON.stringify({
    prompt: chatHistory.map(({ content }) => content).join('\n\n'),
    options: {
      model: 'code-davinci-002',
      maxTokens: 3000,
      temperature: 0,
      topP: 1,
      stream: true,
    },
  });

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${API_KEY}`,
  };

  const req = http.request(
    API_URL,
    {
      method: 'POST',
      headers,
    },
    (res) => {
      if (res.statusCode === 200) {
        handleApiResponse(res);
      } else {
        const err = new Error(`API request failed with status ${res.statusCode}`);
        logError(err);
        printPrompt();
      }
    }
  );

  req.on('error', (err) => {
    logError(err);
    printPrompt();
  });

  req.write(body);
  req.end();
}

function interactiveMode() {
  isInteractive = true;
  printPrompt();

  const stdin = process.openStdin();
  stdin.addListener('data', (chunk) => {
    const cmd = chunk.toString().trim();
    if (cmd) {
      handleCommand(cmd);
    } else {
      printPrompt();
    }
  });
}

function cliMode(prompt) {
  chatHistory.push({ role: 'user', content: prompt });
  sendRequestToApi();
}

function main() {
  const args = process.argv.slice(2);
  const options = args.filter((arg) => arg.startsWith('-'));
  const prompt = args.filter((arg) => !arg.startsWith('-')).join(' ');

  if (options.includes('-i') || options.includes('--interactive')) {
    interactiveMode();
  } else if (prompt) {
    cliMode(prompt);
  } else {
    console.error('Error: Missing prompt');
    printHelp();
    process.exit(1);
  }
}

main();
