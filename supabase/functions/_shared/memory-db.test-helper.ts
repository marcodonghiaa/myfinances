// In-memory stand-in for the supabase query builder, for tests: honors the filters the
// post-sync steps use (is/eq/in/not/gte, filter match, order, limit, range) and applies updates and deletes to the
// matching rows, so tests check data, not call shapes.
// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

export function memoryDb(tables: Record<string, Row[]>) {
  return {
    tables,
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      const orders: Array<[string, boolean]> = [];
      let patch: Row | null = null;
      let remove = false;
      let window: [number, number] = [0, Infinity];
      const q = {
        select: () => q,
        update: (u: Row) => ((patch = u), q),
        delete: () => ((remove = true), q),
        is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), q),
        eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
        in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), q),
        filter: (c: string, op: "match", v: string) => (filters.push((r) => r[c] != null && new RegExp(v).test(r[c])), q),
        gte: (c: string, v: string) => (filters.push((r) => r[c] >= v), q),
        not: (c: string, op: string, v: unknown) => {
          if (op === "is") filters.push((r) => (r[c] ?? null) !== v);
          else filters.push((r) => !String(v).slice(1, -1).split(",").includes(r[c]));
          return q;
        },
        order: (c: string, o?: { ascending?: boolean }) => (orders.push([c, o?.ascending !== false]), q),
        limit: (n: number) => ((window = [0, n - 1]), q),
        range: (a: number, b: number) => ((window = [a, b]), q),
        then(resolve: (v: unknown) => void) {
          const rows = (tables[table] ??= []).filter((r) => filters.every((f) => f(r)));
          if (remove) {
            tables[table] = tables[table].filter((r) => !rows.includes(r));
            return resolve({ data: null, error: null });
          }
          if (patch) {
            for (const r of rows) Object.assign(r, patch);
            return resolve({ data: null, error: null });
          }
          rows.sort((a, b) => {
            for (const [c, asc] of orders) if (a[c] !== b[c]) return (a[c] < b[c] ? -1 : 1) * (asc ? 1 : -1);
            return 0;
          });
          resolve({ data: rows.slice(window[0], window[1] + 1).map((r) => ({ ...r })), error: null });
        },
      };
      return q;
    },
  };
}
