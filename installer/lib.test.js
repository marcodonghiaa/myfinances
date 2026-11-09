const test = require('node:test');
const assert = require('node:assert');
const lib = require('./lib');

test('refFromUrl reads the project ref, rejects anything else', () => {
  assert.equal(lib.refFromUrl('https://abcdefghijklmnopqrst.supabase.co'), 'abcdefghijklmnopqrst');
  assert.equal(lib.refFromUrl('https://abc.supabase.co/'), 'abc');
  assert.equal(lib.refFromUrl('https://evil.com/abc.supabase.co'), '');
  assert.equal(lib.refFromUrl(undefined), '');
});

test('pickKeys matches by prefix, not position', () => {
  const keys = [{ api_key: 'eyJlegacy' }, { api_key: 'sb_secret_x' }, { api_key: 'sb_publishable_y' }];
  assert.deepEqual(lib.pickKeys(keys), { publishable: 'sb_publishable_y', secret: 'sb_secret_x' });
  assert.deepEqual(lib.pickKeys([{ api_key: 'eyJ' }]), { publishable: '', secret: '' });
});

test('vaultSql updates an existing secret or creates it, and escapes quotes', () => {
  const sql = lib.vaultSql({ project_url: "https://a'b.supabase.co" });
  assert.match(sql, /^do \$\$/);
  assert.match(sql, /vault\.update_secret\(\(select id from vault\.secrets where name = 'project_url'\), 'https:\/\/a''b\.supabase\.co'\)/);
  assert.match(sql, /vault\.create_secret\('https:\/\/a''b\.supabase\.co', 'project_url'\)/);
});

test('authConfigToml closes sign-ups and adds the site URL only when known', () => {
  const plain = lib.authConfigToml();
  assert.match(plain, /enable_signup = false/);
  assert.doesNotMatch(plain, /site_url/);
  const withSite = lib.authConfigToml({ siteUrl: 'https://x.vercel.app' });
  assert.match(withSite, /site_url = "https:\/\/x\.vercel\.app"/);
  assert.match(withSite, /additional_redirect_urls = \["https:\/\/x\.vercel\.app\/reset-password"\]/);
});

test('vercelUrl prefers the alias, else the last vercel.app address, else empty', () => {
  assert.equal(lib.vercelUrl('Production: https://a-123abc.vercel.app\nAliased: https://a.vercel.app [3s]'), 'https://a.vercel.app');
  assert.equal(lib.vercelUrl('https://a-123abc-me.vercel.app\n'), 'https://a-123abc-me.vercel.app');
  assert.equal(lib.vercelUrl('nothing'), '');
});

test('pickAlias takes the shortest non-branch alias in any shape', () => {
  assert.equal(lib.pickAlias(JSON.stringify({ aliases: ['alopex-ab-git-main-me.vercel.app', 'alopex-ab-me.vercel.app', 'alopex-ab.vercel.app'] })), 'https://alopex-ab.vercel.app');
  assert.equal(lib.pickAlias(JSON.stringify({ alias: [{ domain: 'x.vercel.app' }] })), 'https://x.vercel.app');
  assert.equal(lib.pickAlias(JSON.stringify({})), '');
  assert.equal(lib.pickAlias('not json'), '');
});

test('projectSlug makes a valid Vercel name', () => {
  assert.equal(lib.projectSlug('Alopex-AbC_12'), 'alopex-abc-12');
  assert.equal(lib.projectSlug('***'), 'alopex');
});

test('nodeTooOld', () => {
  assert.equal(lib.nodeTooOld('v18.19.0'), true);
  assert.equal(lib.nodeTooOld('v20.0.0'), false);
  assert.equal(lib.nodeTooOld('v22.11.0'), false);
});

test('tarballUrl points at codeload for a branch', () => {
  assert.equal(lib.tarballUrl('me/repo', 'main'), 'https://codeload.github.com/me/repo/tar.gz/main');
});

test('cleanPath strips quotes and drag-and-drop escapes, expands ~', { skip: process.platform === 'win32' }, () => {
  assert.equal(lib.cleanPath("'/Users/me/My Keys/a.pem'", '/Users/me'), '/Users/me/My Keys/a.pem');
  assert.equal(lib.cleanPath('/Users/me/My\\ Keys/a.pem ', '/Users/me'), '/Users/me/My Keys/a.pem');
  assert.equal(lib.cleanPath('~/Downloads/a.pem', '/Users/me'), '/Users/me/Downloads/a.pem');
});

test('secretsEnv quotes values, keeps the PEM on one line, skips empty ones', () => {
  const out = lib.secretsEnv({ A: 'x"y', PEM: '-----BEGIN-----\nab+c\n-----END-----\n', EMPTY: '', MISSING: undefined });
  assert.equal(out, 'A="x\\"y"\nPEM="-----BEGIN-----\\nab+c\\n-----END-----"\n');
});

test('checkGeminiKey: ok, rejected, outage', async () => {
  const answer = (status) => async () => ({ ok: status === 200, status });
  assert.deepEqual(await lib.checkGeminiKey('k', answer(200)), { ok: true });
  const bad = await lib.checkGeminiKey('k', answer(400));
  assert.equal(bad.ok, false);
  assert.equal(bad.unreachable, undefined);
  assert.equal((await lib.checkGeminiKey('k', answer(503))).unreachable, true);
  assert.equal((await lib.checkGeminiKey('k', async () => { throw new Error('offline'); })).unreachable, true);
});
