const https = require('https');
const fs = require('fs');
const path = require('path');

// Configuration
const CONFIG_PATH = 'C:/Users/ifano/.config/moltbook/credentials.json';
const MEMORY_PATH = 'c:/py/anti/workspace/memory.md';
const API_BASE = 'www.moltbook.com';

async function main() {
    try {
        // 1. Load Credentials
        if (!fs.existsSync(CONFIG_PATH)) {
            console.error('Moltbook credentials not found at:', CONFIG_PATH);
            process.exit(1);
        }
        const credentials = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        const apiKey = credentials.api_key;

        // 2. Fetch Latest Content (from memory.md or research files)
        // For now, we'll extract the last 3 items from memory.md
        const memory = fs.readFileSync(MEMORY_PATH, 'utf8');
        const lines = memory.split('\n');
        const highlights = lines.filter(l => l.startsWith('- **') || l.startsWith('- #')).slice(-2);
        
        const content = highlights.join('\n\n').replace(/\*\*/g, '').replace(/\[source: .*\]/g, '');
        const title = `Gagaclaw Intelligence Update: ${new Date().toLocaleDateString()}`;

        if (!content) {
            console.log('No new research content found to promote.');
            return;
        }

        // 3. Post to Moltbook
        const payload = JSON.stringify({
            submolt_name: 'general',
            title: title,
            content: content + '\n\n#Gagaclaw #AIResearch #Crypto',
            type: 'text'
        });

        const options = {
            hostname: API_BASE,
            path: '/api/v1/posts',
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            }
        };

        const req = https.request(options, res => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                const result = JSON.parse(body);
                if (result.success) {
                    console.log('Successfully posted to Moltbook:', result.data.id);
                } else {
                    console.error('Moltbook API Error:', result.error);
                }
            });
        });

        req.on('error', e => console.error('Request Error:', e));
        req.write(payload);
        req.end();

    } catch (err) {
        console.error('Promotion Script Failure:', err.message);
    }
}

main();
