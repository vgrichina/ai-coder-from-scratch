const fs = require('fs');
const https = require('https');

const API_KEY = process.env.OPENROUTER_API_KEY;
if (!API_KEY) {
    console.error('Please set OPENROUTER_API_KEY environment variable');
    process.exit(1);
}

// Read user input
let userInput = '';
process.stdin.on('data', chunk => {
    userInput += chunk;
});

process.stdin.on('end', async () => {
    const systemPrompt = fs.readFileSync(__dirname + '/system_prompt.txt', 'utf8');
    const userPromptTemplate = fs.readFileSync(__dirname + '/user_prompt.txt', 'utf8');
    
    const userPrompt = userPromptTemplate.replace('{{USER_REQUEST}}', userInput.trim());

    const requestData = {
        model: 'anthropic/claude-3-sonnet',
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ]
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

    const req = https.request(options, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
            try {
                const response = JSON.parse(data);
                const code = response.choices[0].message.content;
                // Extract code between triple backticks
                const match = code.match(/```(?:javascript|js)?\n([\s\S]*?)```/);
                if (match) {
                    console.log(match[1]);
                } else {
                    console.error('No code found in response');
                }
            } catch (err) {
                console.error('Error parsing response:', err);
            }
        });
    });

    req.on('error', error => {
        console.error('Error:', error);
    });

    req.write(JSON.stringify(requestData));
    req.end();
});
