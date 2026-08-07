const { resolvePlayerStream } = require('./src/unpacker');

const userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const wrappers = [
  ['filemoon', 'https://filemoon.sx/e/jit3ysg37ojx'],
  ['hlswish', 'https://hlswish.com/e/7mpdbzuy04uy'],
  ['embed69', 'https://embed69.org/f/tt1270797'],
  ['vidhide', 'https://vidhideplus.com/v/jwbzc2sk6vi4'],
  ['pelisplus', 'https://pelisplus.upns.pro/#pkaw9'],
  ['voe', 'https://voe.sx/e/iwh9zzst5ezc'],
  ['waaw', 'https://waaw.to/f/PsX7c4rIU7wF'],
  ['streamlare', 'https://streamlare.com/e/XAQ9qzx1bgLl4mME']
];

function kindOf(url) {
  if (!url) return 'none';
  if (/\.m3u8(?:$|[?#])/i.test(url)) return 'hls';
  if (/\.(?:mp4|mkv|bin)(?:$|[?#])/i.test(url)) return 'file';
  return 'other';
}

async function run() {
  for (const [name, url] of wrappers) {
    const direct = await resolvePlayerStream(url, userAgent, 'https://tioplus.app/');
    console.log(`${name}: ${kindOf(direct)} ${direct || 'NO_STREAM'}`);
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
