// Deno port of notify-worth-it.js and consent-notice.js, run by the notify Edge Function.
import { errorTag } from "./log-safe.ts";
import { fetchSubscriptions, type SendPush, sendToAllSubscriptions } from "./push.ts";

// deno-lint-ignore no-explicit-any
type Db = { from(table: string): any };
// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

// ---- "Worth it?" prompts, every 30 minutes ----

// ponytail: hardcoded allowlist, add a per-user setting if it ever needs to be configurable.
const DISCRETIONARY_CATEGORIES = ["Shopping", "Entertainment", "Dine Out", "Experiences"];
const MIN_AMOUNT = 15; // native currency, no cross-currency threshold
const MIN_AGE_HOURS = 3;
const MAX_AGE_HOURS = 24; // don't blast stale transactions if the job was down
const MAX_BOOKING_AGE_DAYS = 7; // = sync overlap: a late-posted purchase still counts

export async function fetchEligibleTransactions(db: Db, userId: string, now: Date): Promise<Row[]> {
  const bookingFloor = new Date(now.getTime() - MAX_BOOKING_AGE_DAYS * 86400 * 1000).toISOString().slice(0, 10);
  const { data, error } = await db
    .from("transactions")
    .select("entry_reference, account_uid, creditor_name, amount, currency, category, flow_type, deleted_at")
    .eq("user_id", userId)
    .eq("credit_debit_indicator", "DBIT")
    .in("category", DISCRETIONARY_CATEGORIES)
    .is("worth_it", null) // not "already pushed" -- "not yet answered" (in-app or via push)
    .is("worth_it_prompted_at", null)
    .gte("amount", MIN_AMOUNT)
    .lte("created_at", new Date(now.getTime() - MIN_AGE_HOURS * 3600 * 1000).toISOString())
    .gte("created_at", new Date(now.getTime() - MAX_AGE_HOURS * 3600 * 1000).toISOString())
    .or(`booking_date.gte.${bookingFloor},booking_date.is.null`);
  if (error) throw error;
  // A refunded, deleted or transfer row isn't a purchase to ask about.
  return data.filter((t: Row) => !t.deleted_at && t.flow_type !== "refunded" && t.flow_type !== "transfer");
}

// One transaction: the deep-link prompt. Several at once become ONE digest push.
export function buildPayload(transactions: Row[]) {
  if (transactions.length === 1) {
    const tx = transactions[0];
    return {
      title: "Worth it?",
      body: `${tx.amount} ${tx.currency} at ${tx.creditor_name || "a merchant"} — ${tx.category}`,
      url: `/transactions?highlight=${encodeURIComponent(tx.entry_reference)}`,
    };
  }
  const names = transactions.slice(0, 3).map((t) => t.creditor_name || "a merchant");
  const extra = transactions.length > 3 ? ` +${transactions.length - 3} more` : "";
  return { title: "Worth it?", body: `${transactions.length} purchases today: ${names.join(", ")}${extra}`, url: "/transactions" };
}

export async function userIdsWithSubscriptions(db: Db): Promise<string[]> {
  const { data, error } = await db.from("push_subscriptions").select("user_id");
  if (error) throw error;
  return [...new Set<string>((data || []).map((r: Row) => r.user_id))];
}

export async function notifyUser(db: Db, userId: string, send: SendPush | null, now = new Date()): Promise<number> {
  const transactions = await fetchEligibleTransactions(db, userId, now);
  if (transactions.length === 0) return 0;
  const subscriptions = await fetchSubscriptions(db, userId);
  if (subscriptions.length === 0) return 0;
  if (!(await sendToAllSubscriptions(db, subscriptions, buildPayload(transactions), send))) {
    console.error("Push delivery failed for every subscription of a user -- will retry next run.");
    return 0;
  }
  const promptedAt = now.toISOString();
  let failed = 0;
  for (const tx of transactions) {
    const { error } = await db
      .from("transactions").update({ worth_it_prompted_at: promptedAt })
      .eq("account_uid", tx.account_uid).eq("entry_reference", tx.entry_reference);
    if (error) failed++;
  }
  if (failed > 0) console.error(`Failed to mark ${failed} transaction(s) prompted.`);
  return transactions.length;
}

/** Every user who turned notifications on; one user's failure doesn't stop the others. */
export async function runWorthIt(db: Db, send: SendPush | null) {
  let prompted = 0;
  let failedUsers = 0;
  for (const userId of await userIdsWithSubscriptions(db)) {
    try {
      prompted += await notifyUser(db, userId, send);
    } catch (err) {
      failedUsers++;
      console.error(`Prompts failed for a user: ${errorTag(err)}`);
    }
  }
  return { prompted, failedUsers };
}

// ---- Bank access ending, once a day ----

// Each threshold day is hit by one daily run, so no "already sent" state.
const NOTICE_DAYS = [14, 7, 1, 0];
const DAY_MS = 86_400_000;

// "Revolut EUR" -> "Revolut": a bank's accounts share one consent (same rule as the dashboard).
function bankName(label?: string | null) {
  const parts = (label || "Bank").trim().split(/\s+/);
  return parts.length > 1 && /^[A-Z]{3}$/.test(parts[parts.length - 1]) ? parts.slice(0, -1).join(" ") : parts.join(" ");
}

export function consentNotices(accounts: Row[], today: Date) {
  const todayUtc = Date.parse(today.toISOString().slice(0, 10));
  const soonest = new Map<string, Map<string, number>>();
  for (const a of accounts) {
    if (!a.consent_valid_until) continue;
    const daysLeft = Math.round((Date.parse(a.consent_valid_until.slice(0, 10)) - todayUtc) / DAY_MS);
    const banks = soonest.get(a.user_id) ?? new Map<string, number>();
    const bank = a.bank_name || bankName(a.label);
    banks.set(bank, Math.min(daysLeft, banks.get(bank) ?? Infinity));
    soonest.set(a.user_id, banks);
  }
  const notices = [];
  for (const [user_id, banks] of soonest) {
    const due = [...banks]
      .filter(([, daysLeft]) => NOTICE_DAYS.includes(daysLeft))
      .map(([bank, daysLeft]) => ({ bank, daysLeft }))
      .sort((x, y) => x.daysLeft - y.daysLeft);
    if (due.length > 0) notices.push({ user_id, banks: due });
  }
  return notices;
}

const when = (d: number) => (d === 0 ? "today" : d === 1 ? "tomorrow" : `in ${d} days`);

export function buildConsentPayload(banks: Array<{ bank: string; daysLeft: number }>) {
  const parts = banks.map((b, i) => (i === 0 ? `${b.bank} stops syncing ${when(b.daysLeft)}` : `${b.bank} ${when(b.daysLeft)}`));
  return { title: "Renew bank access", body: `${parts.join(", ")}. Tap to renew.`, url: "/accounts" };
}

export async function runConsent(db: Db, send: SendPush | null, today = new Date()) {
  const { data, error } = await db.from("accounts").select("user_id, label, bank_name, consent_valid_until").not("consent_valid_until", "is", null);
  if (error) throw error;
  let sent = 0;
  for (const { user_id, banks } of consentNotices(data, today)) {
    const subscriptions = await fetchSubscriptions(db, user_id);
    if (subscriptions.length > 0 && await sendToAllSubscriptions(db, subscriptions, buildConsentPayload(banks), send)) sent++;
  }
  return { reminded: sent };
}
