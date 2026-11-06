// Deno port of stall-guard.js. Same batch back twice in a row means nothing got written for that
// user (bad AI answer, failed update). Mark them stuck so the run moves on to other users instead
// of looping, re-billing the LLM, or stopping everyone's work.
export function createStallGuard() {
  const stuckUserIds = new Set<string>();
  let lastKey: string | null = null;
  return {
    stuckUserIds,
    isStalled(rows: Array<{ user_id: string; account_uid: string; entry_reference: string }>): boolean {
      const key = rows.map((r) => `${r.account_uid}:${r.entry_reference}`).join();
      if (key !== lastKey) {
        lastKey = key;
        return false;
      }
      stuckUserIds.add(rows[0].user_id);
      lastKey = null;
      return true;
    },
  };
}
