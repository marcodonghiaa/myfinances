const { fetchWithTimeout } = require('./http');

// The app has no sign-up screen, so setup.sh creates the one login here through the Auth
// admin API (secret key). Re-running setup finds the user that already has this email
// instead of failing; its password is left as it is.
async function ensureUser({ url, secretKey, email, password }, doFetch = fetchWithTimeout) {
  const headers = { apikey: secretKey, Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' };
  const created = await doFetch(`${url}/auth/v1/admin/users`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (created.ok) return (await created.json()).id;

  const error = await created.json().catch(() => ({}));
  if (error.error_code !== 'email_exists') {
    throw new Error(`Could not create the user (HTTP ${created.status}): ${error.msg || error.message || 'unknown error'}`);
  }
  const existing = await findUserByEmail({ url, headers, email }, doFetch);
  if (!existing) throw new Error(`${email} already exists but was not found in the user list.`);
  return existing.id;
}

async function findUserByEmail({ url, headers, email }, doFetch) {
  const listed = await doFetch(`${url}/auth/v1/admin/users?per_page=1000`, { headers });
  if (!listed.ok) throw new Error(`Could not list users to find the existing one (HTTP ${listed.status}).`);
  return ((await listed.json()).users || []).find((u) => u.email?.toLowerCase() === email.toLowerCase());
}

// `setup.sh --reset-password`: the app has no "forgot password" screen, so a forgotten
// password is reset here with the secret key, no email needed.
async function resetPassword({ url, secretKey, email, password }, doFetch = fetchWithTimeout) {
  const headers = { apikey: secretKey, Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' };
  const user = await findUserByEmail({ url, headers, email }, doFetch);
  if (!user) throw new Error(`No login with the email ${email}.`);
  const updated = await doFetch(`${url}/auth/v1/admin/users/${user.id}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ password }),
  });
  if (!updated.ok) {
    const error = await updated.json().catch(() => ({}));
    throw new Error(`Could not set the new password (HTTP ${updated.status}): ${error.msg || error.message || 'unknown error'}`);
  }
  return user.id;
}

module.exports = { ensureUser, resetPassword };

// Credentials come in through the environment, not argv, so they never show up in `ps`.
if (require.main === module) {
  const run = process.argv.includes('--reset') ? resetPassword : ensureUser;
  run({
    url: process.env.SETUP_URL,
    secretKey: process.env.SETUP_SECRET_KEY,
    email: process.env.SETUP_EMAIL,
    password: process.env.SETUP_PASSWORD,
  }).then(
    (id) => console.log(id),
    (err) => {
      console.error(err.message);
      process.exit(1);
    },
  );
}
