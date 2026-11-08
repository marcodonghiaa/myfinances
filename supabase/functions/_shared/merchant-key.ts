// Normalizes a bank creditor name into a stable grouping key (see merchant-key.cases.json).
type Aggregator = "paypal" | "apple" | "google";

const COUNTRIES = new Set("it de lu ie se gb nl lt es be fr pl us".split(" "));
const LEGAL_FORMS = new Set("spa srl srls snc sas ltd inc gmbh".split(" "));

export function normalizeMerchant(
  creditorName: string | null,
): { key: string | null; aggregator: Aggregator | null } {
  const raw = (creditorName ?? "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().trim();
  if (!raw) return { key: null, aggregator: null };

  const aggregator: Aggregator | null = raw.startsWith("apple.com/bill")
    ? "apple"
    : raw.startsWith("google *")
    ? "google"
    : /^paypal \*(p[0-9a-f]{6,}\b|.*visa direct)/.test(raw)
    ? "paypal"
    : null;
  if (aggregator) return { key: aggregator, aggregator };

  const s = raw
    .replace(/^(paypal|sumup|[a-z0-9]{1,4}) ?\*/, "")
    .replace(/^www\./, "")
    .split("*")[0]
    .split(" - ")[0];

  // A later token with a digit, "/" or "." (id, url, domain) ends the name; a dotted first token is a domain.
  const out: string[] = [];
  for (const [i, t] of s.trim().split(/\s+/).entries()) {
    if (i > 0 && /[\d/.]/.test(t)) break;
    if (i === 0 && t.includes(".")) {
      out.push(t.split(".")[0]);
      break;
    }
    out.push(t);
  }

  if (COUNTRIES.has(out[out.length - 1])) {
    out.pop();
    if (out.length > 1) out.pop(); // city
  }
  while (LEGAL_FORMS.has(out[out.length - 1])) out.pop();

  return { key: out.join(" ").trim() || raw, aggregator: null };
}
