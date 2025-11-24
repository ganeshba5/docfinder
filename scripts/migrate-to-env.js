// scripts/migrate-to-env.js
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

try {
  // Load existing config
  const configPath = path.join(__dirname, '../config/config.yaml');
  const config = yaml.load(fs.readFileSync(configPath, 'utf8'));
  
  // Create .env content
  let envContent = `# Application Settings
PORT=5178

# Google OAuth
GOOGLE_CLIENT_ID=${config.providers?.google?.clientId || ''}
GOOGLE_CLIENT_SECRET=${config.providers?.google?.clientSecret || ''}
GOOGLE_REDIRECT_URI=${config.providers?.google?.redirectUri || 'http://localhost:5178/auth/google/callback'}
GOOGLE_SCOPES=${(config.providers?.google?.scopes || ['profile', 'email']).join(',')}

# Microsoft OAuth
MICROSOFT_CLIENT_ID=${config.providers?.microsoft?.clientId || ''}
MICROSOFT_CLIENT_SECRET=${config.providers?.microsoft?.clientSecret || ''}
MICROSOFT_TENANT_ID=${config.providers?.microsoft?.tenantId || 'common'}
MICROSOFT_REDIRECT_URI=${config.providers?.microsoft?.redirectUri || 'http://localhost:5178/auth/microsoft/callback'}
MICROSOFT_SCOPES=${(config.providers?.microsoft?.scopes || ['User.Read']).join(',')}

# Token Storage
TOKEN_STORAGE=file
`;

  // Save .env file
  fs.writeFileSync(path.join(__dirname, '../.env'), envContent);
  console.log('Successfully created .env file from config.yaml');
  
  // Save accounts as JSON
  const accounts = {
    google: config.providers?.google?.accounts || [],
    microsoft: config.providers?.microsoft?.accounts || []
  };
  fs.writeFileSync(
    path.join(__dirname, '../config/accounts.json'), 
    JSON.stringify(accounts, null, 2)
  );
  console.log('Accounts saved to config/accounts.json');

} catch (e) {
  console.error('Migration failed:', e.message);
}

