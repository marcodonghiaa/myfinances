// Runs the sync + notify pipeline on a fixed interval, for the Docker image.
// Replaces launchd/cron -- there's no host scheduler inside a container, so
// this process stays alive as PID 1 and triggers the jobs itself.
//
// `node scheduler.js --once <sync|notify|consent>` runs one job and exits, non-zero if a
// step failed: what the GitHub Actions workflow calls. Local launchd/cron installs keep
// using run-daily-sync.sh and run-notify.sh.
const { spawnSync } = require("node:child_process");
const { createClient } = require("@supabase/supabase-js");
const { loadCursors, addedCursors } = require("./sync-state");
const { reportEnv } = require("./env-check");
const { JOBS, runJob } = require("./jobs");
const { errorTag } = require("./log-safe");

// A script that hangs would otherwise block every later step and run forever.
const SCRIPT_TIMEOUT_MS = 10 * 60 * 1000;


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
  return result.status === 0;
}

function runSync() {
  runJob("sync", (script) => run(script));
}

// Every few minutes: sync banks linked since the last run, then classify what arrived.
// Quiet when nothing is new, so the log isn't one line every 5 minutes.
async function runFirstSync() {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);
  const before = await loadCursors(supabase, SYNC_STATE_FILE);
  run("sync-transactions.js", ["--new-only"], { quiet: true });
  const added = addedCursors(before, await loadCursors(supabase, SYNC_STATE_FILE));
  if (added.length === 0) return;
  console.log(`[scheduler] first sync done for ${added.length} new account(s)`);
  for (const script of FIRST_SYNC_FOLLOW_UP) run(script);
}

function runNotify() {
  runJob("notify", (script) => run(script));
}

// Once a day: push a reminder when a bank's access is 14, 7, 1 or 0 days from expiring.
function runConsentNotice() {
  runJob("consent", (script) => run(script));
}

// A broken .env is one clear message here, not an error from every script every 6 hours.
if (!reportEnv()) process.exit(1);

const onceAt = process.argv.indexOf("--once");
if (onceAt !== -1) {
  const failed = runJob(process.argv[onceAt + 1], (script) => run(script));
  if (failed.length > 0) console.error(`[scheduler] failed: ${failed.join(", ")}`);
  process.exit(failed.length > 0 ? 1 : 0);
}

runSync();
runNotify();
runConsentNotice();
// Every 6h = 4 runs/day: banks typically cap unattended (PSD2) account access around 4 calls/day.
setInterval(runSync, 6 * 60 * 60 * 1000);
setInterval(runNotify, 30 * 60 * 1000); // every 30 min
setInterval(runConsentNotice, 24 * 60 * 60 * 1000); // daily
setInterval(() => runFirstSync().catch((err) => console.error(`[scheduler] first sync check failed: ${errorTag(err)}`)), 5 * 60 * 1000); // every 5 min, only touches newly linked banks
