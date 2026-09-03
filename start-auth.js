require('dotenv').config();
const jwt = require('jsonwebtoken');
const fs = require('fs');
const fetch = require('node-fetch');

const APP_ID = process.env.APP_ID;
const PRIVATE_KEY = fs.readFileSync(process.env.PRIVATE_KEY_FILE, 'utf8');

function getToken() {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat: now, exp: now + 3600 },
    PRIVATE_KEY,
    { algorithm: 'RS256', header: { typ: 'JWT', alg: 'RS256', kid: APP_ID } }
  );
}

async function main() {
  const token = getToken();

  const res = await fetch('https://api.enablebanking.com/auth', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      access: { valid_until: new Date(Date.now() + 24 * 3600 * 1000).toISOString() },
      aspsp: { name: 'Revolut', country: 'IT' },
      state: 'test123',
      redirect_url: 'https://localhost:3000/callback',
      psu_type: 'personal',
    }),
  });

  const data = await res.json();
  console.log('Full response:', JSON.stringify(data, null, 2));
  console.log('Open this URL in your browser to log into Revolut:\n');
  console.log(data.url);
}

main();