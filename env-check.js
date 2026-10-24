const crypto = require('crypto');
const fs = require('fs');

// Checks .env once at startup so a missing or wrong value is one clear line, instead of
// every scheduled script failing in the logs with its own error. Errors stop the sync;
// warnings are optional features that stay off.
function checkEnv(env, readFile) {
  const errors = [];
  const warnings = [];

  if (!env.SUPABASE_URL) errors.push('SUPABASE_URL is missing (https://<project-ref>.supabase.co).');
  else if (!env.SUPABASE_URL.startsWith('https://')) errors.push('SUPABASE_URL must start with https://.');

  if (!env.SUPABASE_SECRET_KEY) errors.push('SUPABASE_SECRET_KEY is missing (Project Settings -> API Keys -> secret key).');
  else if (env.SUPABASE_SECRET_KEY.startsWith('sb_publishable_')) {
    errors.push('SUPABASE_SECRET_KEY holds the publishable key. Use the secret key (sb_secret_...).');
  }

  if (!env.APP_ID) errors.push('APP_ID is missing (your Enable Banking application id).');

  const keyText = env.PRIVATE_KEY
    ? env.PRIVATE_KEY.replace(/\\n/g, '\n')
    : env.PRIVATE_KEY_FILE && readFile(env.PRIVATE_KEY_FILE);
  if (!env.PRIVATE_KEY && !env.PRIVATE_KEY_FILE) {
    errors.push('PRIVATE_KEY (or PRIVATE_KEY_FILE) is missing: the Enable Banking .pem key.');
  } else if (!keyText) {
    errors.push(`PRIVATE_KEY_FILE points to ${env.PRIVATE_KEY_FILE}, which can't be read.`);
  } else {
    try {
      crypto.createPrivateKey(keyText);
    } catch {
      errors.push('PRIVATE_KEY is not a valid .pem private key.');
    }
  }

  if (!env.USER_ID) errors.push('USER_ID is missing (your login id, written by setup.sh).');

  if (!env.GEMINI_API_KEY) warnings.push('GEMINI_API_KEY is not set: only your own rules categorize transactions.');
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    warnings.push('VAPID keys are not set: "worth it?" notifications are off.');
  }
  if (Boolean(env.COINBASE_API_KEY_NAME) !== Boolean(env.COINBASE_API_PRIVATE_KEY)) {
    warnings.push('Only one of COINBASE_API_KEY_NAME / COINBASE_API_PRIVATE_KEY is set: Coinbase sync is off.');
  }

  return { errors, warnings };
}

function readFileOrNull(path) {
  try {
    return fs.readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

// Prints the result; returns false when the sync should not start.
function reportEnv(env = process.env) {
  const { errors, warnings } = checkEnv(env, readFileOrNull);
  for (const w of warnings) console.warn(`[env] ${w}`);
  for (const e of errors) console.error(`[env] ${e}`);
  if (errors.length > 0) console.error('[env] Fix .env, then start the sync again.');
  return errors.length === 0;
}

module.exports = { checkEnv, reportEnv };

if (require.main === module) {
  require('dotenv').config();
  process.exit(reportEnv() ? 0 : 1);
}
