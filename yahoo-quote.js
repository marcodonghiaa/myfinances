const ASSET_TYPE_MAP = { EQUITY: 'Stock', ETF: 'ETF', MUTUALFUND: 'Fund', BOND: 'Bond' };

// Turns a Yahoo chart response into a quote. Rejects a missing/non-numeric price so a
// NaN never reaches the snapshot upsert (one bad row would fail the whole day's batch).
function parseQuote(data, symbol) {
  const result = data.chart?.result?.[0];
  if (!result) throw new Error(`No quote data for ${symbol}: ${JSON.stringify(data.chart?.error)}`);
  const { regularMarketPrice: price, currency, instrumentType } = result.meta;
  if (typeof price !== 'number' || !Number.isFinite(price)) throw new Error(`No valid price for ${symbol}`);
  const assetType = ASSET_TYPE_MAP[instrumentType] || 'Other';
  // London listings are quoted in pence; fx_rates has GBP, not GBp.
  if (currency === 'GBp') return { price: price / 100, currency: 'GBP', assetType };
  return { price, currency, assetType };
}

// Yahoo calls bond funds ETFs, so a holding marked Bond by hand keeps that label.
function nextAssetType(current, fromYahoo) {
  return current === 'Bond' ? 'Bond' : fromYahoo;
}

module.exports = { parseQuote, nextAssetType };
