import fs from 'node:fs';
import { loadConfig } from './config.js';
import { Store } from './db.js';
import { AtomicMailProvider } from './provider.js';
import { JobWorker } from './worker.js';
import { createServer } from './server.js';

const config = loadConfig();
fs.mkdirSync(config.credentialsRoot, { recursive: true, mode: 0o700 });

const store = new Store(config.dbPath);
const provider = new AtomicMailProvider(config);
const worker = new JobWorker({ store, provider, config });
const server = createServer({ store, worker, config });

worker.start();

server.listen(config.port, config.host, () => {
  console.log(`AtomicMail Panel listening on http://${config.host}:${config.port}`);
  console.log(`Worker: ${config.workerEnabled ? 'enabled (concurrency=1)' : 'disabled'}`);
  console.log(`Admin auth: ${config.adminPassword ? 'enabled' : 'disabled'}`);
  console.log(`Atomic Mail watch mode: ${config.atomicWatchMode}`);
  if (!config.adminPassword) console.log('Security note: keep the panel bound to localhost/private access while ADMIN_PASSWORD is empty.');
});

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal}: shutting down`);

  const hardExit = setTimeout(() => {
    console.error('Shutdown grace period exceeded; exiting so restart recovery can safely resume pending work.');
    process.exit(1);
  }, config.shutdownGraceMs + 5000);
  hardExit.unref();

  const serverClosed = new Promise((resolve) => {
    server.close(() => resolve());
  });

  const idle = await worker.stop({ abortActive: true, waitMs: config.shutdownGraceMs });
  if (!idle) {
    console.error('Worker did not become idle before shutdown deadline.');
    return;
  }

  await serverClosed;
  try {
    store.checkpoint();
  } catch (error) {
    console.warn(`SQLite checkpoint warning: ${error?.message || error}`);
  }
  store.close();
  clearTimeout(hardExit);
  process.exit(0);
}

process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
