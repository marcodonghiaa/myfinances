// The scheduled jobs and their scripts, in order. Shared by the Docker scheduler (on a
// timer) and `node scheduler.js --once <job>` (GitHub Actions, cron).
const JOBS = {
  sync: [
    "sync-transactions.js",
    "sync-networth.js",
    "fx-sync.js",
    "categorize.js",
    "classify-type.js",
    "categorize-splitwise.js",
    "classify-flow.js",
    "sync-portfolio-prices.js",
    "sync-crypto-coinbase.js",
    "sync-crypto-prices.js",
  ],
  notify: ["notify-worth-it.js"],
  consent: ["consent-notice.js"],
};

// Runs every step even when one fails (one bank's error shouldn't stop the prices), and
// returns the scripts that failed. `runScript` returns true on success.
function runJob(name, runScript) {
  const scripts = JOBS[name];
  if (!scripts) throw new Error(`Unknown job "${name}". Jobs: ${Object.keys(JOBS).join(", ")}`);
  return scripts.filter((script) => !runScript(script));
}

module.exports = { JOBS, runJob };
