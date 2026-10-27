// The dashboard address setup.sh stores as FRONTEND_URL. Bank linking redirects there and
// the Edge Functions' CORS check exact-matches it against the browser's Origin header, so
// only the origin is kept (no path, no trailing slash, lowercase host).
const REJECT_MESSAGE = "Use your dashboard's https address, e.g. https://my-finances.vercel.app";
// Vercel also serves every deployment and branch at its own address; those stop matching
// the next time you deploy, and bank linking breaks with them.
const WARNING_MESSAGE =
  'That looks like the address of one Vercel deployment or branch: it changes on the next deploy. ' +
  'Use the address under Vercel -> your project -> Settings -> Domains.';
const DEPLOYMENT_HOSTS = [/-[a-z0-9]{9}-[a-z0-9-]+\.vercel\.app$/, /-git-[a-z0-9-]+\.vercel\.app$/];

function normalizeFrontendUrl(input) {
  let url;
  try {
    url = new URL(String(input).trim());
  } catch {
    throw new Error(REJECT_MESSAGE);
  }
  const isLocal = url.protocol === 'http:' && url.hostname === 'localhost' && url.port !== '';
  if (url.protocol !== 'https:' && !isLocal) throw new Error(REJECT_MESSAGE);
  const warning = DEPLOYMENT_HOSTS.some((re) => re.test(url.hostname)) ? WARNING_MESSAGE : null;
  return { origin: url.origin, warning };
}

module.exports = { normalizeFrontendUrl, REJECT_MESSAGE, WARNING_MESSAGE };

// node frontend-url.js <url>   prints the origin; exit 0 ok, 1 rejected, 3 warned (warning on stderr)
if (require.main === module) {
  let result;
  try {
    result = normalizeFrontendUrl(process.argv[2] ?? '');
  } catch {
    process.stderr.write(REJECT_MESSAGE + '\n');
    process.exit(1);
  }
  process.stdout.write(result.origin + '\n');
  if (result.warning) {
    process.stderr.write(WARNING_MESSAGE + '\n');
    process.exit(3);
  }
}
