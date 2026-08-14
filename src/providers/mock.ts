import type { Chunk } from '../core/chunker.js';
import type { Finding } from '../core/findings.js';
import { scanFiles } from '../core/rules.js';
import type { ReviewProvider } from './types.js';

/**
 * The deterministic provider: the rule table, applied to the chunk's added lines.
 *
 * Async only to satisfy the interface - the work is pure CPU and completes immediately.
 */
export const mockProvider: ReviewProvider = {
  name: 'mock',
  async review(chunk: Chunk): Promise<Finding[]> {
    return scanFiles(chunk.files);
  },
};
