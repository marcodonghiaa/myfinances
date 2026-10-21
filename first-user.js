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
  const listed = await doFetch(`${url}/auth/v1/admin/users?per_page=1000`, { headers });
  if (!listed.ok) throw new Error(`Could not list users to find the existing one (HTTP ${listed.status}).`);
  const existing = ((await listed.json()).users || []).find((u) => u.email?.toLowerCase() === email.toLowerCase());
  if (!existing) throw new Error(`${email} already exists but was not found in the user list.`);
  return existing.id;
}

module.exports = { ensureUser };

// Credentials come in through the environment, not argv, so they never show up in `ps`.
if (require.main === module) {
  ensureUser({
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
