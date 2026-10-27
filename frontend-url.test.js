const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { normalizeFrontendUrl, REJECT_MESSAGE } = require('./frontend-url');

test('normalizeFrontendUrl trims, lowercases and keeps only the origin', () => {
  assert.deepStrictEqual(normalizeFrontendUrl('  HTTPS://My-Finances.Vercel.App/path?x=1  '), {
    origin: 'https://my-finances.vercel.app',
    warning: null,
  });
  assert.strictEqual(normalizeFrontendUrl('https://a.vercel.app/').origin, 'https://a.vercel.app');
});

test('normalizeFrontendUrl accepts http only on localhost with a port', () => {
  assert.strictEqual(normalizeFrontendUrl('http://localhost:3000/').origin, 'http://localhost:3000');
});

test('normalizeFrontendUrl rejects plain http and non-URLs with the exact message', () => {
  assert.strictEqual(REJECT_MESSAGE, "Use your dashboard's https address, e.g. https://my-finances.vercel.app");
  for (const input of ['http://a.vercel.app', 'not a url', 'http://localhost/', 'ftp://a.vercel.app']) {
    assert.throws(() => normalizeFrontendUrl(input), { message: REJECT_MESSAGE }, input);
  }
});

test('normalizeFrontendUrl warns on Vercel per-deployment and per-branch addresses', () => {
  for (const input of ['https://my-finances-abc123xyz-marco.vercel.app', 'https://my-finances-git-main-marco.vercel.app']) {
    const { origin, warning } = normalizeFrontendUrl(input);
    assert.strictEqual(origin, input);
    assert.match(warning, /Domains/);
  }
});

test('CLI exit codes: 0 ok, 1 rejected, 3 warned', () => {
  const run = (url) => {
    try {
      return { code: 0, out: execFileSync('node', [path.join(__dirname, 'frontend-url.js'), url], { encoding: 'utf8', stdio: 'pipe' }) };
    } catch (e) {
      return { code: e.status, out: e.stdout, err: e.stderr };
    }
  };
  assert.deepStrictEqual(run('https://a.vercel.app/x'), { code: 0, out: 'https://a.vercel.app\n' });
  const rejected = run('http://a.vercel.app');
  assert.strictEqual(rejected.code, 1);
  assert.strictEqual(rejected.err, `${REJECT_MESSAGE}\n`);
  const warned = run('https://my-finances-git-main-marco.vercel.app');
  assert.strictEqual(warned.code, 3);
  assert.strictEqual(warned.out, 'https://my-finances-git-main-marco.vercel.app\n');
  assert.match(warned.err, /Domains/);
});
