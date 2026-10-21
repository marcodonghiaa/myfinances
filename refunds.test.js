const test = require('node:test');
const assert = require('node:assert');
const { matchRefunds } = require('./refunds');

const row = (over = {}) => ({
  account_uid: 'acc',
  entry_reference: 'e1',
  amount: 9.99,
  currency: 'EUR',
  credit_debit_indicator: 'DBIT',
  creditor_name: 'Twitter',
  debtor_name: null,
  booking_date: '2026-10-01',
  ...over,
});
const refund = (over = {}) => row({ entry_reference: 'r1', credit_debit_indicator: 'CRDT', booking_date: '2026-10-05', ...over });

test('pairs a credit with the earlier debit of same merchant, amount and currency', () => {
  const pairs = matchRefunds([row(), refund()]);
  assert.deepStrictEqual(pairs, [
    { debit: { account_uid: 'acc', entry_reference: 'e1' }, credit: { account_uid: 'acc', entry_reference: 'r1' } },
  ]);
});

test('card refund: merchant comes from the "Refund from X" remittance, not the account holder', () => {
  const credit = refund({
    creditor_name: null,
    debtor_name: "MARCO D'ONGHIA",
    bank_transaction_code: 'CARD_REFUND',
    remittance_info: 'Refund from  TWITTER ',
  });
  assert.strictEqual(matchRefunds([row(), credit]).length, 1);
});

test('a credit with no merchant name and no refund remittance is never paired', () => {
  const credit = refund({ creditor_name: null, debtor_name: 'Twitter', remittance_info: 'salary' });
  assert.strictEqual(matchRefunds([row(), credit]).length, 0);
});

test('no pair when amount, currency, account or merchant differ', () => {
  assert.strictEqual(matchRefunds([row(), refund({ amount: 5 })]).length, 0);
  assert.strictEqual(matchRefunds([row(), refund({ currency: 'USD' })]).length, 0);
  assert.strictEqual(matchRefunds([row(), refund({ account_uid: 'other' })]).length, 0);
  assert.strictEqual(matchRefunds([row(), refund({ creditor_name: 'Netflix' })]).length, 0);
});

test('no pair when the credit predates the debit or is beyond 90 days', () => {
  assert.strictEqual(matchRefunds([row(), refund({ booking_date: '2026-09-30' })]).length, 0);
  assert.strictEqual(matchRefunds([row(), refund({ booking_date: '2027-01-15' })]).length, 0);
});

test('each debit and credit is used once, nearest preceding debit wins', () => {
  const rows = [
    row({ entry_reference: 'old', booking_date: '2026-09-01' }),
    row({ entry_reference: 'new', booking_date: '2026-10-01' }),
    refund({ entry_reference: 'r1' }),
    refund({ entry_reference: 'r2', booking_date: '2026-10-06' }),
  ];
  const pairs = matchRefunds(rows);
  assert.deepStrictEqual(
    pairs.map((p) => [p.debit.entry_reference, p.credit.entry_reference]),
    [['new', 'r1'], ['old', 'r2']],
  );
});

test('rows without a merchant are never paired', () => {
  assert.strictEqual(matchRefunds([row({ creditor_name: null }), refund({ creditor_name: null })]).length, 0);
});

test('card refund whose creditor_name is the account holder still pairs by the "Refund from" merchant', () => {
  const debit = row({ amount: 1750, currency: 'USD', creditor_name: 'International House', booking_date: '2026-04-30' });
  const credit = refund({
    amount: 1750,
    currency: 'USD',
    creditor_name: "MARCO D'ONGHIA",
    debtor_name: "MARCO D'ONGHIA",
    remittance_info: 'Refund from International House',
    booking_date: '2026-06-09',
  });
  assert.strictEqual(matchRefunds([debit, credit]).length, 1);
});

test('card charge with no creditor_name pairs by the merchant in its remittance, ignoring the "*city" suffix', () => {
  const debit = row({ amount: 51.97, creditor_name: null, remittance_info: 'Booking.com*AMSTERDAM', booking_date: '2026-06-15' });
  const credit = refund({ amount: 51.97, creditor_name: null, remittance_info: 'Refund from Booking.com', booking_date: '2026-07-03' });
  assert.strictEqual(matchRefunds([debit, credit]).length, 1);
});

test('a charge with a different remittance merchant is not paired', () => {
  const debit = row({ amount: 51.97, creditor_name: null, remittance_info: 'Airbnb*DUBLIN', booking_date: '2026-06-15' });
  const credit = refund({ amount: 51.97, creditor_name: null, remittance_info: 'Refund from Booking.com', booking_date: '2026-07-03' });
  assert.strictEqual(matchRefunds([debit, credit]).length, 0);
});
