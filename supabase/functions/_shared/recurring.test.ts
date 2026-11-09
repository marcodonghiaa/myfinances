import { assertEquals, assertObjectMatch } from "jsr:@std/assert@1";
import { type Charge, detectStreams, RHYTHM_ONLY_DENY } from "./recurring.ts";
import cases from "./recurring.cases.json" with { type: "json" };

const DEFAULTS: Charge = {
  account_uid: "acc-1",
  merchant_key: "streamflix",
  currency: "EUR",
  amount: 1,
  amount_eur: null,
  booking_date: "2026-01-01",
  category: "Entertainment",
  custom_name: null,
  creditor_name: "SYNTHETIC MERCHANT",
  bank_transaction_code: null,
  flow_type: "spend",
  credit_debit_indicator: "DBIT",
  deleted_at: null,
};

type Case = {
  name: string;
  today?: string;
  base?: Partial<Charge>;
  dates?: string[];
  charges?: Partial<Charge>[];
  expect: Record<string, unknown>[];
};

function charge(...parts: Partial<Charge>[]): Charge {
  const c = Object.assign({}, DEFAULTS, ...parts);
  return { ...c, amount_eur: c.amount_eur ?? c.amount };
}

for (const c of cases as Case[]) {
  Deno.test(`detectStreams: ${c.name}`, () => {
    const charges = [
      ...(c.dates ?? []).map((d) => charge(c.base ?? {}, { booking_date: d })),
      ...(c.charges ?? []).map((x) => charge(c.base ?? {}, x)),
    ];
    const got = detectStreams(charges, c.today ?? "2026-11-08")
      .sort((a, b) => a.stream_key.localeCompare(b.stream_key));
    assertEquals(got.length, c.expect.length, JSON.stringify(got));
    c.expect.forEach((e, i) => assertObjectMatch(got[i], e));
  });
}

Deno.test("detectStreams emits exactly the detector columns", () => {
  const rows = detectStreams(
    ["2026-08-05", "2026-09-05", "2026-10-05"].map((d) =>
      charge({
        booking_date: d,
        amount: 12.99,
        amount_eur: 12.99,
        creditor_name: "STREAMFLIX",
        transaction_type: "Subscription",
      })
    ),
    "2026-11-08",
  );
  assertEquals(rows, [{
    stream_key: "streamflix|acc-1",
    merchant_key: "streamflix",
    account_uid: "acc-1",
    currency: "EUR",
    display_name: "STREAMFLIX",
    category: "Entertainment",
    cadence: "monthly",
    typical_amount: 12.99,
    typical_amount_eur: 12.99,
    charge_count: 3,
    first_charged: "2026-08-05",
    last_charged: "2026-10-05",
    next_expected: "2026-11-05",
    detected_status: "active",
    is_direct_debit: false,
  }]);
});

Deno.test("detectStreams is order-independent", () => {
  const charges = ["2026-10-05", "2026-08-05", "2026-09-05"].map((d) => charge({ booking_date: d, amount: 5 }));
  assertEquals(detectStreams(charges, "2026-11-08"), detectStreams([...charges].reverse(), "2026-11-08"));
});

// protects=upsert_detected_streams gets one row per (user_id, stream_key); fails_when=two clusters share a key
Deno.test("stream_key is unique within one result", () => {
  const amounts = [0.99, 1.09, 1.2, 1.32, 2.99, 3.29, 9.99, 10.99, 12.09];
  const charges = amounts.flatMap((amount) =>
    ["2026-08-03", "2026-09-03", "2026-10-03"].map((d) => charge({ merchant_key: "apple", booking_date: d, amount }))
  );
  const keys = detectStreams(charges, "2026-11-08").map((r) => r.stream_key);
  assertEquals(keys.length > 1, true);
  assertEquals(new Set(keys).size, keys.length, JSON.stringify(keys));
  for (const c of cases as Case[]) {
    const all = [
      ...(c.dates ?? []).map((d) => charge(c.base ?? {}, { booking_date: d })),
      ...(c.charges ?? []).map((x) => charge(c.base ?? {}, x)),
    ];
    const k = detectStreams(all, c.today ?? "2026-11-08").map((r) => r.stream_key);
    assertEquals(new Set(k).size, k.length, c.name);
  }
});

// protects=user choices on an aggregator stream; fails_when=the key follows the median as prices rise
Deno.test("an aggregator price rise keeps the same stream_key across runs", () => {
  const history = [
    ["2026-06-03", 9.99],
    ["2026-07-03", 9.99],
    ["2026-08-03", 10.49],
    ["2026-09-03", 10.49],
    ["2026-10-03", 10.49],
  ].map(([d, amount]) =>
    charge({ merchant_key: "apple", booking_date: d as string, amount: amount as number, transaction_type: "Subscription" })
  );
  for (let n = 2; n <= history.length; n++) {
    assertEquals(detectStreams(history.slice(0, n), "2026-11-08").map((r) => r.stream_key), [
      "apple|acc-1|9.99",
    ]);
  }
});

// protects=R3 rhythm-only deny list and the tagged cap; fails_when=a category is dropped or the list stops applying
Deno.test("an everyday category is never proposed by rhythm alone and never auto-active", () => {
  assertEquals([...RHYTHM_ONLY_DENY].sort(), ["Dine Out", "Experiences", "Groceries", "Shopping", "Transports"]);
  for (const category of RHYTHM_ONLY_DENY) {
    const charges = ["2026-08-05", "2026-09-05", "2026-10-05"].map((d) => charge({ booking_date: d, category }));
    assertEquals(detectStreams(charges, "2026-11-08"), [], category);
    const tagged = charges.map((c) => ({ ...c, transaction_type: "Subscription" }));
    assertEquals(detectStreams(tagged, "2026-11-08").map((r) => r.detected_status), ["suggested"], category);
  }
});
