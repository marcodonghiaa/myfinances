// Imports month-end net worth from before the live snapshots began.
//   node net-worth-history.js <file.csv> <user-uuid>
// CSV header: month,stocks,bonds,crypto,cash,total   (month = YYYY-MM, amounts in EUR)
// "total" is your own net worth figure; whatever it is below the four classes is stored as
// liabilities_eur (e.g. a tax reserve), so the allocation stays exact and the total stays yours.
const HEADER = ['month', 'stocks', 'bonds', 'crypto', 'cash', 'total'];
const MONEY = ['stocks', 'bonds', 'crypto', 'cash', 'total'];

function parseHistoryCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.shift()?.trim() !== HEADER.join(',')) {
    throw new Error(`header must be exactly: ${HEADER.join(',')}`);
  }
  const seen = new Set();
  const rows = lines.map((line, i) => {
    const at = `line ${i + 2}`;
    const cells = line.split(',').map((c) => c.trim());
    if (cells.length !== HEADER.length) throw new Error(`${at}: expected ${HEADER.length} columns`);
    const [month, ...rest] = cells;
    const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
    if (!m) throw new Error(`${at}: bad month "${month}" (want YYYY-MM)`);
    if (seen.has(month)) throw new Error(`${at}: duplicate month ${month}`);
    seen.add(month);
    const v = {};
    MONEY.forEach((name, j) => {
      const n = Number(rest[j]);
      if (rest[j] === '' || !Number.isFinite(n)) throw new Error(`${at}: bad ${name} "${rest[j]}"`);
      v[name] = n;
    });
    const lastDay = new Date(Date.UTC(+m[1], +m[2], 0)).getUTCDate();
    const gap = v.stocks + v.bonds + v.crypto + v.cash - v.total;
    return {
      snapshot_date: `${month}-${String(lastDay).padStart(2, '0')}`,
      stocks_eur: v.stocks,
      bonds_eur: v.bonds,
      crypto_eur: v.crypto,
      cash_eur: v.cash,
      liabilities_eur: Math.round(gap * 100) / 100,
      total_eur: v.total,
    };
  });
  return rows.sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));
}

async function main() {
  const [file, userId] = process.argv.slice(2);
  if (!file || !userId) throw new Error('usage: node net-worth-history.js <file.csv> <user-uuid>');
  require('dotenv').config();
  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);
  const rows = parseHistoryCsv(require('fs').readFileSync(file, 'utf8')).map((r) => ({
    ...r,
    user_id: userId,
  }));
  const { error } = await supabase
    .from('net_worth_history')
    .upsert(rows, { onConflict: 'user_id,snapshot_date' });
  if (error) throw error;
  console.log(`Imported ${rows.length} months (${rows[0].snapshot_date} → ${rows.at(-1).snapshot_date}).`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { parseHistoryCsv };
