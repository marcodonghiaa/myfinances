const test = require('node:test');
const assert = require('node:assert');
const { consentNotices, buildConsentPayload } = require('./consent-notice');

const TODAY = new Date('2026-10-23T09:00:00Z');
const acc = (user_id, label, consent_valid_until) => ({ user_id, label, consent_valid_until });

test('a bank is announced on the days a daily run should warn: 14, 7, 1 and 0 days left', () => {
  const notices = consentNotices(
    [
      acc('u1', 'Revolut EUR', '2026-10-30T00:00:00Z'), // 7
      acc('u1', 'Fineco', '2026-10-24T00:00:00Z'), // 1
      acc('u2', 'Wise EUR', '2026-10-23T12:00:00Z'), // 0
      acc('u2', 'N26', '2026-10-27T00:00:00Z'), // 4: banner only
      acc('u3', 'N26 EUR', '2026-11-06T00:00:00Z'), // 14: banner appears
    ],
    TODAY,
  );
  assert.deepStrictEqual(notices, [
    { user_id: 'u1', banks: [{ bank: 'Fineco', daysLeft: 1 }, { bank: 'Revolut', daysLeft: 7 }] },
    { user_id: 'u2', banks: [{ bank: 'Wise', daysLeft: 0 }] },
    { user_id: 'u3', banks: [{ bank: 'N26', daysLeft: 14 }] },
  ]);
});

test("a bank's accounts share one consent: the soonest decides, announced once", () => {
  const notices = consentNotices(
    [acc('u1', 'Revolut EUR', '2026-10-30T00:00:00Z'), acc('u1', 'Revolut GBP', '2026-11-05T00:00:00Z')],
    TODAY,
  );
  assert.deepStrictEqual(notices, [{ user_id: 'u1', banks: [{ bank: 'Revolut', daysLeft: 7 }] }]);
});

test('accounts without a consent date are ignored', () => {
  assert.deepStrictEqual(consentNotices([acc('u1', 'Cash', null)], TODAY), []);
});

test('the push names the bank and opens the Accounts page', () => {
  assert.deepStrictEqual(buildConsentPayload([{ bank: 'Revolut', daysLeft: 7 }]), {
    title: 'Renew bank access',
    body: 'Revolut stops syncing in 7 days. Tap to renew.',
    url: '/accounts',
  });
  assert.strictEqual(
    buildConsentPayload([{ bank: 'Wise', daysLeft: 0 }, { bank: 'Fineco', daysLeft: 1 }]).body,
    'Wise stops syncing today, Fineco tomorrow. Tap to renew.',
  );
});
