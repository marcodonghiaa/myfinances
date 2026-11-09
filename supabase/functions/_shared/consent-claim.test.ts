import { assertEquals } from "jsr:@std/assert@1";
import { CLAIM_FAILED, claimConsent, EXPIRED_CONSENT, INVALID_CONSENT, isConsentInput } from "./consent-claim.ts";

const STATE = "0b0e6a4e-1f7e-4f43-9d0c-2b1c9a7d5e11";
const NOW = Date.parse("2026-11-09T12:00:00Z");

// A fake for delete().eq().select().maybeSingle() that returns `row` and records the id deleted.
function fakeDb(row: unknown, error: unknown = null) {
  const deleted: string[] = [];
  const db = {
    from: (table: string) => {
      assertEquals(table, "pending_bank_consents");
      return {
        delete: () => ({
          eq: (_col: string, id: string) => {
            deleted.push(id);
            return { select: () => ({ maybeSingle: () => Promise.resolve({ data: row, error }) }) };
          },
        }),
      };
    },
  };
  return { db, deleted };
}

Deno.test("the user who started the link claims it, and the row is consumed", async () => {
  const { db, deleted } = fakeDb({ user_id: "u1", created_at: "2026-11-09T11:55:00Z" });
  assertEquals(await claimConsent(db, STATE, "u1", NOW), { ok: true });
  assertEquals(deleted, [STATE]);
});

Deno.test("another user's state links nothing (RLS finds no row)", async () => {
  const { db } = fakeDb(null);
  assertEquals(await claimConsent(db, STATE, "u2", NOW), { error: INVALID_CONSENT });
});

Deno.test("a row for another user is refused even with a client that bypasses RLS", async () => {
  const { db } = fakeDb({ user_id: "u1", created_at: "2026-11-09T11:55:00Z" });
  assertEquals(await claimConsent(db, STATE, "u2", NOW), { error: INVALID_CONSENT });
});

// protects=a user's own code; fails_when=a database hiccup is reported as a refusal (and burned).
Deno.test("a database error is transient, not a refusal", async () => {
  const { db } = fakeDb(null, { code: "XX000" });
  assertEquals(await claimConsent(db, STATE, "u1", NOW), { error: CLAIM_FAILED, transient: true });
});

Deno.test("a link older than 15 minutes has expired", async () => {
  const { db } = fakeDb({ user_id: "u1", created_at: "2026-11-09T11:44:00Z" });
  assertEquals(await claimConsent(db, STATE, "u1", NOW), { error: EXPIRED_CONSENT });
});

Deno.test("isConsentInput needs a code and a uuid state", () => {
  assertEquals(isConsentInput({ code: "abc", state: STATE }), true);
  assertEquals(isConsentInput({ code: "", state: STATE }), false);
  assertEquals(isConsentInput({ code: "abc", state: "not-a-uuid" }), false);
  assertEquals(isConsentInput({ code: "x".repeat(2049), state: STATE }), false);
  assertEquals(isConsentInput(null), false);
});
