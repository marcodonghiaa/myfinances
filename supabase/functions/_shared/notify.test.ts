import { assert, assertEquals } from "jsr:@std/assert@1.0.19";
import { buildConsentPayload, consentNotices, fetchEligibleTransactions, notifyUser, runConsent, userIdsWithSubscriptions } from "./notify.ts";
import { sendToAllSubscriptions, type Subscription } from "./push.ts";

// Records every builder call as [method, ...args]; awaiting it resolves the given rows.
function recorder(rows: unknown[] = []) {
  const calls: unknown[][] = [];
  const builder: Record<string, unknown> = new Proxy({}, {
    get: (_, method: string) => {
      if (method === "then") return (resolve: (v: unknown) => void) => resolve({ data: rows, error: null });
      return (...args: unknown[]) => (calls.push([method, ...args]), builder);
    },
  });
  return { db: { from: () => builder }, calls };
}

const NOW = new Date("2026-10-27T12:00:00Z");

Deno.test("worth-it window: created 3-24 h ago, booked within 7 days (UTC), one user", async () => {
  const { db, calls } = recorder();
  await fetchEligibleTransactions(db, "user", NOW);
  const find = (m: string, c: string) => calls.find((x) => x[0] === m && x[1] === c);
  assertEquals(find("lte", "created_at"), ["lte", "created_at", "2026-10-27T09:00:00.000Z"]);
  assertEquals(find("gte", "created_at"), ["gte", "created_at", "2026-10-26T12:00:00.000Z"]);
  assertEquals(find("eq", "user_id"), ["eq", "user_id", "user"]);
  assertEquals(calls.find((x) => x[0] === "or"), ["or", "booking_date.gte.2026-10-20,booking_date.is.null"]);
  const late = recorder();
  await fetchEligibleTransactions(late.db, "user", new Date("2026-10-27T23:30:00-05:00"));
  assertEquals(late.calls.find((x) => x[0] === "or"), ["or", "booking_date.gte.2026-10-21,booking_date.is.null"]);
});

Deno.test("refunded, deleted and transfer rows are not prompted", async () => {
  const { db } = recorder([
    { entry_reference: "ok", flow_type: "spend", deleted_at: null },
    { entry_reference: "new", flow_type: null, deleted_at: null },
    { entry_reference: "refunded", flow_type: "refunded", deleted_at: null },
    { entry_reference: "deleted", flow_type: "spend", deleted_at: "2026-10-27T10:00:00Z" },
    { entry_reference: "transfer", flow_type: "transfer", deleted_at: null },
  ]);
  assertEquals((await fetchEligibleTransactions(db, "user", NOW)).map((t) => t.entry_reference), ["ok", "new"]);
});

Deno.test("every user with a push subscription is prompted, each once", async () => {
  const { db } = recorder([{ user_id: "a" }, { user_id: "b" }, { user_id: "a" }]);
  assertEquals(await userIdsWithSubscriptions(db), ["a", "b"]);
});

// protects=a purchase is asked about once, only after a push really went out; fails_when=rows are
// marked prompted when every push failed, or a second run asks again
Deno.test("rows are marked prompted only after a push is delivered", async () => {
  const marked: unknown[] = [];
  const tx = { entry_reference: "r1", account_uid: "a1", creditor_name: "Shop", amount: 20, currency: "EUR", category: "Shopping", flow_type: "spend", deleted_at: null };
  const sub = { id: "s1", endpoint: "https://push", p256dh: "k", auth: "a" };
  const db = {
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "is", "gte", "lte"]) q[m] = () => q;
      q.or = async () => ({ data: [tx], error: null });
      q.update = (u: unknown) => (marked.push(u), q);
      if (table === "push_subscriptions") q.eq = async () => ({ data: [sub], error: null });
      q.then = (resolve: (v: unknown) => void) => resolve({ error: null });
      return q;
    },
  };
  const quiet = console.error;
  console.error = () => {};
  try {
    assertEquals(await notifyUser(db, "u1", async () => {
      throw Object.assign(new Error("boom"), { statusCode: 500 });
    }, NOW), 0);
    assertEquals(marked, []);
    assertEquals(await notifyUser(db, "u1", async () => {}, NOW), 1);
    assertEquals(marked, [{ worth_it_prompted_at: NOW.toISOString() }]);
  } finally {
    console.error = quiet;
  }
});

Deno.test("a dead subscription is removed; without push keys nothing is sent", async () => {
  const deleted: string[] = [];
  const db = { from: () => ({ delete: () => ({ eq: async (_: string, id: string) => (deleted.push(id), { error: null }) }) }) };
  const subs: Subscription[] = [{ id: "dead", endpoint: "e", p256dh: "k", auth: "a" }, { id: "live", endpoint: "e2", p256dh: "k", auth: "a" }];
  const delivered = await sendToAllSubscriptions(db, subs, {}, async (sub) => {
    if (sub.id === "dead") throw Object.assign(new Error("gone"), { statusCode: 410 });
  });
  assertEquals([delivered, deleted], [true, ["dead"]]);
  const log = console.log;
  console.log = () => {};
  try {
    assertEquals(await sendToAllSubscriptions(db, subs, {}, null), false);
  } finally {
    console.log = log;
  }
});

const TODAY = new Date("2026-10-23T09:00:00Z");
const acc = (user_id: string, label: string | null, consent_valid_until: string | null, bank_name?: string) => ({ user_id, label, consent_valid_until, bank_name });

Deno.test("a bank is announced on 14, 7, 1 and 0 days left; its accounts share one consent", () => {
  assertEquals(consentNotices([
    acc("u1", "Revolut EUR", "2026-10-30T00:00:00Z"),
    acc("u1", "Revolut GBP", "2026-11-05T00:00:00Z"),
    acc("u1", "Fineco", "2026-10-24T00:00:00Z"),
    acc("u2", "Wise EUR", "2026-10-23T12:00:00Z"),
    acc("u2", "N26", "2026-10-27T00:00:00Z"),
    acc("u3", "N26 EUR", "2026-11-06T00:00:00Z"),
    acc("u4", "Cash", null),
  ], TODAY), [
    { user_id: "u1", banks: [{ bank: "Fineco", daysLeft: 1 }, { bank: "Revolut", daysLeft: 7 }] },
    { user_id: "u2", banks: [{ bank: "Wise", daysLeft: 0 }] },
    { user_id: "u3", banks: [{ bank: "N26", daysLeft: 14 }] },
  ]);
});

Deno.test("the stored bank name groups accounts whose holder labels differ", () => {
  assertEquals(consentNotices([
    acc("u1", "Marco D'Onghia", "2026-10-30T00:00:00Z", "Revolut"),
    acc("u1", "D'ONGHIA MARCO", "2026-10-24T00:00:00Z", "Revolut"),
  ], TODAY), [{ user_id: "u1", banks: [{ bank: "Revolut", daysLeft: 1 }] }]);
});

Deno.test("the consent push names the bank and opens the Accounts page", () => {
  assertEquals(buildConsentPayload([{ bank: "Revolut", daysLeft: 7 }]), { title: "Renew bank access", body: "Revolut stops syncing in 7 days. Tap to renew.", url: "/accounts" });
  assertEquals(buildConsentPayload([{ bank: "Wise", daysLeft: 0 }, { bank: "Fineco", daysLeft: 1 }]).body, "Wise stops syncing today, Fineco tomorrow. Tap to renew.");
});

Deno.test("runConsent reminds only users with a subscription, and counts deliveries", async () => {
  const db = {
    from: (table: string) => {
      if (table === "accounts") return { select: () => ({ not: async () => ({ data: [acc("u1", "Revolut EUR", "2026-10-30T00:00:00Z"), acc("u2", "Wise EUR", "2026-10-23T00:00:00Z")], error: null }) }) };
      return { select: () => ({ eq: async (_: string, id: string) => ({ data: id === "u1" ? [{ id: "s", endpoint: "e", p256dh: "k", auth: "a" }] : [], error: null }) }) };
    },
  };
  const sent: string[] = [];
  assertEquals(await runConsent(db, async (_s, payload) => void sent.push(JSON.parse(payload).body), TODAY), { reminded: 1 });
  assert(sent[0].startsWith("Revolut stops syncing in 7 days"));
});
