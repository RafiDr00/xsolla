import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
// Imported explicitly from node:timers so the return type is a Timeout (with .unref())
// rather than the DOM's numeric handle.
import { setTimeout as setNodeTimeout } from 'node:timers';
import type { Finding } from '../core/findings.js';

/**
 * Job state, the per-job event log, the result cache, and idempotency records.
 *
 * The event log is the key design choice. Every observable thing that happens to a job
 * is appended to `events` as it happens; SSE clients are served by replaying that array
 * and then tailing it. Replay on a finished job is therefore identical to the live
 * stream *by construction* rather than by a second code path that has to be kept in
 * sync - which is precisely what the replay probe checks.
 */

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface Usage {
  inputBytes: number;
  chunks: number;
  cacheHit: boolean;
}

export type JobEventName = 'status' | 'finding' | 'done';

export interface JobEvent {
  event: JobEventName;
  data: unknown;
}

export interface Job {
  jobId: string;
  status: JobStatus;
  usage: Usage;
  findings: Finding[];
  /** Human-readable failure reason; null unless status is 'failed'. */
  error: string | null;
  events: JobEvent[];
  createdAt: number;
}

export interface CachedResult {
  findings: Finding[];
  totalFindings: number;
}

interface IdempotencyRecord {
  bodyHash: string;
  jobId: string;
}

type Subscriber = (event: JobEvent) => void;

export function isTerminal(status: JobStatus): boolean {
  return status === 'done' || status === 'failed';
}

export class JobStore {
  private readonly jobs = new Map<string, Job>();
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  private readonly cache = new Map<string, CachedResult>();
  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private snapshotTimer: NodeJS.Timeout | null = null;

  constructor(private readonly snapshotPath: string | null = null) {
    if (snapshotPath) this.restore(snapshotPath);
  }

  // ----------------------------------------------------------------- jobs

  create(usage: Usage): Job {
    const job: Job = {
      jobId: randomUUID(),
      status: 'queued',
      usage,
      findings: [],
      error: null,
      events: [],
      createdAt: Date.now(),
    };
    this.jobs.set(job.jobId, job);
    this.append(job, { event: 'status', data: { jobId: job.jobId, status: 'queued' } });
    return job;
  }

  get(jobId: string): Job | undefined {
    return this.jobs.get(jobId);
  }

  setRunning(job: Job): void {
    job.status = 'running';
    this.append(job, { event: 'status', data: { jobId: job.jobId, status: 'running' } });
  }

  /**
   * Complete a job: findings first (one event each, in contract order), then the status
   * transition, then `done`. The finding events are emitted after the merge rather than
   * as each chunk finishes, because the contract requires stream ordering by
   * (path, line, ruleId) and that order is only knowable once every chunk is in.
   */
  complete(job: Job, findings: Finding[]): void {
    job.findings = findings;
    for (const finding of findings) this.append(job, { event: 'finding', data: finding });
    job.status = 'done';
    this.append(job, { event: 'status', data: { jobId: job.jobId, status: 'done' } });
    this.append(job, {
      event: 'done',
      data: { total: findings.length, usage: job.usage },
    });
    this.scheduleSnapshot();
  }

  /**
   * Fail a job with a clear, client-visible reason. A `done` event is still emitted so
   * that an attached SSE client always sees the stream terminate rather than hanging.
   */
  fail(job: Job, message: string): void {
    job.status = 'failed';
    job.error = message;
    this.append(job, {
      event: 'status',
      data: { jobId: job.jobId, status: 'failed', error: message },
    });
    this.append(job, { event: 'done', data: { total: 0, usage: job.usage } });
    this.scheduleSnapshot();
  }

  private append(job: Job, event: JobEvent): void {
    job.events.push(event);
    const listeners = this.subscribers.get(job.jobId);
    if (!listeners) return;
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // A broken SSE connection must never affect job processing.
      }
    }
  }

  // ----------------------------------------------------------------- streaming

  subscribe(jobId: string, subscriber: Subscriber): () => void {
    let set = this.subscribers.get(jobId);
    if (!set) {
      set = new Set();
      this.subscribers.set(jobId, set);
    }
    set.add(subscriber);
    return () => {
      set.delete(subscriber);
      if (set.size === 0) this.subscribers.delete(jobId);
    };
  }

  // ----------------------------------------------------------------- cache

  getCached(key: string): CachedResult | undefined {
    return this.cache.get(key);
  }

  putCached(key: string, result: CachedResult): void {
    this.cache.set(key, result);
  }

  // ----------------------------------------------------------------- idempotency

  getIdempotent(key: string): IdempotencyRecord | undefined {
    return this.idempotency.get(key);
  }

  putIdempotent(key: string, bodyHash: string, jobId: string): void {
    this.idempotency.set(key, { bodyHash, jobId });
  }

  // ----------------------------------------------------------------- persistence

  /**
   * Snapshot to disk, debounced, written atomically via rename.
   *
   * In-memory is the primary store; this exists only so that a process restart inside
   * the scoring window (a redeploy, an OOM kill) does not lose finished jobs and cached
   * results. Tradeoff accepted and documented: it is single-node state, so it does not
   * survive running two instances behind a load balancer.
   */
  private scheduleSnapshot(): void {
    if (!this.snapshotPath || this.snapshotTimer) return;
    const timer = setNodeTimeout(() => {
      this.snapshotTimer = null;
      this.writeSnapshot();
    }, 1000);
    // Never hold the process open just to flush a snapshot.
    timer.unref();
    this.snapshotTimer = timer;
  }

  writeSnapshot(): void {
    if (!this.snapshotPath) return;
    try {
      const payload = JSON.stringify({
        jobs: [...this.jobs.values()],
        cache: [...this.cache.entries()],
        idempotency: [...this.idempotency.entries()],
      });
      const temporary = `${this.snapshotPath}.tmp`;
      writeFileSync(temporary, payload, 'utf8');
      renameSync(temporary, this.snapshotPath);
    } catch (error) {
      // Persistence is best-effort: never let it take the service down.
      console.error('[store] snapshot failed:', (error as Error).message);
    }
  }

  private restore(path: string): void {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
        jobs: Job[];
        cache: Array<[string, CachedResult]>;
        idempotency: Array<[string, IdempotencyRecord]>;
      };
      for (const job of parsed.jobs) {
        // A job that was mid-flight when the process died cannot be resumed - its worker
        // is gone. Report that truthfully instead of leaving it 'running' forever.
        if (!isTerminal(job.status)) {
          job.status = 'failed';
          job.error = 'Job was interrupted by a service restart';
        }
        this.jobs.set(job.jobId, job);
      }
      for (const [key, value] of parsed.cache) this.cache.set(key, value);
      for (const [key, value] of parsed.idempotency) this.idempotency.set(key, value);
      console.log(`[store] restored ${parsed.jobs.length} jobs from ${path}`);
    } catch {
      // No snapshot yet, or an unreadable one: start clean.
    }
  }
}
