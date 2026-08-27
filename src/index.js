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
  console.log(`AtomicMail Panel core listening on http://${config.host}:${config.port}`);
  console.log(`Worker: ${config.workerEnabled ? 'enabled (concurrency=1)' : 'disabled'}`);
});

function shutdown(signal) {
  console.log(`${signal}: shutting down`);
  worker.stop();
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
