// One call to Enable Banking during setup, so a wrong APP_ID, a wrong .pem or an
// app still Inactive shows up now instead of on the first bank sync.
const { getToken } = require('./eb-token');
const { fetchWithTimeout } = require('./http');
const { errorTag } = require('./log-safe');

const REJECTED =
  'Enable Banking rejected the APP_ID or the .pem key. Check that APP_ID is the application id shown next to the app, and that the .pem is the one downloaded when you registered that app.';
const INACTIVE =
  'Your Enable Banking app is Inactive. Activate it: https://enablebanking.com/cp/applications → your app → Activate by linking accounts (link any one of your accounts), then try again.';
// An outage must not block setup, so it is reported but still ok.
const unreachable = (tag) => ({ ok: true, message: `Couldn't reach Enable Banking (${tag}); setup goes on, check it later.` });

// Messages never include the response body, which may echo request details.
async function checkApplication(doFetch, token) {
  let res;
  try {
    res = await doFetch('https://api.enablebanking.com/application', { headers: { Authorization: `Bearer ${token}` } });
  } catch (err) {
    return unreachable(errorTag(err));
  }
  if (res.status === 401 || res.status === 403) return { ok: false, message: REJECTED };
  if (res.status !== 200) return unreachable(`HTTP ${res.status}`);
  const app = await res.json().catch(() => null);
  if (!app) return unreachable('HTTP 200');
  if (!app.active) return { ok: false, retry: true, message: INACTIVE };
  return { ok: true, message: `Enable Banking app OK (${app.name}, ${app.environment}).` };
}

async function main({ getToken: sign = getToken, fetch: doFetch = fetchWithTimeout } = {}) {
  let token;
  try {
    token = sign();
  } catch {
    // crypto.sign throws on a key it can't parse: same fix as a key EB rejects.
    return { ok: false, message: REJECTED };
  }
  return checkApplication(doFetch, token);
}

// setup.sh loops on 1 (fixed in EB's panel, same values) and stops on 2 (needs a new APP_ID or .pem).
const exitCode = ({ ok, retry }) => (ok ? 0 : retry ? 1 : 2);

module.exports = { checkApplication, main, exitCode };

// APP_ID and PRIVATE_KEY come in through the environment, not argv, so they never show up in `ps`.
if (require.main === module) {
  main().then(({ ok, retry, message }) => {
    console.log(message);
    process.exit(exitCode({ ok, retry }));
  }).catch(() => process.exit(2)); // an unexpected crash must not read as Inactive (1) and loop
}
