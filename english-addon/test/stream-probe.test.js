const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { probeStream } = require('../src/stream-probe');

let server;
let origin;

test.before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/video') {
      assert.equal(req.headers.range, 'bytes=0-2047');
      assert.equal(req.headers.referer, 'https://required.example/');
      res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 0-1/2' });
      return res.end('ok');
    }
    if (req.url === '/error-page') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<html>expired</html>');
    }
    res.writeHead(403, { 'Content-Type': 'video/mp4' });
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => new Promise((resolve) => server.close(resolve)));

test('accepts a reachable media response and forwards source headers', async () => {
  assert.equal(await probeStream({ url: `${origin}/video`, headers: { Referer: 'https://required.example/' } }), true);
});

test('rejects provider error pages and failing statuses', async () => {
  assert.equal(await probeStream({ url: `${origin}/error-page` }), false);
  assert.equal(await probeStream({ url: `${origin}/forbidden` }), false);
});
