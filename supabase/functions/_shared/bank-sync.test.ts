import { assert, assertEquals } from "jsr:@std/assert@1";
import { type Deps, syncAccountBalance, syncAccountTransactions } from "./bank-sync.ts";

const EB = "https://api.enablebanking.com/accounts";
const TODAY = "2026-10-27";
const TX = {
  entry_reference: "r1",
  transaction_amount: { amount: "-3.20", currency: "EUR" },
  credit_debit_indicator: "DBIT",
  booking_date: "2026-10-26",
  value_date: "2026-10-26",
};
const BALANCES = { balances: [{ balance_amount: { amount: "12.50", currency: "EUR" } }] };
const EXPIRED = { code: 401, message: "Session is expired", error: "EXPIRED_SESSION", detail: null };
const account = (over = {}) => ({ uid: "pk", user_id: "user", eb_account_uid: "eb", identification_hash: "h", ...over });

type FakeRes = { ok?: boolean; status?: number; body?: unknown };

// Answers by URL substring; records every URL called.
function fakeFetch(responses: Record<string, FakeRes>) {
  const urls: string[] = [];
  const fetch = (async (url: string) => {
    urls.push(url);
    const key = Object.keys(responses).find((part) => url.includes(part));
    assert(key, `unexpected URL ${url}`);
    const res = responses[key];
    return { ok: true, status: 200, ...res, json: async () => res.body ?? JSON.parse("not json") };
  }) as unknown as Deps["fetch"];
  return { fetch, urls };
}

// Records .upsert(rows, opts) and .update(patch) with its .eq / .is filter chain, once awaited.
function fakeSupabase(error: unknown = null) {
  const writes: { table: string; op: string; data: unknown; filters?: unknown[] }[] = [];
  const supabase = {
    from: (table: string) => ({
      upsert: async (data: unknown, opts: unknown) => (writes.push({ table, op: "upsert", data, filters: [opts] }), { error }),
      update: (data: unknown) => {
        const filters: unknown[] = [];
        const query = {
          eq: (col: string, val: unknown) => (filters.push(["eq", col, val]), query),
          is: (col: string, val: unknown) => (filters.push(["is", col, val]), query),
          then: (resolve: (v: unknown) => void) => (writes.push({ table, op: "update", data, filters }), resolve({ error })),
        };
        return query;
      },
    }),
  };
  return { supabase, writes };
}

Deno.test("transactions: calls EB with eb_account_uid; rows and cursor use uid", async () => {
  const { fetch, urls } = fakeFetch({ "/transactions?": { body: { transactions: [TX] } } });
  const { supabase, writes } = fakeSupabase();

  const result = await syncAccountTransactions({ fetch, supabase }, "t", account(), null, TODAY);

  assertEquals(urls.length, 1);
  assert(urls[0].startsWith(`${EB}/eb/transactions?`));
  assertEquals(writes[0].filters, [{ onConflict: "account_uid,entry_reference" }]);
  assert((writes[0].data as { account_uid: string }[]).every((row) => row.account_uid === "pk"));
  assertEquals(result, { upserted: 1, rejected: null, cursor: TODAY });
});

Deno.test("transactions: date_from re-reads 7 days before the cursor", async () => {
  const { fetch, urls } = fakeFetch({ "/transactions?": { body: { transactions: [] } } });
  const { supabase, writes } = fakeSupabase();

  const result = await syncAccountTransactions({ fetch, supabase }, "t", account(), "2026-10-20", TODAY);

  assert(urls[0].includes("date_from=2026-10-13"));
  assertEquals(writes, []);
  assertEquals(result.cursor, TODAY); // no new rows still advances the cursor
});

Deno.test("transactions: follows continuation_key across pages", async () => {
  let page = 0;
  const fetch = (async (url: string) => {
    page++;
    const body = page === 1
      ? { transactions: [TX], continuation_key: "k2" }
      : { transactions: [{ ...TX, entry_reference: "r2" }] };
    if (page === 2) assert(url.includes("continuation_key=k2"));
    return { ok: true, status: 200, json: async () => body };
  }) as unknown as Deps["fetch"];
  const { supabase } = fakeSupabase();

  const result = await syncAccountTransactions({ fetch, supabase }, "t", account(), null, TODAY);

  assertEquals(result.upserted, 2);
});

Deno.test("transactions: a 404 is rejected and the cursor stays", async () => {
  const { fetch } = fakeFetch({ "/transactions?": { ok: false, status: 404 } });
  const { supabase, writes } = fakeSupabase();

  const result = await syncAccountTransactions({ fetch, supabase }, "t", account(), "2026-10-20", TODAY);

  assertEquals(result, { upserted: 0, rejected: 404, cursor: null });
  assertEquals(writes, []);
});

Deno.test("transactions: a failed upsert leaves the cursor", async () => {
  const { fetch } = fakeFetch({ "/transactions?": { body: { transactions: [TX] } } });
  const { supabase } = fakeSupabase({ code: "42501" });

  const result = await syncAccountTransactions({ fetch, supabase }, "t", account(), "2026-10-20", TODAY);

  assertEquals(result, { upserted: 0, rejected: null, cursor: null });
});

Deno.test("balance: calls EB with eb_account_uid and builds the row under uid", async () => {
  const { fetch, urls } = fakeFetch({ "/balances": { body: BALANCES } });
  const { supabase } = fakeSupabase();

  const { row, rejected } = await syncAccountBalance({ fetch, supabase }, "t", account(), TODAY);

  assertEquals(urls, [`${EB}/eb/balances`]);
  assertEquals(row, { account_uid: "pk", currency: "EUR", amount: 12.5, snapshot_date: TODAY, user_id: "user" });
  assertEquals(rejected, null);
});

Deno.test("balance: fills a missing hash once, then fetches the balance", async () => {
  const { fetch, urls } = fakeFetch({
    "/details": { body: { identification_hash: "h", account_id: { iban: "IT1" } } },
    "/balances": { body: BALANCES },
  });
  const { supabase, writes } = fakeSupabase();

  const { row } = await syncAccountBalance({ fetch, supabase }, "t", account({ identification_hash: null }), TODAY);

  assertEquals(urls, [`${EB}/eb/details`, `${EB}/eb/balances`]);
  assertEquals(writes, [
    { table: "accounts", op: "update", data: { identification_hash: "h", iban: "IT1" }, filters: [["eq", "uid", "pk"]] },
  ]);
  assertEquals(row?.account_uid, "pk");
});

Deno.test("balance: a 429 on details still returns the balance", async () => {
  const { fetch } = fakeFetch({ "/details": { ok: false, status: 429 }, "/balances": { body: BALANCES } });
  const { supabase, writes } = fakeSupabase();

  const { row } = await syncAccountBalance({ fetch, supabase }, "t", account({ identification_hash: null }), TODAY);

  assertEquals(writes, []);
  assert(row);
});

Deno.test("balance: EXPIRED_SESSION marks the consent as ending today (compare-and-set)", async () => {
  const { fetch } = fakeFetch({ "/balances": { ok: false, status: 401, body: EXPIRED } });
  const { supabase, writes } = fakeSupabase();
  const consent = "2027-03-06T00:00:00+00:00";

  const result = await syncAccountBalance({ fetch, supabase }, "t", account({ consent_valid_until: consent }), TODAY);

  assertEquals(writes, [{
    table: "accounts",
    op: "update",
    data: { consent_valid_until: TODAY },
    filters: [["eq", "uid", "pk"], ["eq", "consent_valid_until", consent]],
  }]);
  assertEquals(result, { row: null, rejected: 401, renewed: true, ebFailed: true });
});

Deno.test("balance: a 429 on balances reports ebFailed so the caller stops", async () => {
  const { fetch } = fakeFetch({ "/balances": { ok: false, status: 429 } });
  const { supabase } = fakeSupabase();

  const result = await syncAccountBalance({ fetch, supabase }, "t", account(), TODAY);

  assertEquals(result, { row: null, rejected: null, renewed: false, ebFailed: true });
});

Deno.test("balance: EXPIRED_SESSION never moves an earlier consent date later", async () => {
  const { fetch } = fakeFetch({ "/balances": { ok: false, status: 401, body: EXPIRED } });
  const { supabase, writes } = fakeSupabase();
  for (const consent_valid_until of ["2026-10-27T00:00:00+00:00", "2026-10-01T00:00:00+00:00"]) {
    await syncAccountBalance({ fetch, supabase }, "t", account({ consent_valid_until }), TODAY);
  }
  assertEquals(writes, []);
});

Deno.test("balance: a 401 that is not EXPIRED_SESSION, or not JSON, leaves the date alone", async () => {
  for (const body of [{ ...EXPIRED, error: "UNAUTHORIZED" }, { ...EXPIRED, error: "bad text <x>" }, undefined]) {
    const { fetch } = fakeFetch({ "/balances": { ok: false, status: 401, body } });
    const { supabase, writes } = fakeSupabase();
    const result = await syncAccountBalance({ fetch, supabase }, "t", account({ consent_valid_until: null }), TODAY);
    assertEquals(writes, []);
    assertEquals(result.rejected, 401);
  }
});
