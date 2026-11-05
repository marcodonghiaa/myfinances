const test = require('node:test');
const assert = require('node:assert');

// Regression: push.js configured web-push when loaded, so without VAPID keys (optional) any
// script that loaded it crashed, even with nothing to send.
test('loads and sends nothing without push keys, instead of crashing', async () => {
  const saved = { s: process.env.VAPID_SUBJECT, p: process.env.VAPID_PUBLIC_KEY, k: process.env.VAPID_PRIVATE_KEY };
  delete process.env.VAPID_SUBJECT;
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  const log = console.log;
  console.log = () => {};
  try {
    const { sendToAllSubscriptions } = require('./push');
    assert.strictEqual(await sendToAllSubscriptions({}, [{ endpoint: 'https://x' }], {}), false);
  } finally {
    console.log = log;
    if (saved.s) process.env.VAPID_SUBJECT = saved.s;
    if (saved.p) process.env.VAPID_PUBLIC_KEY = saved.p;
    if (saved.k) process.env.VAPID_PRIVATE_KEY = saved.k;
  }
});
