// Pure helpers for the one-command installer (index.js), kept apart so they can be tested
// without a network, a terminal or the Supabase / Vercel CLIs.

const path = require('node:path');

// "https://abcd.supabase.co/" -> "abcd" ('' when it isn't a Supabase project URL).
function refFromUrl(url) {
  return String(url || '').match(/^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/)?.[1] || '';
}

// `supabase projects api-keys --output json`: match by prefix, not by position or field name.
function pickKeys(keys) {
  const find = (prefix) => keys.find((k) => k.api_key?.startsWith(prefix))?.api_key || '';
  return { publishable: find('sb_publishable_'), secret: find('sb_secret_') };
}

const sqlString = (value) => `'${String(value).replace(/'/g, "''")}'`;

// The pg_cron jobs (migrations 20261117000000 / 20261118000000) read these two Vault secrets.
// Setting them is what turns the scheduled sync on. Safe to run again: it updates in place.
function vaultSql(secrets) {
  const lines = Object.entries(secrets).map(([name, value]) => {
    const n = sqlString(name);
    const v = sqlString(value);
    return `  if exists (select 1 from vault.secrets where name = ${n}) then
    perform vault.update_secret((select id from vault.secrets where name = ${n}), ${v});
  else
    perform vault.create_secret(${v}, ${n});
  end if;`;
  });
  return `do $$\nbegin\n${lines.join('\n')}\nend\n$$;\n`;
}

// Only the keys declared here are pushed, so every other remote auth setting stays as it is.
function authConfigToml({ siteUrl } = {}) {
  const lines = ['project_id = "installer"', '', '[auth]', 'enable_signup = false'];
  if (siteUrl) {
    lines.push(`site_url = "${siteUrl}"`, `additional_redirect_urls = ["${siteUrl}/reset-password"]`);
  }
  return `${lines.join('\n')}\n`;
}

// `vercel deploy --prod` prints the deployment URL on stdout and "Aliased: https://..." for the
// project's stable address. Prefer the alias: a deployment URL changes on every deploy.
function vercelUrl(output) {
  const text = String(output);
  const aliased = text.match(/Aliased:\s*(https:\/\/[^\s[\]]+)/)?.[1];
  if (aliased) return aliased;
  const urls = text.match(/https:\/\/[a-z0-9.-]+\.vercel\.app/g);
  return urls ? urls[urls.length - 1] : '';
}

// Lowercase, dashes only, as Vercel wants project names.
function projectSlug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 90) || 'alopex';
}

function nodeTooOld(version, min = 20) {
  return Number(String(version).replace(/^v/, '').split('.')[0]) < min;
}

// GitHub serves any branch as a .tar.gz, so the install needs neither git nor a GitHub account.
const tarballUrl = (repo, ref) => `https://codeload.github.com/${repo}/tar.gz/${encodeURIComponent(ref)}`;

// A path pasted or dragged into a terminal: macOS adds backslash escapes or quotes, ~ means home.
function cleanPath(input, home) {
  let p = String(input).trim().replace(/^(['"])(.*)\1$/, '$2');
  if (process.platform !== 'win32') p = p.replace(/\\(.)/g, '$1');
  return p.replace(/^~(?=$|[\\/])/, home);
}

// `supabase secrets set --env-file`: double-quoted values, newlines as \n (the PEM). Empty ones are skipped.
function secretsEnv(secrets) {
  return Object.entries(secrets)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}="${String(v).trim().replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n')}"`)
    .join('\n') + '\n';
}

// `vercel inspect <url> --json`: the project's stable *.vercel.app address among the deployment's
// aliases (not a -git- branch one), shortest first.
function pickAlias(json) {
  let d;
  try { d = JSON.parse(json); } catch { return ''; }
  const list = [].concat(d.aliases || [], d.alias || []).map((a) => (typeof a === 'string' ? a : a.domain || a.alias || a.url || ''));
  const hosts = list.map((a) => a.replace(/^https?:\/\//, '')).filter((h) => h && !/-git-/.test(h));
  hosts.sort((a, b) => a.length - b.length);
  return hosts[0] ? `https://${hosts[0]}` : '';
}

// One free call (list models) tells a wrong key from a right one before it is saved. An outage
// must not block setup, so an unreachable API keeps the key and says so.
async function checkGeminiKey(key, doFetch = fetch) {
  let res;
  try {
    res = await doFetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=1&key=${encodeURIComponent(key)}`);
  } catch {
    return { ok: false, unreachable: true, message: "Couldn't reach Google to check the key; it is saved, check it later." };
  }
  if (res.ok) return { ok: true };
  if (res.status >= 500) return { ok: false, unreachable: true, message: `Google answered HTTP ${res.status}; the key is saved, check it later.` };
  return { ok: false, message: 'Google rejected that key. Paste it again (copy the whole key), or press Enter to skip.' };
}

// The one argument is the install folder. -h/--help asks for usage, wherever it is; any other
// word starting with "-" is an option we don't have, never a folder name (#132). After "--"
// every word is a folder name.
function parseArgs(argv) {
  const end = argv.indexOf('--');
  const options = end === -1 ? argv : argv.slice(0, end);
  const words = end === -1 ? argv : [...options, ...argv.slice(end + 1)];
  if (options.some((a) => a === '-h' || a === '--help')) return { help: true };
  const option = options.find((a) => a.startsWith('-'));
  if (option) {
    // No hint for a word the % rule below would refuse anyway (polish-5 I4).
    const hint =
      option.startsWith('--') || option.includes('%') ? '' : ` For a folder starting with "-", write ./${option}.`;
    return { error: `Unknown option ${option}.${hint}` };
  }
  if (words.length > 1) return { error: 'Give at most one folder.' };
  // On Windows the folder reaches cmd (tar -C), which expands %VAR% even inside quotes.
  if (words[0] && words[0].includes('%')) return { error: 'The folder name cannot contain %.' };
  return { folder: words[0] || 'alopex' };
}

const USAGE = `Usage: npx create-alopex [options] [folder]

Installs Alopex into [folder] (default: ./alopex), or updates the install already there.

Options:
  -h, --help  Show this help.
  --          Everything after it is the folder, even a name starting with "-".`;

// Where to install. Run with no folder from inside an install (to update it), that install: not a
// new one in alopex/alopex with a second Supabase project (polish-5 I1).
function installRoot(folder, cwd, exists) {
  const root = path.resolve(cwd, folder);
  const isInstall = (dir) => exists(path.join(dir, 'backend', '.env'));
  return folder === 'alopex' && !isInstall(root) && isInstall(cwd) ? cwd : root;
}

// What main() does with its arguments, before it touches anything: print usage and stop, refuse
// the arguments, or install into the folder.
function startup(argv) {
  const args = parseArgs(argv);
  if (args.help) return { exit: 0, out: USAGE };
  if (args.error) return { exit: 1, err: `${args.error}\n\n${USAGE}` };
  return { folder: args.folder };
}

module.exports = { USAGE, startup, parseArgs, installRoot, checkGeminiKey,  cleanPath, secretsEnv, pickAlias, refFromUrl, pickKeys, vaultSql, authConfigToml, vercelUrl, projectSlug, nodeTooOld, tarballUrl, sqlString };
