const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
}

const http = require('http');
const app = require('./src/server');

const PORT = (typeof process !== "undefined" && process.env ? process.env.PORT : undefined) || 7000;
const SHUTDOWN_GRACE_MS = 10000;

const server = http.createServer(app);

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Set PORT to choose another.`);
  } else {
    console.error('Server error:', error.message);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`==================================================`);
  console.log(`Latino Stremio Addon is running!`);
  console.log(`📡 URL: http://localhost:${PORT}`);
  console.log(`🔗 Manifest: http://localhost:${PORT}/manifest.json`);
  console.log(`==================================================`);
});

// Stop accepting new connections and let in-flight responses finish. Proxied
// streams are long-lived, so there is a cap on how long we wait for them.
let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`${signal} received, shutting down...`);

  const forceExit = setTimeout(() => {
    console.warn(`Connections still open after ${SHUTDOWN_GRACE_MS}ms, exiting anyway.`);
    process.exit(0);
  }, SHUTDOWN_GRACE_MS);
  forceExit.unref();

  server.close(() => {
    clearTimeout(forceExit);
    console.log('Shutdown complete.');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
