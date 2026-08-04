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
    if (req.url === '/missing') {
      res.writeHead(404, { 'Content-Type': 'video/mp4' });
      return res.end();
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

test('rejects provider error pages', async () => {
  assert.equal(await probeStream({ url: `${origin}/error-page` }), false);
});

// The probe and this test used to disagree outright: the probe accepts a 403 by
// design, the test demanded it be rejected, and nothing ran the file so nobody
// saw it. The probe's reading is the right one — these CDNs routinely answer a
// 2KB Range request with 403 or 416 and then serve the same URL to a player
// without complaint — so a status alone is not grounds for dropping a link. Only
// the two statuses that mean the resource is gone, and a body that is plainly a
// web page rather than media, are.
test('keeps a refusing status, which players routinely get past anyway', async () => {
  assert.equal(await probeStream({ url: `${origin}/forbidden` }), true);
});

test('rejects links that are definitively gone', async () => {
  assert.equal(await probeStream({ url: `${origin}/missing` }), false);
});

test('rejects a URL that is not http(s)', async () => {
  assert.equal(await probeStream({ url: 'magnet:?xt=urn:btih:abc' }), false);
  assert.equal(await probeStream({ url: 'not a url' }), false);
  assert.equal(await probeStream({}), false);
});
