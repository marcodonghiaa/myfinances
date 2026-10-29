import { assert } from "jsr:@std/assert@1";
import { type Deps, syncAccountBalance, syncAccountTransactions } from "./bank-sync.ts";

// Runs the Deno sync (what sync-bank calls) against fake Enable Banking and Supabase answers
// seeded with unmistakable personal data, and fails if any of it reaches console.log/error/warn:
// Edge Function logs must stay free of names, IBANs, amounts and raw bank responses.
// Not covered: sync-bank/index.ts itself (Deno.serve + env), the other Edge Functions.

const FIXTURE = {
  holder: "Zzyzx Quibblethorpe",
  iban: "ZZ99LEAKGUARD00112233",
  merchant: "Qwertyuiop Emporium",
  remittance: "Invoice Plugh-5150",
  amount: "7777.77",
  balance: "4242.42",
};
const LEAK = Object.values(FIXTURE).join(" | ");
const TODAY = "2026-10-27";

const EB_OK: Record<string, unknown> = {
  details: { identification_hash: "h", name: FIXTURE.holder, account_id: { iban: FIXTURE.iban } },
  balances: { balances: [{ balance_amount: { amount: FIXTURE.balance, currency: "EUR" } }] },
  transactions: {
    transactions: [{
      entry_reference: "r1", booking_date: "2026-10-26", value_date: "2026-10-26",
      transaction_amount: { amount: `-${FIXTURE.amount}`, currency: "EUR" }, credit_debit_indicator: "DBIT",
      creditor: { name: FIXTURE.merchant }, debtor: { name: FIXTURE.holder },
      remittance_information: [FIXTURE.remittance],
    }],
  },
};
const EB_REJECTIONS = {
  bank_error: { status: 500, body: { error: `Bank said ${LEAK}`, message: LEAK } },
  expired: { status: 401, body: { code: 401, error: "EXPIRED_SESSION", message: LEAK, detail: LEAK } },
};

type Scenario = "ok" | "empty_balances" | "bank_error" | "expired" | "db_error";

function deps(scenario: Scenario): Deps {
  const rejection = EB_REJECTIONS[scenario as keyof typeof EB_REJECTIONS];
  const fetch = (async (url: string) => {
    const part = url.split("?")[0].split("/").pop()!;
    const body = scenario === "empty_balances" && part === "balances" ? { balances: [] } : EB_OK[part];
    if (rejection) return { ok: false, status: rejection.status, json: async () => rejection.body };
    return { ok: true, status: 200, json: async () => body };
  }) as unknown as Deps["fetch"];
  const result = { error: scenario === "db_error" ? { message: LEAK, details: LEAK, hint: LEAK } : null };
  const query = { eq: () => query, is: () => query, then: (resolve: (v: unknown) => void) => resolve(result) };
  const supabase = { from: () => ({ upsert: async () => result, update: () => query }) };
  return { fetch, supabase };
}

// Runs fn with console.log/error/warn/info captured; returns everything they were given.
async function captureConsole(fn: () => Promise<unknown>) {
  const lines: string[] = [];
  const saved = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const name of Object.keys(saved) as (keyof typeof saved)[]) {
    console[name] = (...args: unknown[]) => void lines.push(args.map((a) => (typeof a === "string" ? a : Deno.inspect(a))).join(" "));
  }
  try {
    await fn();
  } finally {
    Object.assign(console, saved);
  }
  return lines.join("\n");
}

const account = { uid: "pk", user_id: "user", eb_account_uid: "eb", identification_hash: null, consent_valid_until: "2026-12-01" };

const SCENARIOS: Scenario[] = ["ok", "empty_balances", "bank_error", "expired", "db_error"];
for (const scenario of SCENARIOS) {
  Deno.test(`leak guard: sync-bank code logs no fixture data (${scenario})`, async () => {
    const d = deps(scenario);
    const out = await captureConsole(async () => {
      await syncAccountBalance(d, "t", account, TODAY);
      await syncAccountTransactions(d, "t", account, null, TODAY);
    });
    for (const [key, value] of Object.entries(FIXTURE)) {
      assert(!out.toLowerCase().includes(value.toLowerCase()), `${key} leaked:\n${out}`);
    }
    // Anything but the happy path must say something, or the fixture never reached the code.
    if (scenario !== "ok") assert(out.trim(), "nothing was logged: the fixture is not reaching the code");
  });
}
