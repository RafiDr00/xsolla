import type { ProviderName } from '../core/canonical.js';
import type { Config } from '../config.js';
import { mockProvider } from './mock.js';
import { createLlmProvider } from './llm.js';
import type { ReviewProvider } from './types.js';

/** Both providers, built once at boot and selected per job by name. */
export function createProviders(config: Config): Record<ProviderName, ReviewProvider> {
  return {
    mock: mockProvider,
    llm: createLlmProvider(config.llm),
  };
}
