import type { Chunk } from '../core/chunker.js';
import type { Finding } from '../core/findings.js';
import type { ProviderName } from '../core/canonical.js';

/**
 * The single seam between "how findings are produced" and everything else.
 *
 * Deliberately narrow: a provider is handed one chunk and returns findings for it. It
 * does NOT sort, deduplicate, truncate, cache, or know that chunking exists. Those are
 * pipeline concerns, which is why the `llm` provider inherits every cross-cutting
 * behavior the `mock` provider has without reimplementing any of it.
 */
export interface ReviewProvider {
  readonly name: ProviderName;
  review(chunk: Chunk): Promise<Finding[]>;
}

/**
 * A provider failure that should surface as a `failed` job with a clear message, never
 * as a crash and never as a 5xx on the submit path.
 */
export class ProviderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProviderError';
  }
}
