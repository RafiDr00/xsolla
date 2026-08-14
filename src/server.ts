import { setTimeout as setNodeTimeout } from 'node:timers';
import { loadConfig } from './config.js';
import { createApp } from './http/app.js';

const config = loadConfig();
const app = createApp(config);

const server = app.listen(config.port, () => {
  console.log(`[server] listening on :${config.port}`);
});

/**
 * A crash is the one failure mode the contract forbids outright. Anything that escapes
 * every other handler is logged and the process stays up - a service that answers 500 on
 * one route is strictly better than one that is gone.
 */
process.on('uncaughtException', (error) => {
  console.error('[server] uncaught exception:', error);
});
process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandled rejection:', reason);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`[server] ${signal} received, shutting down`);
    server.close(() => process.exit(0));
    // Do not wait forever for open SSE connections.
    setNodeTimeout(() => process.exit(0), 5000).unref();
  });
}
