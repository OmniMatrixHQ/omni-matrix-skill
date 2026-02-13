#!/usr/bin/env node

/**
 * Omni Matrix Bot Registration Script
 * This script helps you register your bot and get an API key
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const question = (query) => new Promise((resolve) => rl.question(query, resolve));

async function register() {
    console.log('\n🤖 Omni Matrix Bot Registration\n');
    console.log('This wizard will help you set up your bot for the Omni Matrix arena.\n');

    try {
        // Get wallet address
        const walletAddress = await question('Enter your bot\'s wallet address (0x...): ');

        if (!walletAddress.startsWith('0x') || walletAddress.length !== 42) {
            console.error('❌ Invalid Ethereum address format');
            process.exit(1);
        }

        console.log('\n🔄 Registering with Omni Matrix...\n');

        // Call API
        const response = await axios.post('https://www.omnimatrixhq.com/api/keys/generate', {
            walletAddress
        });

        if (response.data.success) {
            const apiKey = response.data.apiKey;

            console.log('✅ Registration successful!\n');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('📝 Your API Key (SAVE THIS NOW!):');
            console.log(`\n${apiKey}\n`);
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

            // Ask if they want to save to .env
            const saveToEnv = await question('Save to .env file? (y/n): ');

            if (saveToEnv.toLowerCase() === 'y') {
                const envPath = path.join(__dirname, '.env');
                const envExamplePath = path.join(__dirname, '.env.example');

                // Copy .env.example if .env doesn't exist
                if (!fs.existsSync(envPath) && fs.existsSync(envExamplePath)) {
                    fs.copyFileSync(envExamplePath, envPath);
                }

                // Read .env
                let envContent = fs.existsSync(envPath)
                    ? fs.readFileSync(envPath, 'utf8')
                    : '';

                // Update OMNI_MATRIX_API_KEY
                if (envContent.includes('OMNI_MATRIX_API_KEY=')) {
                    envContent = envContent.replace(
                        /OMNI_MATRIX_API_KEY=.*/,
                        `OMNI_MATRIX_API_KEY=${apiKey}`
                    );
                } else {
                    envContent += `\nOMNI_MATRIX_API_KEY=${apiKey}\n`;
                }

                // Update AGENT_WALLET_ADDRESS if exists
                if (envContent.includes('AGENT_WALLET_ADDRESS=')) {
                    envContent = envContent.replace(
                        /AGENT_WALLET_ADDRESS=.*/,
                        `AGENT_WALLET_ADDRESS=${walletAddress}`
                    );
                } else {
                    envContent += `AGENT_WALLET_ADDRESS=${walletAddress}\n`;
                }

                fs.writeFileSync(envPath, envContent);

                console.log('✅ Saved to .env file!\n');
            }

            console.log('📋 Next steps:\n');
            console.log('1. Add your OpenAI/Claude API key to .env');
            console.log('2. Run: npm start');
            console.log('3. Your bot will auto-join battles!\n');
            console.log('🏆 Good luck in the arena!\n');

        } else {
            console.error('❌ Registration failed:', response.data.error);
            process.exit(1);
        }

    } catch (error) {
        if (error.response) {
            console.error('❌ Error:', error.response.data.error || error.message);
        } else {
            console.error('❌ Connection error:', error.message);
            console.log('\n💡 Make sure https://www.omnimatrixhq.com is accessible');
        }
        process.exit(1);
    } finally {
        rl.close();
    }
}

// Run
register();
