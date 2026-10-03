/**
 * Scripted model responses for rubric synthesis tests.
 *
 * Generation is three model calls (worker → reviewer → judge, P4.3) plus one gate call per
 * criterion, so a test that scripts them by hand becomes unreadable. These helpers make the
 * *shape* of the exchange explicit while keeping each test about the behaviour it is testing.
 */
import type { ScriptedTurn } from './fakeProvider.js'

export interface CriterionSpec {
  name: string
  description?: string
  evidenceSpec?: string
  sourceRef?: string
  anchors?: [string, string, string, string, string]
}

const DEFAULT_ANCHORS: [string, string, string, string, string] = [
  'No evidence the requirement is addressed.',
  'Mentioned in documentation or configuration only.',
  'Code exists but is unused or non-functional.',
  'Implemented and exercised on the main path.',
  'Implemented, validated, and failures are handled.',
]

export function criterion(spec: CriterionSpec) {
  const anchors = spec.anchors ?? DEFAULT_ANCHORS
  return {
    name: spec.name,
    description: spec.description ?? `Whether the submission ${spec.name.toLowerCase()}.`,
    evidence_spec: spec.evidenceSpec ??
      'A reader can point to the code implementing this and to where it is called.',
    anchors: { 0: anchors[0], 1: anchors[1], 2: anchors[2], 3: anchors[3], 4: anchors[4] },
    source_ref: spec.sourceRef ?? 'brief §2.1',
  }
}

export const generateTurn = (specs: CriterionSpec[]): ScriptedTurn => ({
  text: JSON.stringify({ criteria: specs.map(criterion) }),
})

export const reviewTurn = (overrides: Record<string, unknown> = {}): ScriptedTurn => ({
  text: JSON.stringify({
    missing_coverage: [], not_checkable: [], overlapping: [],
    assessment: 'The set covers the brief and each criterion is locatable in a repository.',
    ...overrides,
  }),
})

export const judgeTurn = (
  verdict: 'PASS' | 'PASS_WITH_NOTES' | 'FAIL' = 'PASS',
  reasoning = 'The set is fit for committee review.',
): ScriptedTurn => ({
  text: JSON.stringify({ verdict, reasoning, must_address: [] }),
})

export const gateTurn = (
  verdict: 'CHECKABLE' | 'NEEDS_REWRITE' | 'UNCHECKABLE' = 'CHECKABLE',
  extra: Record<string, unknown> = {},
): ScriptedTurn => ({
  text: JSON.stringify({ verdict, reasons: [], anchor_problems: [], ...extra }),
})

export const rewriteTurn = (name: string): ScriptedTurn => gateTurn('NEEDS_REWRITE', {
  reasons: ['"innovative" cannot be located in a repository'],
  rewritten: {
    name,
    description: `Whether the submission ${name.toLowerCase()}.`,
    evidence_spec: 'A reader can point to the specific module and its call sites.',
    anchors: {
      0: DEFAULT_ANCHORS[0], 1: DEFAULT_ANCHORS[1], 2: DEFAULT_ANCHORS[2],
      3: DEFAULT_ANCHORS[3], 4: DEFAULT_ANCHORS[4],
    },
  },
})

/** Worker → reviewer → judge, then one CHECKABLE gate call per criterion. */
export function fullSynthesisScript(specs: CriterionSpec[]): ScriptedTurn[] {
  return [
    generateTurn(specs),
    reviewTurn(),
    judgeTurn(),
    ...specs.map(() => gateTurn('CHECKABLE')),
  ]
}

/** A brief long enough to clear the thin-brief guard, with real structure. */
export const SAMPLE_BRIEF = [
  '# Challenge Alpha — Telemetry triage',
  '',
  'Teams build a service that consumes a live telemetry feed, detects threshold breaches and',
  'raises alerts through the supplied notification channel.',
  '',
  '## 2.1 Ingestion',
  '',
  'The service must connect to the telemetry feed described in appendix A and parse each record',
  'against the documented schema. Records that fail schema validation must be counted and',
  'reported, not silently discarded.',
  '',
  '## 3.2 Detection',
  '',
  'A breach occurs when a metric exceeds its configured threshold for three consecutive',
  'intervals. The threshold must be configurable without redeploying the service.',
  '',
  '## 4.1 Alerting',
  '',
  'Each breach raises exactly one alert through the notification channel. Repeated breaches of',
  'the same metric within the cool-down window must not raise duplicate alerts.',
].join('\n')
