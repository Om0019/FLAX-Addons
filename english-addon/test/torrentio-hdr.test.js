const assert = require('node:assert/strict');
const test = require('node:test');
const { isHdrRelease } = require('../src/providers');

const stream = (title, name) => ({ title, name });

test('flags HDR10+ releases', () => {
  assert.equal(isHdrRelease(stream('Movie.2024.2160p.HDR10+.x265-GROUP')), true);
});

test('flags plain HDR releases', () => {
  assert.equal(isHdrRelease(stream('Movie.2024.2160p.HDR.x265-GROUP')), true);
});

test('flags Dolby Vision releases, spelled out or abbreviated', () => {
  assert.equal(isHdrRelease(stream('Movie.2024.2160p.Dolby.Vision.x265-GROUP')), true);
  assert.equal(isHdrRelease(stream('Movie.2024.2160p.DoVi.x265-GROUP')), true);
});

test('flags HDR carried in the name field instead of the title', () => {
  assert.equal(isHdrRelease(stream('Movie.2024.2160p.x265-GROUP', 'Torrentio\n4k HDR')), true);
});

test('does not flag SDR releases', () => {
  assert.equal(isHdrRelease(stream('Movie.2024.1080p.WEB-DL.x264-GROUP')), false);
});

test('does not false-positive on HDRip, an unrelated rip-quality tag', () => {
  assert.equal(isHdrRelease(stream('Movie.2024.HDRip.x264-GROUP')), false);
});

test('handles missing title/name gracefully', () => {
  assert.equal(isHdrRelease(stream(undefined, undefined)), false);
});
