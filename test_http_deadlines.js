const assert = require('assert');
const http = require('http');
const {
  fetchJsonWithTimeout,
  fetchTextWithTimeout,
  fetchWithTimeout
} = require('./src/http');

// A host that returns headers promptly and then stalls on the body is the failure
// these cover. It is invisible to a headers-only deadline, which is why buffering
// callers need a deadline that spans the body and streaming callers do not.

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, () => resolve(server));
  });
}

const url = (server, path = '/') => `http://127.0.0.1:${server.address().port}${path}`;

// Headers immediately, then the body never completes.
function stallingBodyHandler(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.write('<html>');
}

async function testTextTimeoutCoversBody() {
  const server = await startServer(stallingBodyHandler);
  try {
    const startedAt = Date.now();
    await assert.rejects(
      () => fetchTextWithTimeout(url(server), {}, 700),
      /Fetch timeout after 700ms/,
      'a stalled body must trip the deadline, not hang'
    );
    const elapsed = Date.now() - startedAt;
    assert(elapsed < 3000, `must give up near the deadline (took ${elapsed}ms)`);
  } finally {
    server.close();
  }
}

async function testCallerSignalCancelsBody() {
  const server = await startServer(stallingBodyHandler);
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);

    const startedAt = Date.now();
    await assert.rejects(
      () => fetchTextWithTimeout(url(server), { signal: controller.signal }, 30000),
      /Fetch aborted:/,
      "the caller's signal must still reach a body that has already started"
    );
    const elapsed = Date.now() - startedAt;
    assert(elapsed < 3000, `abort must take effect promptly (took ${elapsed}ms)`);
  } finally {
    server.close();
  }
}

async function testJsonParsingAndErrorBodies() {
  const server = await startServer((req, res) => {
    if (req.url === '/bad') {
      res.writeHead(500, { 'Content-Type': 'text/html' });
      return res.end('<html>gateway blew up</html>');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ url: 'https://cdn.example/master.m3u8' }));
  });

  try {
    const ok = await fetchJsonWithTimeout(url(server, '/good'), {}, 3000);
    assert.strictEqual(ok.res.ok, true);
    assert.strictEqual(ok.data.url, 'https://cdn.example/master.m3u8', 'valid JSON is parsed');

    // An HTML error page must surface as the real status, not a parse throw.
    const bad = await fetchJsonWithTimeout(url(server, '/bad'), {}, 3000);
    assert.strictEqual(bad.res.status, 500, 'status stays inspectable');
    assert.strictEqual(bad.data, null, 'unparseable body yields null rather than throwing');
  } finally {
    server.close();
  }
}

// fetchWithTimeout must keep its headers-only deadline: /proxy streams movie
// bodies for minutes, and extending the deadline over the body would abort them.
async function testStreamingDeadlineStopsAtHeaders() {
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'video/mp4' });
    let sent = 0;
    const timer = setInterval(() => {
      if (sent++ >= 40) {
        clearInterval(timer);
        return res.end();
      }
      res.write(chunk);
    }, 50);
    res.on('close', () => clearInterval(timer));
  });

  try {
    // Body takes ~2s, well past the 400ms headers deadline.
    const res = await fetchWithTimeout(url(server), {}, 400);
    const received = Buffer.from(await res.arrayBuffer());
    assert.strictEqual(
      received.length,
      40 * chunk.length,
      'a slow body must still stream to completion under a headers-only deadline'
    );
  } finally {
    server.close();
  }
}

async function main() {
  await testTextTimeoutCoversBody();
  await testCallerSignalCancelsBody();
  await testJsonParsingAndErrorBodies();
  await testStreamingDeadlineStopsAtHeaders();
  console.log('HTTP deadline tests passed');
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
