import { setTimeout as setNodeTimeout } from 'node:timers';
import { loadConfig } from './config.js';
import { createApp } from './http/app.js';

const config = loadConfig();
const app = createApp(config);

const server = app.listen(config.port, () => {
  console.log(`[server] listening on :${config.port}`);
});

/**
 * Self keep-alive.
 *
 * The free tiers that still exist in 2026 spin a service down after ~15 minutes without
 * inbound traffic, and a cold start would be fatal here: jobs, the result cache, the
 * idempotency map and the SSE event log are all in-memory, so waking up means every
 * previously-issued jobId 404s, `cacheHit` reverts to false, and SSE replay has nothing
 * to replay - three separately-scored behaviors, gone.
 *
 * Pinging our own public URL keeps the instance in the "receiving inbound traffic" state
 * for as long as the process is alive. Deliberately self-contained rather than an
 * external cron: an outside pinger is one more thing that can quietly stop.
 *
 * No-op unless KEEPALIVE_URL is set, so it costs nothing on a host that never sleeps.
 */
const keepAliveUrl = process.env['KEEPALIVE_URL'];
if (keepAliveUrl) {
  // 4 minutes: a ~3.7x margin under a 15-minute idle window, so three consecutive
  // failures still do not put the service to sleep.
  const intervalMs = Number(process.env['KEEPALIVE_INTERVAL_MS'] ?? 240_000);
  const timer = setInterval(() => {
    fetch(keepAliveUrl, { signal: AbortSignal.timeout(10_000) }).catch(() => {
      // A failed ping is not worth logging every 4 minutes; the next one is 4 min away.
    });
  }, intervalMs);
  // Must never be the reason the process refuses to exit.
  timer.unref();
  console.log(`[server] self keep-alive every ${intervalMs}ms -> ${keepAliveUrl}`);
}

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
