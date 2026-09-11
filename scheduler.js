// Runs the sync + notify pipeline on a fixed interval, for the Docker image.
// Replaces launchd/cron -- there's no host scheduler inside a container, so
// this process stays alive as PID 1 and triggers the jobs itself.
//
// Not used outside Docker: local/launchd installs keep using
// run-daily-sync.sh and run-notify.sh directly.
const { spawnSync } = require("node:child_process");

const SYNC_STEPS = [
  "sync-transactions.js",
  "sync-networth.js",
  "fx-sync.js",
  "categorize.js",
  "classify-type.js",
  "classify-flow.js",
  "sync-portfolio-prices.js",
  "sync-crypto-coinbase.js",
  "sync-crypto-prices.js",
];

function run(script) {
  console.log(`[scheduler] ${new Date().toISOString()} running ${script}`);
  const result = spawnSync(process.execPath, [script], { cwd: __dirname, stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`[scheduler] ${script} exited with code ${result.status}`);
  }
}

function runSync() {
  for (const script of SYNC_STEPS) run(script);
}

function runNotify() {
  run("notify-worth-it.js");
}

runSync();
runNotify();
setInterval(runSync, 60 * 60 * 1000); // hourly
setInterval(runNotify, 30 * 60 * 1000); // every 30 min
