import type { AddedLine, DiffFile } from './diff.js';
import { findingId, orderAndDedup, type Category, type Finding, type Severity } from './findings.js';

export { orderAndDedup };

/**
 * The mock rule engine.
 *
 * Every rule looks ONLY at added lines (the parser already guarantees the `+++` header
 * is not one of them). Most rules are pure per-line predicates; MOCK-004 needs a small
 * amount of look-ahead, so it is handled separately.
 *
 * Diff content is only ever *data* here - it is matched against, never interpreted.
 * That is what makes MOCK-INJ inert: an injection string is just another line that
 * happens to match a predicate, and it cannot influence any other rule's outcome.
 */

interface RuleSpec {
  ruleId: string;
  severity: Severity;
  category: Category;
  title: string;
}

const SPECS = {
  'MOCK-001': { ruleId: 'MOCK-001', severity: 'critical', category: 'security', title: 'eval usage' },
  'MOCK-002': { ruleId: 'MOCK-002', severity: 'critical', category: 'security', title: 'hardcoded credential' },
  'MOCK-003': { ruleId: 'MOCK-003', severity: 'high', category: 'security', title: 'SQL string concatenation' },
  'MOCK-004': { ruleId: 'MOCK-004', severity: 'high', category: 'correctness', title: 'swallowed exception' },
  'MOCK-005': { ruleId: 'MOCK-005', severity: 'medium', category: 'correctness', title: 'loose null comparison' },
  'MOCK-006': { ruleId: 'MOCK-006', severity: 'medium', category: 'performance', title: 'deep-clone via JSON' },
  'MOCK-007': { ruleId: 'MOCK-007', severity: 'low', category: 'style', title: 'console.log left in' },
  'MOCK-008': { ruleId: 'MOCK-008', severity: 'low', category: 'style', title: 'unresolved marker' },
  'MOCK-INJ': { ruleId: 'MOCK-INJ', severity: 'critical', category: 'security', title: 'prompt-injection content' },
} as const satisfies Record<string, RuleSpec>;

/** Verbatim from the brief. */
const CREDENTIAL =
  /(api[_-]?key|secret|token)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/i;

/**
 * Loose equality against null, excluding the strict forms.
 *
 * A naive `includes('== null')` would also match `x === null` and `x !== null`, because
 * both contain that substring. The rule is titled "loose null comparison", so the strict
 * operators must not fire. The lookaround pair pins the operator to exactly two chars.
 */
const LOOSE_NULL = /(?<![=!])[=!]=(?!=)\s*null\b/;

const SQL_KEYWORD = /\b(SELECT|INSERT|UPDATE|DELETE)\b/i;

const INJECTION_PHRASES = [
  'ignore previous instructions',
  'disregard all prior',
  'you are now',
];

/**
 * MOCK-003: a SQL keyword inside a string literal, on a line that also performs `+`
 * concatenation OUTSIDE any literal.
 *
 * Approach: a single left-to-right pass splits the line into string-literal spans and
 * non-literal spans (handling ', " and `, and backslash escapes). We then require a SQL
 * keyword in some literal AND a `+` in the non-literal text.
 *
 * Limits, stated honestly: this is lexical, not a parse. It does not see SQL built
 * across several lines, via template-literal interpolation (`` `SELECT ${id}` `` has no
 * `+`), or through a builder API - and it will flag a harmless `"SELECT" + " prose"`.
 * Requiring the `+` to sit outside the literal is what stops the common false positive
 * of arithmetic inside the query text (`"SELECT a + b FROM t"`).
 */
function hasSqlConcatenation(content: string): boolean {
  const literals: string[] = [];
  let outside = '';
  let quote: string | null = null;
  let literal = '';

  for (let i = 0; i < content.length; i++) {
    const ch = content[i]!;
    if (quote !== null) {
      if (ch === '\\') {
        literal += ch + (content[i + 1] ?? '');
        i++;
        continue;
      }
      if (ch === quote) {
        literals.push(literal);
        literal = '';
        quote = null;
        continue;
      }
      literal += ch;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
    } else {
      outside += ch;
    }
  }
  // An unterminated literal still counts - the line may be one piece of a larger string.
  if (quote !== null) literals.push(literal);

  return literals.some((l) => SQL_KEYWORD.test(l)) && outside.includes('+');
}

/** Per-line predicates. MOCK-004 is excluded: it needs look-ahead. */
const LINE_RULES: Array<{ spec: RuleSpec; matches: (content: string) => boolean }> = [
  { spec: SPECS['MOCK-001'], matches: (c) => c.includes('eval(') },
  { spec: SPECS['MOCK-002'], matches: (c) => CREDENTIAL.test(c) },
  { spec: SPECS['MOCK-003'], matches: hasSqlConcatenation },
  { spec: SPECS['MOCK-005'], matches: (c) => LOOSE_NULL.test(c) },
  { spec: SPECS['MOCK-006'], matches: (c) => c.includes('JSON.parse(JSON.stringify(') },
  { spec: SPECS['MOCK-007'], matches: (c) => c.includes('console.log(') },
  // TODO/FIXME are conventionally uppercase and the brief marks case-insensitivity
  // explicitly elsewhere (MOCK-002, MOCK-INJ) but not here, so this stays case-sensitive.
  { spec: SPECS['MOCK-008'], matches: (c) => c.includes('TODO') || c.includes('FIXME') },
  {
    spec: SPECS['MOCK-INJ'],
    matches: (c) => {
      const lower = c.toLowerCase();
      return INJECTION_PHRASES.some((phrase) => lower.includes(phrase));
    },
  },
];

const CATCH_OPEN = /\bcatch\b[^{]*\{/;

/**
 * MOCK-004: empty catch block, reported on the `catch` line.
 *
 * Walks forward from the opening brace, tracking nesting depth, across added lines that
 * are *contiguous in the new file*. Two deliberate constraints:
 *
 *  - If the closing brace never appears in the visible added lines we report nothing.
 *    The body may be unchanged context we simply cannot see, and inventing a finding
 *    there would be a false positive on a scored probe.
 *  - A comment-only body counts as NOT empty, matching ESLint's `no-empty`. The trigger
 *    says "empty catch block", and a comment is content.
 */
function detectEmptyCatch(added: AddedLine[]): AddedLine[] {
  const hits: AddedLine[] = [];

  for (let i = 0; i < added.length; i++) {
    const start = added[i]!;
    const match = CATCH_OPEN.exec(start.content);
    if (!match) continue;

    let depth = 1;
    let body = '';
    let closed = false;
    let cursor = i;
    let text = start.content.slice(match.index + match[0].length);

    while (true) {
      for (const ch of text) {
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        if (depth === 0) {
          closed = true;
          break;
        }
        body += ch;
      }
      if (closed) break;

      const next = added[cursor + 1];
      // Contiguity check: only judge emptiness when the whole block is visible.
      if (!next || next.line !== added[cursor]!.line + 1) break;
      body += '\n';
      cursor++;
      text = next.content;
    }

    if (closed && body.trim() === '') hits.push(start);
  }

  return hits;
}

function toFinding(spec: RuleSpec, added: AddedLine): Finding {
  return {
    id: findingId(spec.ruleId, added.path, added.line),
    ruleId: spec.ruleId,
    path: added.path,
    line: added.line,
    severity: spec.severity,
    category: spec.category,
    title: spec.title,
    evidence: added.content,
  };
}

/**
 * Scan a set of files and return findings in discovery order (unsorted, undeduped).
 * Ordering and dedup happen once, globally, after all chunks have been merged.
 */
export function scanFiles(files: DiffFile[]): Finding[] {
  const findings: Finding[] = [];

  for (const file of files) {
    for (const added of file.addedLines) {
      for (const rule of LINE_RULES) {
        // One finding per matching line per rule, however many times it matches.
        if (rule.matches(added.content)) findings.push(toFinding(rule.spec, added));
      }
    }
    for (const hit of detectEmptyCatch(file.addedLines)) {
      findings.push(toFinding(SPECS['MOCK-004'], hit));
    }
  }

  return findings;
}
