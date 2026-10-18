// Imports monthly spend per category from before your bank was linked.
//   node spend-history.js <file.csv> <user-uuid>
// CSV header: month,category,spend   (month = YYYY-MM, spend in EUR, category = one you use in the app)
// Months that already have bank transactions are ignored by the app, so overlap is harmless.
const HEADER = 'month,category,spend';

function parseSpendCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.shift()?.trim() !== HEADER) throw new Error(`header must be exactly: ${HEADER}`);
  const seen = new Set();
  const rows = lines.map((line, i) => {
    const at = `line ${i + 2}`;
    const cells = line.split(',').map((c) => c.trim());
    if (cells.length !== 3) throw new Error(`${at}: expected 3 columns`);
    const [month, category, raw] = cells;
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error(`${at}: bad month "${month}" (want YYYY-MM)`);
    if (!category) throw new Error(`${at}: empty category`);
    const spend = Number(raw);
    if (raw === '' || !Number.isFinite(spend) || spend < 0) throw new Error(`${at}: bad spend "${raw}"`);
    const key = `${month}|${category}`;
    if (seen.has(key)) throw new Error(`${at}: duplicate ${month} ${category}`);
    seen.add(key);
    return { month: `${month}-01`, category, spend_eur: spend };
  });
  return rows.sort((a, b) => a.month.localeCompare(b.month) || a.category.localeCompare(b.category));
}

async function main() {
  const [file, userId] = process.argv.slice(2);
  if (!file || !userId) throw new Error('usage: node spend-history.js <file.csv> <user-uuid>');
  require('dotenv').config();
  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);
  const rows = parseSpendCsv(require('fs').readFileSync(file, 'utf8')).map((r) => ({ ...r, user_id: userId }));
  const { error } = await supabase.from('spend_history').upsert(rows, { onConflict: 'user_id,month,category' });
  if (error) throw error;
  console.log(`Imported ${rows.length} rows (${rows[0].month} → ${rows.at(-1).month}).`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { parseSpendCsv };
