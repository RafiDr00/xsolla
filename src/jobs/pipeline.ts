import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { parseUnifiedDiff, type DiffFile } from '../core/diff.js';
import { chunkFiles, type Chunk } from '../core/chunker.js';
import { orderAndDedup, type Finding } from '../core/findings.js';
import type { ReviewProvider } from '../providers/types.js';

/**
 * The review pipeline: parse -> chunk -> scan each chunk -> merge -> order -> dedup ->
 * truncate. Provider-agnostic by construction.
 *
 * The ordering decision that makes chunking correct: findings are merged from all chunks
 * and sorted ONCE, globally, at the end. A per-chunk sort would produce a list that is
 * only locally ordered, and the "identical to an unchunked scan" probe would catch it.
 */

export interface Prepared {
  files: DiffFile[];
  chunks: Chunk[];
  /** UTF-8 byte length of the submitted diff - reported as usage.inputBytes. */
  inputBytes: number;
}

export interface ReviewResult {
  /** Ordered, deduplicated, truncated to maxFindings. */
  findings: Finding[];
  /** Size of the full ordered result before truncation. */
  totalFindings: number;
}

/**
 * Parse and chunk synchronously at submit time.
 *
 * Doing this before returning 202 has two payoffs: an unparseable diff gets its 422
 * immediately rather than becoming a failed job, and `usage.inputBytes` / `usage.chunks`
 * are accurate from the moment the job is queued - including while it is still `queued`.
 *
 * Returns null when the input is not a parseable unified diff (-> 422 invalid_diff).
 */
export function prepareDiff(diff: string): Prepared | null {
  if (typeof diff !== 'string' || diff.length === 0) return null;

  const files = parseUnifiedDiff(diff);
  // No recognizable file section means this was not a unified diff at all.
  if (files.length === 0) return null;

  return {
    files,
    chunks: chunkFiles(files),
    inputBytes: Buffer.byteLength(diff, 'utf8'),
  };
}

export async function runReview(
  prepared: Prepared,
  provider: ReviewProvider,
  maxFindings: number,
): Promise<ReviewResult> {
  const collected: Finding[] = [];

  for (const chunk of prepared.chunks) {
    collected.push(...(await provider.review(chunk)));
    // Hand the event loop back between chunks. The mock provider is pure CPU work, and
    // without this a large diff would stall every other in-flight job and the health
    // check along with them.
    await yieldToEventLoop();
  }

  const ordered = orderAndDedup(collected);

  return {
    // maxFindings truncates the ordered list; the scan itself is unaffected, which is
    // why usage and totalFindings still describe the full result.
    findings: ordered.slice(0, maxFindings),
    totalFindings: ordered.length,
  };
}
