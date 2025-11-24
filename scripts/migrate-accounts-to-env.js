const fs = require('fs');
const dotenv = require('dotenv');
const path = require('path');

// Load existing .env file if it exists
const envPath = path.join(__dirname, '..', '.env');
let envConfig = {};

if (fs.existsSync(envPath)) {
  envConfig = dotenv.parse(fs.readFileSync(envPath));
}

// Load accounts from accounts.json
const accountsPath = path.join(__dirname, '..', 'config', 'accounts.json');
const accounts = JSON.parse(fs.readFileSync(accountsPath, 'utf8'));

// Convert accounts to environment variables
const googleAccounts = accounts.google || [];
const microsoftAccounts = accounts.microsoft || [];

// Update environment config
envConfig.GOOGLE_ACCOUNTS = JSON.stringify(googleAccounts);
envConfig.MICROSOFT_ACCOUNTS = JSON.stringify(microsoftAccounts);

// Write back to .env
const envContent = Object.entries(envConfig)
  .map(([key, value]) => `${key}=${value}`)
  .join('\n');

fs.writeFileSync(envPath, envContent);

console.log('Successfully migrated accounts to .env file');
console.log(`- Google accounts: ${googleAccounts.length}`);
console.log(`- Microsoft accounts: ${microsoftAccounts.length}`);
