require('dotenv').config();
const jwt = require('jsonwebtoken');
const fs = require('fs');
const fetch = require('node-fetch');

const APP_ID = process.env.APP_ID;
const PRIVATE_KEY = fs.readFileSync(process.env.PRIVATE_KEY_FILE, 'utf8');
const CODE = 'ed7e5a86-e137-4d70-a66b-3cc9c3e7b863';

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

  const res = await fetch('https://api.enablebanking.com/sessions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: CODE }),
  });

  const data = await res.json();
  console.log('Full response:', JSON.stringify(data, null, 2));
  console.log('Session ID:', data.session_id);
  console.log('Accounts:', JSON.stringify(data.accounts, null, 2));
}

main();