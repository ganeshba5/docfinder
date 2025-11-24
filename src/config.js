// src/config.js
require('dotenv').config();
const path = require('path');

const config = {
  app: {
    port: parseInt(process.env.PORT || '5178', 10),
  },
  providers: {
    google: {
      enabled: true,
      accounts: process.env.GOOGLE_ACCOUNTS 
        ? JSON.parse(process.env.GOOGLE_ACCOUNTS)
        : []
    },
    microsoft: {
      enabled: true,
      accounts: process.env.MICROSOFT_ACCOUNTS 
        ? JSON.parse(process.env.MICROSOFT_ACCOUNTS)
        : []
    }
  },
  auth: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      redirectUri: process.env.GOOGLE_REDIRECT_URI,
      scopes: process.env.GOOGLE_SCOPES?.split(',').map(s => s.trim()) || []
    },
    microsoft: {
      clientId: process.env.MICROSOFT_CLIENT_ID,
      clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
      tenantId: process.env.MICROSOFT_TENANT_ID || 'common',
      redirectUri: process.env.MICROSOFT_REDIRECT_URI,
      scopes: process.env.MICROSOFT_SCOPES?.split(',').map(s => s.trim()) || []
    }
  },
  tokenStorage: {
    type: process.env.TOKEN_STORAGE || 'file',
    filePath: process.env.TOKEN_FILE_PATH || path.join(process.cwd(), 'tokens.json')
  }
};

// Validate required configuration
const requiredVars = [
  'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET',
  'MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET'
];

for (const varName of requiredVars) {
  if (!process.env[varName]) {
    console.warn(`Warning: Required environment variable ${varName} is not set`);
  }
}

module.exports = config;