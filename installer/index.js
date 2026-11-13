#!/usr/bin/env node
// One-command self-host install: `npx create-alopex [folder]`.
// Downloads both apps, creates (or reuses) your Supabase project with the schema, Edge Functions
// and scheduled sync (pg_cron, so no computer or GitHub Actions has to run it), creates your
// login, then puts the dashboard online on Vercel. Needs only Node 20+: the Supabase and Vercel
// CLIs run through npx. Run it again (from the same place, or inside the install) to update: answers
// saved in .env are reused.
//
// What it CANNOT automate: the Enable Banking sign-up and PSD2 app (a form on their site, no API).
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const lib = require('./lib');

const APP = 'Alopex';
const BACKEND_REPO = process.env.ALOPEX_BACKEND_REPO || 'marcodonghiaa/alopex';
const DASHBOARD_REPO = process.env.ALOPEX_DASHBOARD_REPO || 'marcodonghiaa/alopex-web';
// Each installer release downloads the matching release tag of both repos (tag both before
// publishing), never a moving branch: what runs is what was released. ALOPEX_REF=main to test.
const REF = process.env.ALOPEX_REF || `v${require('./package.json').version}`;
// Exact CLI versions, so a new CLI release can't change what setup does. Bump them on release.
const SUPABASE = 'supabase@3.1.0';
const VERCEL = 'vercel@65.12.1';
const WIN = process.platform === 'win32';

const bold = (s) => console.log(`\x1b[1m${s}\x1b[0m`);
let stepNo = 0;
const step = (s) => { console.log(); bold(`==> ${++stepNo}. ${s}`); };
class Stop extends Error {}
const die = (msg) => { throw new Stop(msg); };

// --- running commands --------------------------------------------------------------------------
// Windows needs a shell to find npx.cmd; quote what has spaces (folder names) for it.
const winQuote = (a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);
function run(cmd, args, { cwd, interactive = false, env } = {}) {
  const res = spawnSync(cmd, WIN ? args.map(winQuote) : args, {
    cwd,
    shell: WIN,
    env: { ...process.env, ...env },
    stdio: interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) die(`Could not run ${cmd}: ${res.error.message}`);
  return { ok: res.status === 0, out: res.stdout || '', err: res.stderr || '', status: res.status };
}
// Hides the CLI's chatter when it works, shows everything when it fails, so no error is hidden.
function must(cmd, args, opts, failMessage) {
  const r = run(cmd, args, opts);
  if (!r.ok) {
    process.stderr.write(r.out + r.err);
    die(failMessage);
  }
  return r.out;
}
const supabase = (args, opts) => run('npx', ['--yes', SUPABASE, ...args], opts);
const supabaseMust = (args, opts, msg) => must('npx', ['--yes', SUPABASE, ...args], opts, msg);
const vercel = (args, opts) => run('npx', ['--yes', VERCEL, ...args], opts);
const vercelMust = (args, opts, msg) => must('npx', ['--yes', VERCEL, ...args], opts, msg);

// --- questions ---------------------------------------------------------------------------------
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
const ask = (q, def = '') => new Promise((resolve) => rl.question(def ? `${q} [${def}]: ` : `${q}: `, (a) => resolve(a.trim() || def)));
const yes = async (q, def) => /^y/i.test(await ask(`${q} [${def ? 'Y/n' : 'y/N'}]`, '') || (def ? 'y' : 'n'));
// Typed characters are not echoed (passwords, API keys).
function askHidden(q) {
  return new Promise((resolve) => {
    const write = rl._writeToOutput;
    rl._writeToOutput = (s) => { if (s.includes(q)) write.call(rl, s); };
    rl.question(`${q}: `, (a) => {
      rl._writeToOutput = write;
      process.stdout.write('\n');
      resolve(a.trim());
    });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function openBrowser(url) {
  const [cmd, args] = WIN ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawnSync(cmd, args, { stdio: 'ignore' }); } catch { /* printing the address is enough */ }
}

// --- steps ---------------------------------------------------------------------------------------
// Code from a release tag on GitHub, or from a local checkout when ALOPEX_<NAME>_DIR is set
// (to try changes before they are published). Folders whose files the CLIs apply as a whole are
// emptied first, so a migration or function renamed or removed upstream doesn't linger here.
async function download(repo, dir, localDir) {
  for (const sub of ['supabase/migrations', 'supabase/functions']) fs.rmSync(path.join(dir, sub), { recursive: true, force: true });
  if (localDir) {
    const src = path.resolve(localDir.replace(/^~(?=$|\/)/, os.homedir()));
    fs.cpSync(src, dir, { recursive: true, filter: (f) => !/(^|[\\/])(node_modules|\.git|\.env|\.vercel|\.temp)$/.test(path.relative(src, f)) });
    return;
  }
  const res = await fetch(lib.tarballUrl(repo, REF));
  if (!res.ok) die(`Could not download ${repo} at ${REF} (HTTP ${res.status}).`);
  const file = path.join(os.tmpdir(), `alopex-${process.pid}-${path.basename(dir)}.tar.gz`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  fs.mkdirSync(dir, { recursive: true });
  // Extracting over an existing install updates the code and leaves .env (not in the archive).
  must('tar', ['-xzf', file, '-C', dir, '--strip-components=1'], {}, `Could not unpack ${repo}.`);
  fs.rmSync(file, { force: true });
}

async function main() {
  const start = lib.startup(process.argv.slice(2));
  if (start.exit !== undefined) {
    if (start.out) console.log(start.out);
    if (start.err) console.error(start.err);
    process.exitCode = start.exit;
    return;
  }
  if (lib.nodeTooOld(process.version)) die(`Node 20 or newer is needed (you have ${process.version}): https://nodejs.org`);
  const root = lib.installRoot(start.folder, process.cwd(), fs.existsSync);
  const backend = path.join(root, 'backend');
  const dashboard = path.join(root, 'dashboard');

  bold(`${APP} setup: about 30 minutes the first time, most of it on Enable Banking's site.`);
  console.log(`Installs into ${root}. Every question shows a recommended answer: press Enter to accept it.`);
  console.log('Answers are saved as you go: stop any time and run the same command again.');

  step('Downloading the app');
  await download(BACKEND_REPO, backend, process.env.ALOPEX_BACKEND_DIR);
  await download(DASHBOARD_REPO, dashboard, process.env.ALOPEX_DASHBOARD_DIR);
  must('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: backend }, 'Could not install the backend packages.');
  // The backend's own helpers: .env merging, login creation, Enable Banking check.
  const { mergeEnv, parseEnv } = require(path.join(backend, 'env-file.js'));
  const envFile = path.join(backend, '.env');
  const saved = parseEnv(fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '');
  const saveEnv = (updates) => {
    const base = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : fs.readFileSync(path.join(backend, '.env.example'), 'utf8');
    fs.writeFileSync(envFile, mergeEnv(base, updates), { mode: 0o600 });
    Object.assign(saved, updates);
  };
  const sb = { cwd: backend };
  console.log(`Done: ${root}`);

  step('Supabase login (free account)');
  if (!supabase(['projects', 'list'], sb).ok) {
    console.log('Opening your browser to sign in to Supabase. Come back here once it says you are logged in.');
    if (!supabase(['login'], { ...sb, interactive: true }).ok) die('Supabase login failed.');
  }
  console.log('Logged in.');

  step('Supabase project');
  let ref = lib.refFromUrl(saved.SUPABASE_URL);
  let dbPassword = '';
  if (ref && !(await yes(`Keep using project ${ref} from your last run?`, true))) ref = '';
  if (!ref && (await yes('Use a Supabase project you already have? (New here? Press Enter)', false))) {
    ref = await ask('Project ref (the 20-letter id in the dashboard URL)');
    const projects = JSON.parse(supabaseMust(['projects', 'list', '--output', 'json'], sb, 'Could not list your projects.'));
    if (!projects.some((p) => p.id === ref || p.ref === ref)) die(`No project ${ref} in your Supabase account.`);
  }
  if (!ref) {
    let orgs = JSON.parse(supabaseMust(['orgs', 'list', '--output', 'json'], sb, 'Could not list your organizations.'));
    if (orgs.length === 0) {
      const name = `${os.userInfo().username}'s org`;
      console.log(`No Supabase organization yet: creating "${name}".`);
      orgs = [JSON.parse(supabaseMust(['orgs', 'create', name, '--output', 'json', '--yes'], sb, 'Could not create an organization.'))];
    }
    let org = orgs[0];
    if (orgs.length > 1) {
      orgs.forEach((o, i) => console.log(`  ${i + 1}) ${o.name}`));
      org = orgs[Number(await ask('Organization', '1')) - 1] || die(`Choose 1 to ${orgs.length}.`);
    }
    const name = await ask('New project name (only you see it)', 'alopex');
    const region = await ask('Region (Europe: Enter; else e.g. us-east-1)', 'eu-central-1');
    dbPassword = require('crypto').randomBytes(18).toString('base64url');
    console.log('Creating the project (about a minute)...');
    const created = JSON.parse(supabaseMust(
      ['projects', 'create', name, '--org-id', org.id, '--db-password', dbPassword, '--region', region, '--output', 'json', '--yes'],
      sb,
      'Could not create the project. Free plans allow 2 active projects per organization: pause one at supabase.com/dashboard, or pick another organization.',
    ));
    ref = created.id || created.ref || die('Project creation returned no id.');
  }
  const url = `https://${ref}.supabase.co`;
  saveEnv({ SUPABASE_URL: url });
  console.log(`Using project ${ref}.`);

  step('Creating your tables');
  const linkEnv = dbPassword ? { SUPABASE_DB_PASSWORD: dbPassword } : {};
  for (let i = 1; ; i++) {
    const r = supabase(['link', '--project-ref', ref, '--yes'], { ...sb, env: linkEnv });
    if (r.ok) break;
    if (i === 20) { process.stderr.write(r.out + r.err); die('The project never became ready (10 minutes).'); }
    console.log(`A new project takes a minute or two to start: waiting (${i}/20)...`);
    await sleep(30000);
  }
  supabaseMust(['db', 'push', '--linked', '--yes'], { ...sb, env: linkEnv }, 'Could not create the tables.');
  const keys = lib.pickKeys(JSON.parse(supabaseMust(
    ['projects', 'api-keys', '--project-ref', ref, '--reveal', '--output', 'json'], sb, 'Could not read the API keys.',
  )));
  if (!keys.publishable || !keys.secret) die('No sb_publishable_ / sb_secret_ keys on this project: create them under Project Settings -> API Keys, then run again.');
  saveEnv({ SUPABASE_SECRET_KEY: keys.secret, VITE_SUPABASE_URL: url, VITE_SUPABASE_PUBLISHABLE_KEY: keys.publishable });
  console.log('Tables ready.');

  step('Your login');
  if (saved.USER_ID && saved.LOGIN_EMAIL) {
    console.log(`Already set up for ${saved.LOGIN_EMAIL}. Forgot the password? In ${backend}: ./setup.sh --reset-password`);
  } else {
    console.log('The app has no sign-up screen: your login is created here. Save the password in your password manager.');
    const email = await ask('Email');
    const password = await askHidden('Password (6+ characters, not shown)');
    const { ensureUser } = require(path.join(backend, 'first-user.js'));
    const userId = await ensureUser({ url, secretKey: keys.secret, email, password }).catch((e) => die(e.message));
    saveEnv({ USER_ID: userId, LOGIN_EMAIL: email });
    console.log(`Login ready for ${email}.`);
  }
  closeAuth(sb, ref);

  step('Enable Banking (on their site, about 10 minutes)');
  let appId = saved.APP_ID;
  let pem = saved.PRIVATE_KEY ? saved.PRIVATE_KEY.replace(/\\n/g, '\n') : '';
  if (appId && pem) {
    console.log(`Using the Enable Banking app from your last run (${appId}).`);
  } else {
    const repoUrl = `https://github.com/${BACKEND_REPO}`;
    console.log(`Sign up at https://enablebanking.com/sign-in/ , open the Control Panel, API applications -> Add a new application:

  Environment ............. Production (not Sandbox)
  Private key ............. leave 'Generate in the browser'
  Application name ........ ${APP} (any name)
  Redirect URL ............ ${url}/functions/v1/bank-consent-callback
  Description ............. Personal net-worth tracker for my own accounts
  Data protection email ... ${saved.LOGIN_EMAIL || 'your email'}
  Privacy URL / Terms URL . ${repoUrl}

Click Register: a .pem key file downloads. Then click 'Activate by linking accounts' and link any one
of your accounts there (this unlocks the free plan; your banks are connected later, from the dashboard).
The APP_ID is the long id shown next to your app.`);
    openBrowser('https://enablebanking.com/sign-in/');
    appId = await ask('Enable Banking APP_ID');
    const pemPath = lib.cleanPath(await ask('The downloaded .pem (drag the file here)'), os.homedir());
    if (!fs.existsSync(pemPath)) die(`No file at ${pemPath}`);
    pem = fs.readFileSync(pemPath, 'utf8');
  }
  for (;;) {
    const r = run('node', ['eb-check.js'], { cwd: backend, env: { APP_ID: appId, PRIVATE_KEY: pem } });
    console.log((r.out || r.err).trim());
    if (r.ok) break;
    if (r.status !== 1) die('Wrong APP_ID or .pem: run again and enter the right ones.');
    await ask('Fix it on Enable Banking, then press Enter to check again');
  }
  saveEnv({ APP_ID: appId, PRIVATE_KEY: pem.trim().replace(/\r?\n/g, '\\n') });

  step('Gemini API key (recommended: sorts transactions into categories)');
  let gemini = saved.GEMINI_API_KEY;
  if (gemini) console.log('Using the key from your last run.');
  else {
    console.log('Free at https://aistudio.google.com/apikey . Enter skips: then only your own rules categorize.');
    console.log('Privacy: with a key, every new transaction (payer or payee name, description, amount) is sent to');
    console.log('Google Gemini, and so are Splitwise expense descriptions and any statement PDF you import. On the');
    console.log('free tier Google may use it to improve its models; a paid-tier key (billing on) opts you out.');
    for (;;) {
      gemini = await ask('Paste your Gemini API key (Enter to skip)');
      if (!gemini) {
        console.log('Skipped. To add it later, run the same command again: it asks only for what is missing.');
        break;
      }
      const check = await lib.checkGeminiKey(gemini);
      if (check.ok) {
        saveEnv({ GEMINI_API_KEY: gemini });
        console.log(`Key OK (ends in ...${gemini.slice(-4)}).`);
        break;
      }
      console.log(check.message);
      if (check.unreachable) { saveEnv({ GEMINI_API_KEY: gemini }); break; }
    }
  }

  step('Edge Functions and the scheduled sync');
  // Keep existing push keys: new ones would silently break every phone already subscribed.
  if (!saved.VAPID_PUBLIC_KEY || !saved.VAPID_PRIVATE_KEY) {
    const v = require(path.join(backend, 'node_modules', 'web-push')).generateVAPIDKeys();
    saveEnv({ VAPID_PUBLIC_KEY: v.publicKey, VAPID_PRIVATE_KEY: v.privateKey, VITE_VAPID_PUBLIC_KEY: v.publicKey });
  }
  if (!saved.VAPID_SUBJECT || saved.VAPID_SUBJECT === 'mailto:you@example.com') saveEnv({ VAPID_SUBJECT: `mailto:${saved.LOGIN_EMAIL || 'admin@localhost'}` });
  const secrets = {
    ENABLE_BANKING_APP_ID: appId,
    ENABLE_BANKING_PRIVATE_KEY: pem,
    GEMINI_API_KEY: gemini,
    VAPID_PUBLIC_KEY: saved.VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY: saved.VAPID_PRIVATE_KEY,
    VAPID_SUBJECT: saved.VAPID_SUBJECT,
    FRONTEND_URL: saved.FRONTEND_URL,
  };
  withTempFile(lib.secretsEnv(secrets), (file) =>
    supabaseMust(['secrets', 'set', '--project-ref', ref, '--env-file', file, '--yes'], sb, 'Could not save the Edge Function secrets.'));
  supabaseMust(['functions', 'deploy', '--project-ref', ref, '--use-api', '--yes'], sb, 'Could not deploy the Edge Functions.');
  // The pg_cron jobs from the migrations call the functions with these: setting them turns the sync on.
  withTempFile(lib.vaultSql({ project_url: url, sync_bank_secret_key: keys.secret }), (file) =>
    supabaseMust(['db', 'query', '--remote', '--file', file, '--yes'], sb, 'Could not turn the scheduled sync on.'));
  saveEnv({ SYNC_ON: 'supabase' });
  console.log('Functions live. Your banks sync every 6 hours inside Supabase: nothing has to stay on.');

  step('Putting the dashboard online (Vercel, free account)');
  if (!vercel(['whoami'], { cwd: dashboard }).ok) {
    console.log('Opening your browser to sign in to Vercel. Come back here once it says you are logged in.');
    if (!vercel(['login'], { cwd: dashboard, interactive: true }).ok) die('Vercel login failed.');
  }
  const project = lib.projectSlug(saved.VERCEL_PROJECT || `${APP}-${ref.slice(0, 6)}`);
  const pub = {
    VITE_SUPABASE_URL: url,
    VITE_SUPABASE_PUBLISHABLE_KEY: keys.publishable,
    VITE_VAPID_PUBLIC_KEY: saved.VAPID_PUBLIC_KEY,
  };
  // Public values only (meant for browsers). --build-env for this deploy; env add keeps them
  // for redeploys started from Vercel's own dashboard.
  console.log('Building and deploying (1-2 minutes)...');
  const deployed = vercelMust(
    ['deploy', '--prod', '--yes', '--project', project, '--create-if-missing', ...Object.entries(pub).flatMap(([k, v]) => ['--build-env', `${k}=${v}`])],
    { cwd: dashboard }, 'The Vercel deploy failed.',
  );
  for (const [k, v] of Object.entries(pub)) vercel(['env', 'add', k, 'production', '--value', v, '--yes', '--force', '--no-sensitive'], { cwd: dashboard });
  saveEnv({ VERCEL_PROJECT: project });
  // The unique deployment address sits behind Vercel's login: use the project's stable alias.
  const deployUrl = lib.vercelUrl(deployed);
  const inspected = deployUrl ? vercel(['inspect', deployUrl, '--json'], { cwd: dashboard }) : { ok: false };
  const site = (inspected.ok && lib.pickAlias(inspected.out)) || deployUrl;

  step('Sign in');
  const origin = await waitForSignIn(url, keys.secret, site);
  if (origin) {
    saveEnv({ FRONTEND_URL: origin });
    closeAuth(sb, ref, origin); // password-reset emails link back to the dashboard
  }
  console.log();
  bold(`Done! ${origin || site || 'Open your Vercel project'} , sign in as ${saved.LOGIN_EMAIL}, then Accounts -> Connect a bank.`);
  console.log(`Your keys are in ${envFile} (keep it private). To update ${APP} later, run npx create-alopex@latest from the same place, or inside ${root}.`);
  console.log();
  bold('Protect the accounts that hold your data: turn on two-factor sign-in at');
  console.log('  Supabase: https://supabase.com/dashboard/account/security');
  console.log('  Vercel:   https://vercel.com/account/settings/authentication');
}

// Switches public sign-ups off (the login exists already) and, once known, points auth emails at the dashboard.
function closeAuth(sb, ref, siteUrl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alopex-auth-'));
  fs.mkdirSync(path.join(dir, 'supabase'));
  fs.writeFileSync(path.join(dir, 'supabase', 'config.toml'), lib.authConfigToml({ siteUrl }));
  const r = supabase(['config', 'push', '--workdir', dir, '--project-ref', ref, '--yes'], sb);
  fs.rmSync(dir, { recursive: true, force: true });
  if (!r.ok) console.log(`WARNING: could not switch public sign-ups off. Do it at https://supabase.com/dashboard/project/${ref}/auth/providers`);
  else if (!siteUrl) console.log('Public sign-ups are off: only your login can use this instance.');
}

function withTempFile(text, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alopex-'));
  const file = path.join(dir, 'in');
  fs.writeFileSync(file, text, { mode: 0o600 });
  try { return fn(file); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// The dashboard registers its own address (table dashboard_origins) on the first sign-in.
async function waitForSignIn(url, secretKey, site) {
  const registered = async () => {
    const res = await fetch(`${url}/rest/v1/dashboard_origins?select=origin&order=origin.desc&limit=1`, { headers: { apikey: secretKey } }).catch(() => null);
    return res?.ok ? (await res.json())[0]?.origin || '' : '';
  };
  let origin = await registered();
  if (origin || !site || !process.stdin.isTTY) return origin;
  console.log(`Opening ${site} : sign in once so bank linking knows where to send you back (waiting up to 15 minutes).`);
  openBrowser(site);
  for (let i = 0; i < 180 && !origin; i++) {
    await sleep(5000);
    origin = await registered();
  }
  return origin;
}

main()
  .then(() => { rl.close(); })
  .catch((err) => {
    rl.close();
    console.error(`\nError: ${err instanceof Stop ? err.message : err.stack}`);
    console.error('Fix that, then run the same command again: answers already saved are reused.');
    process.exit(1);
  });
