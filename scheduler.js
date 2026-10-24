// Runs the sync + notify pipeline on a fixed interval, for the Docker image.
// Replaces launchd/cron -- there's no host scheduler inside a container, so
// this process stays alive as PID 1 and triggers the jobs itself.
//
// Not used outside Docker: local/launchd installs keep using
// run-daily-sync.sh and run-notify.sh directly.
const { spawnSync } = require("node:child_process");
const { loadSyncState, addedCursors } = require("./sync-state");
const { reportEnv } = require("./env-check");

// A script that hangs would otherwise block every later step and run forever.
const SCRIPT_TIMEOUT_MS = 10 * 60 * 1000;

const SYNC_STEPS = [
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
];

const SYNC_STATE_FILE = process.env.SYNC_STATE_FILE || "last-sync.json";

// After a new bank's first transactions land, these turn them into categories and flows.
const FIRST_SYNC_FOLLOW_UP = ["categorize.js", "classify-type.js", "classify-flow.js"];

function run(script, args = [], { quiet = false } = {}) {
  if (!quiet) console.log(`[scheduler] ${new Date().toISOString()} running ${script}`);
  const result = spawnSync(process.execPath, [script, ...args], { cwd: __dirname, stdio: "inherit", timeout: SCRIPT_TIMEOUT_MS });
  if (result.error?.code === "ETIMEDOUT") {
    console.error(`[scheduler] ${script} killed after ${SCRIPT_TIMEOUT_MS / 1000}s`);
  } else if (result.status !== 0) {
    console.error(`[scheduler] ${script} exited with code ${result.status}`);
  }
}

function runSync() {
  for (const script of SYNC_STEPS) run(script);
}

// Every few minutes: sync banks linked since the last run, then classify what arrived.
// Quiet when nothing is new, so the log isn't one line every 5 minutes.
function runFirstSync() {
  const before = loadSyncState(SYNC_STATE_FILE);
  run("sync-transactions.js", ["--new-only"], { quiet: true });
  const added = addedCursors(before, loadSyncState(SYNC_STATE_FILE));
  if (added.length === 0) return;
  console.log(`[scheduler] first sync done for ${added.length} new account(s)`);
  for (const script of FIRST_SYNC_FOLLOW_UP) run(script);
}

function runNotify() {
  run("notify-worth-it.js");
}

// A broken .env is one clear message here, not an error from every script every 6 hours.
if (!reportEnv()) process.exit(1);

runSync();
runNotify();
// Every 6h = 4 runs/day: banks typically cap unattended (PSD2) account access around 4 calls/day.
setInterval(runSync, 6 * 60 * 60 * 1000);
setInterval(runNotify, 30 * 60 * 1000); // every 30 min
setInterval(runFirstSync, 5 * 60 * 1000); // every 5 min, only touches newly linked banks
