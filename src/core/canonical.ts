import { createHash } from 'node:crypto';

/**
 * Option normalization and cache-key derivation.
 *
 * Normalizing BEFORE hashing is the important part: `{}` and
 * `{"provider":"mock","maxFindings":100}` describe the same review, so they must land on
 * the same cache entry. Hashing the raw body instead would make the cache miss on a
 * semantically identical request, which is exactly what the caching probe checks.
 */

export type ProviderName = 'mock' | 'llm';

export interface ReviewOptions {
  provider: ProviderName;
  maxFindings: number;
}

export const DEFAULT_OPTIONS: ReviewOptions = { provider: 'mock', maxFindings: 100 };

const PROVIDERS: readonly string[] = ['mock', 'llm'];

/**
 * The error taxonomy has no code for malformed options, and the brief says unknown body
 * fields are ignored. So an unusable value degrades to its default rather than failing
 * the request - lenient in what we accept, strict in what the pipeline then does.
 */
export function normalizeOptions(raw: unknown): ReviewOptions {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ...DEFAULT_OPTIONS };
  const input = raw as Record<string, unknown>;

  const provider =
    typeof input['provider'] === 'string' && PROVIDERS.includes(input['provider'])
      ? (input['provider'] as ProviderName)
      : DEFAULT_OPTIONS.provider;

  const rawMax = input['maxFindings'];
  const maxFindings =
    typeof rawMax === 'number' && Number.isInteger(rawMax) && rawMax >= 0
      ? rawMax
      : DEFAULT_OPTIONS.maxFindings;

  return { provider, maxFindings };
}

export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Cache key over the normalized {diff, options}. Fields are written in a fixed order so
 * the key never depends on JSON key insertion order, and the diff is length-prefixed so
 * no combination of diff content and option values can collide by concatenation.
 */
export function cacheKey(diff: string, options: ReviewOptions): string {
  const diffBytes = Buffer.byteLength(diff, 'utf8');
  const canonical = [
    'v1',
    `provider=${options.provider}`,
    `maxFindings=${options.maxFindings}`,
    `diffBytes=${diffBytes}`,
    diff,
  ].join('\n');
  return sha256(canonical);
}
