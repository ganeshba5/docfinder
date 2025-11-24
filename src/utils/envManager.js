const fs = require('fs').promises;
const path = require('path');

const ENV_PATH = path.join(process.cwd(), '.env');

async function readEnv() {
  try {
    const content = await fs.readFile(ENV_PATH, 'utf8');
    const env = {};
    content.split('\n').forEach(line => {
      const match = line.match(/^([^=]+)=(.*)$/);
      if (match) {
        const key = match[1].trim();
        let value = match[2].trim();
        // Try to parse JSON values
        if ((value.startsWith('[') && value.endsWith(']')) || 
            (value.startsWith('{') && value.endsWith('}'))) {
          try {
            value = JSON.parse(value);
          } catch (e) {
            // Keep as string if not valid JSON
          }
        }
        env[key] = value;
      }
    });
    return env;
  } catch (e) {
    return {};
  }
}

async function writeEnv(env) {
  let content = '';
  for (const [key, value] of Object.entries(env)) {
    const val = typeof value === 'string' ? value : JSON.stringify(value);
    content += `${key}=${val}\n`;
  }
  await fs.writeFile(ENV_PATH, content.trim());
  // Update process.env
  Object.assign(process.env, env);
}

module.exports = { readEnv, writeEnv };
