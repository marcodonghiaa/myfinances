import { assertEquals } from "jsr:@std/assert@1.0.19";
import { createStallGuard } from "./stall-guard.ts";

const rows = (user_id: string, ...refs: string[]) => refs.map((r) => ({ user_id, account_uid: "acc", entry_reference: r }));

Deno.test("the same batch twice in a row is a stall and marks only that user stuck", () => {
  const guard = createStallGuard();
  assertEquals(guard.isStalled(rows("a", "1")), false);
  assertEquals(guard.isStalled(rows("a", "1")), true);
  assertEquals(guard.isStalled(rows("b", "1")), false);
  assertEquals([...guard.stuckUserIds], ["a"]);
});

Deno.test("a different batch means progress", () => {
  const guard = createStallGuard();
  guard.isStalled(rows("a", "1", "2"));
  assertEquals(guard.isStalled(rows("a", "2")), false);
  assertEquals(guard.stuckUserIds.size, 0);
});
