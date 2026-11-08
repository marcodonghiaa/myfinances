// Normalizes a bank creditor name into a stable grouping key (see merchant-key.cases.json).
type Aggregator = "paypal" | "apple" | "google";

const COUNTRIES = new Set("it de lu ie se gb nl lt es be fr pl us".split(" "));
const LEGAL_FORMS = new Set("spa srl srls snc sas ltd inc gmbh doo pte".split(" "));
// A domain token, also with an id glued on ("bolt.euo2601011200").
const DOMAIN = /^[a-z0-9-]+\.(com|it|io|eu|net|org|co|uk|de|fr|es|nl|dev|app|in|me|tv)(\b|[a-z]*\d)/;
const GENERIC = new Set(
  ("bar caffe caffetteria cafe coffee gelateria cremeria pizzeria ristorante trattoria osteria hotel albergo hostel " +
    "farmacia tabaccheria tabacchi alimentari supermercato market minimarket pub bistrot panificio pasticceria " +
    "macelleria piadineria kebab sushi mensa kiosco edicola barbiere barber cinema taxi parcheggio parking " +
    "distributore lavanderia ristobar snack enoteca forno panetteria palestra parrucchiere rosticceria birreria " +
    "paninoteca focacceria friggitoria creperia bakery deli diner restaurant").split(" "),
);

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
    .replace(/^(paypal|pp|sumup|sq|tst|py|mgp|ubr|eb|mne|nyx|zettle_|iz|satispay|nexi|stripe|square)\s*\*/, "")
    .replace(/^[^*\s]{1,3}\s*\*\s*(?=\p{L}{3})/u, "") // unknown short processor code ("xyz*acme studio")
    .replace(/^www\./, "");

  // A domain ends the name; after the first token, so does a token with a digit, "/" or "." (id, url, "S.R.L.").
  const out: string[] = [];
  let dotCut = false;
  for (const [i, t] of s.split("*")[0].split(" - ")[0].trim().split(/\s+/).entries()) {
    if (DOMAIN.test(t)) {
      if (i === 0) out.push(t.split(".")[0]);
      break;
    }
    if (i > 0 && /[\d/.]/.test(t)) {
      dotCut = t.includes(".");
      break;
    }
    out.push(t);
  }

  // Known limitation: a bare "<name> <name> <CC>" (e.g. "Amazon Prime LU") loses the second word as a city.
  if (COUNTRIES.has(out[out.length - 1])) {
    out.pop();
    if (out.length > 1) out.pop(); // city
  }
  const key = trimTail(out).join(" ").replace(/\.$/, "");
  // "Bar Sport Milano" and "Bar Sport Roma" must not merge, nor "Mario D.Rossi" become "mario": keep every token instead.
  const full = GENERIC.has(out[0]) || key.length <= 2 || (dotCut && out.length === 1) ? s.trim().split(/\s+/) : null;
  if (full && COUNTRIES.has(full[full.length - 1])) full.pop();

  return { key: (full ? trimTail(full).join(" ").replace(/\.$/, "") : key).trim() || raw.replace(/\s+/g, " "), aggregator: null };
}

function trimTail(tokens: string[]) {
  while (tokens.length && LEGAL_FORMS.has(tokens[tokens.length - 1].replaceAll(".", ""))) tokens.pop();
  return tokens;
}
