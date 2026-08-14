export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type Category = 'security' | 'correctness' | 'performance' | 'style';

export interface Finding {
  /** `${ruleId}:${path}:${line}` - also the dedup key. */
  id: string;
  ruleId: string;
  path: string;
  line: number;
  severity: Severity;
  category: Category;
  title: string;
  /** The offending added line, verbatim (leading '+' marker removed). */
  evidence: string;
}

export function findingId(ruleId: string, path: string, line: number): string {
  return `${ruleId}:${path}:${line}`;
}

/**
 * Contract ordering: path (lexicographic), then line (ascending), then ruleId.
 *
 * Deliberately NOT `localeCompare`: that is locale- and ICU-version-dependent, so it
 * would sort `src/A.ts`, `src/_a.ts`, `src/b.ts` differently depending on where the
 * process runs. Code-unit comparison is what "lexicographic" means here and it is the
 * only definition that gives a byte-identical answer on my laptop and on the host.
 */
export function compareFindings(a: Finding, b: Finding): number {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  if (a.line !== b.line) return a.line - b.line;
  if (a.ruleId !== b.ruleId) return a.ruleId < b.ruleId ? -1 : 1;
  return 0;
}

/**
 * Sort into contract order, then drop duplicate ids.
 *
 * Sort-then-dedup (rather than dedup-then-sort) is what makes a chunked scan identical
 * to an unchunked one: the same set of findings arrives in the same order regardless of
 * how the input was partitioned. Array#sort is stable, and duplicates compare equal, so
 * "keep the first" means the first in discovery order.
 */
export function orderAndDedup(findings: Finding[]): Finding[] {
  const sorted = [...findings].sort(compareFindings);
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const finding of sorted) {
    if (seen.has(finding.id)) continue;
    seen.add(finding.id);
    out.push(finding);
  }
  return out;
}
