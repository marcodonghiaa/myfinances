// What a script may print about an error: a code, an HTTP status or a class name. Never the
// message, details or hint: those can carry names, IBANs, amounts or a raw response body,
// and a fork's GitHub Actions logs are public.
function errorTag(err) {
  if (typeof err?.code === 'string' && err.code) return err.code;
  if (typeof err?.status === 'number') return `HTTP ${err.status}`;
  if (typeof err?.name === 'string') return err.name;
  return 'Error';
}

module.exports = { errorTag };
