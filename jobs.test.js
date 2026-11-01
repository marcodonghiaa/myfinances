const test = require('node:test');
const assert = require('node:assert');
const { JOBS, runJob } = require('./jobs');

test('every job lists scripts that exist in the repo', () => {
  const fs = require('node:fs');
  for (const scripts of Object.values(JOBS)) for (const s of scripts) assert.ok(fs.existsSync(s), s);
  assert.deepStrictEqual(Object.keys(JOBS).sort(), ['consent', 'notify', 'sync']);
});

test('a failing step does not stop the rest, and the job reports which ones failed', () => {
  const ran = [];
  const failed = runJob('sync', (script) => {
    ran.push(script);
    return script !== 'categorize.js';
  });
  assert.deepStrictEqual(ran, JOBS.sync);
  assert.deepStrictEqual(failed, ['categorize.js']);
});

test('an unknown job is an error, not a silent no-op', () => {
  assert.throws(() => runJob('nope', () => true), /Unknown job "nope"/);
});

test('run-daily-sync.sh (launchd/cron) runs every script of the sync job', () => {
  const sh = require('fs').readFileSync(require('path').join(__dirname, 'run-daily-sync.sh'), 'utf8');
  for (const script of JOBS.sync) assert.ok(sh.includes(script), `${script} missing from run-daily-sync.sh`);
});
