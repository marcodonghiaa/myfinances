const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { fetchWithTimeout } = require('./http');

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

test('returns the response when the server answers in time', async () => {
  const { server, url } = await serve((req, res) => res.end('ok'));
  try {
    const res = await fetchWithTimeout(url, {}, 1000);
    assert.strictEqual(await res.text(), 'ok');
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('aborts a request the server never answers', async () => {
  const { server, url } = await serve(() => {}); // accepts the connection, never responds
  try {
    await assert.rejects(() => fetchWithTimeout(url, {}, 100), { name: 'AbortError' });
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
