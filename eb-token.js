// Enable Banking authenticates each API call with a short-lived RS256 JWT
// signed by your application's private key.
const crypto = require('crypto');
const fs = require('fs');

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

function loadPrivateKey() {
  return process.env.PRIVATE_KEY
    ? process.env.PRIVATE_KEY.replace(/\\n/g, '\n')
    : fs.readFileSync(process.env.PRIVATE_KEY_FILE, 'utf8');
}

function getToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = { typ: 'JWT', alg: 'RS256', kid: process.env.APP_ID };
  const payload = { iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat: now, exp: now + 3600 };
  const signingInput = `${b64url(header)}.${b64url(payload)}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), loadPrivateKey()).toString('base64url');
  return `${signingInput}.${signature}`;
}

module.exports = { getToken };
