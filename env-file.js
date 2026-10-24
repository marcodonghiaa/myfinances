const fs = require('fs');

// setup.sh re-runs on an existing install: it reads the values already in .env and merges
// the new ones in, so keys it doesn't manage (Coinbase, GEMINI_MODEL, comments) survive.
function mergeEnv(text, updates) {
  const pending = new Map(Object.entries(updates));
  const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n');
  const merged = lines.map((line) => {
    const key = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/)?.[1];
    if (!key || !pending.has(key)) return line;
    const value = pending.get(key);
    pending.delete(key);
    return `${key}=${value}`;
  });
  for (const [key, value] of pending) merged.push(`${key}=${value}`);
  return `${merged.join('\n')}\n`;
}

const readText = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');

// Minimal KEY=VALUE reader (surrounding quotes stripped). setup.sh runs before `npm install`,
// so this can't depend on dotenv.
function parseEnv(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

module.exports = { mergeEnv, parseEnv };

// node env-file.js get <file> <KEY>     prints the value ('' if unset)
// node env-file.js merge <file> <updates-file>   merges KEY=value lines from updates-file into file
if (require.main === module) {
  const [cmd, file, arg] = process.argv.slice(2);
  if (cmd === 'get') {
    process.stdout.write(parseEnv(readText(file))[arg] ?? '');
  } else if (cmd === 'merge') {
    fs.writeFileSync(file, mergeEnv(readText(file), parseEnv(readText(arg))), { mode: 0o600 });
  } else {
    console.error('usage: node env-file.js get <file> <KEY> | merge <file> <updates-file>');
    process.exit(1);
  }
}
