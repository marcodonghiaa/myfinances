// Known Coinbase currency codes -> CoinGecko IDs. Extend this if new assets show up
// (a symbol like "SOL" is ambiguous on CoinGecko, so this is a deliberate allowlist
// rather than an automatic symbol search).
const COINGECKO_ID_MAP = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  USDT: 'tether',
  USDC: 'usd-coin',
  SD: 'stader',
  ETHX: 'stader-ethx',
};

// Turns Coinbase's account list into holding rows to upsert, plus the symbols that now
// report exactly zero (sold down) so a stale amount does not keep being priced. A missing
// or unparseable balance is skipped, never read as zero: that would wipe a real holding.
function planHoldings(accounts, userId) {
  const rows = [];
  const zeroed = [];
  const unmapped = [];

  for (const account of accounts) {
    const symbol = account.currency;
    const raw = account.available_balance?.value;
    const amount = raw == null ? NaN : parseFloat(raw);
    if (Number.isNaN(amount)) continue;

    const coingeckoId = COINGECKO_ID_MAP[symbol];
    if (amount === 0) {
      if (coingeckoId) zeroed.push(symbol);
      continue;
    }
    if (!coingeckoId) {
      unmapped.push(symbol);
      continue;
    }

    rows.push({
      user_id: userId,
      asset_symbol: symbol,
      name: account.name || symbol,
      amount,
      source: 'Coinbase',
      coingecko_id: coingeckoId,
    });
  }

  return { rows, zeroed, unmapped };
}

module.exports = { COINGECKO_ID_MAP, planHoldings };
