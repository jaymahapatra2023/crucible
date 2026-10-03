/**
 * Publish the frozen rubric to teams (E02-S08, E09-S04).
 *
 * This is the document that makes the whole exercise legitimate: P0's governance commitment is
 * "publish the rubric before submissions open", and "we were not told" has to be answerable
 * afterwards. So the export carries its version and content hash, and publication is recorded.
 */
import { createHash } from 'node:crypto'
import { DIMENSIONS, type Dimension, type Rubric } from '@crucible/rubric'
import { AppError } from '../../../lib/appError.js'
import { createLogger } from '../../../lib/logger.js'
import { recordAudit } from '../../../lib/ports/auditPort.js'
import { selectPublishedBySlug, selectCriteria, toRubric, updateRubricStatus } from '../db/rubricDb.js'
import {
  insertPublication, selectCurrentPublication, type PublicationRow,
} from '../db/publicationDb.js'
import { selectChallenge } from '../../challenges/db/challengeDb.js'
import { loadRubric } from './rubricService.js'

const log = createLogger('rubrics', 'export')

const DIMENSION_LABELS: Record<Dimension, string> = {
  CHALLENGE_FIDELITY: 'Challenge fidelity',
  ENGINEERING_QUALITY: 'Engineering quality',
  PRINCIPLES_STANDARDS: 'Principles & standards',
  RUNS: 'Runs (build & execute)',
  ORIGINALITY: 'Inventiveness of the approach',
}

/** Record that a frozen rubric was published (acceptance 3). */
export async function publishRubric(rubricId: number, actor: string): Promise<Rubric> {
  const rubric = await loadRubric(rubricId)
  if (rubric.status !== 'FROZEN') {
    throw new AppError(
      'PRECONDITION_FAILED',
      `Rubric ${rubricId} is ${rubric.status}. Only a FROZEN rubric can be published — teams ` +
        `must be shown the standard that will actually be used.`,
    )
  }

  const row = await updateRubricStatus({ rubricId, status: 'FROZEN', publish: true })
  if (!row) throw new AppError('NOT_FOUND', `Rubric ${rubricId} was not found.`)

  const challenge = await selectChallenge(Number(rubric.challengeId))
  if (!challenge) {
    throw new AppError('NOT_FOUND', `Challenge ${rubric.challengeId} was not found.`)
  }

  // Render ONCE, here, and keep the bytes (E09-S04 acceptance 2). Re-rendering on each request
  // would mean a later change to the renderer silently changed what "what teams received"
  // refers to, with nothing recording that it had.
  const markdown = toMarkdown(rubric, challenge.name)
  const html = toHtml(rubric, challenge.name)

  const publication = await insertPublication({
    rubricId,
    challengeId: Number(rubric.challengeId),
    slug: challenge.slug,
    version: rubric.version,
    contentHash: rubric.contentHash ?? '',
    markdown,
    html,
    documentHash: documentHash(markdown, html),
    publishedBy: actor,
  })

  await recordAudit({
    actor, action: 'rubric.published', subjectType: 'rubric', subjectId: String(rubricId),
    payload: {
      version: rubric.version,
      contentHash: rubric.contentHash,
      publicationId: publication.publication_id,
      documentHash: publication.document_hash,
    },
  })
  log.info('rubric published', {
    rubricId, version: rubric.version, publicationId: publication.publication_id,
  })
  return toRubric(row, await selectCriteria(rubricId))
}

/** A hash over the rendered documents, so a served copy can be proved unaltered. */
export function documentHash(markdown: string, html: string): string {
  return createHash('sha256').update(markdown).update('\u0000').update(html).digest('hex')
}

/**
 * The document teams were given, as it was given (E09-S04 acceptance 2).
 *
 * Served from the stored bytes rather than re-rendered. Refuses rather than falling back to a
 * fresh render: a silently-regenerated document is indistinguishable from the original and
 * would answer "we were not told" with something written afterwards.
 */
export async function publishedDocument(slug: string): Promise<PublicationRow> {
  const publication = await selectCurrentPublication(slug)
  if (!publication) {
    throw new AppError(
      'NOT_FOUND',
      `No published rubric exists for '${slug}'. It is published once the committee has ` +
        `approved and frozen it.`,
    )
  }
  return publication
}

/** The published rubric for a challenge slug, readable without an account (P8.1). */
export async function publishedRubricBySlug(slug: string): Promise<Rubric> {
  const row = await selectPublishedBySlug(slug)
  if (!row) {
    throw new AppError(
      'NOT_FOUND',
      `No published rubric exists for '${slug}'. It is published once the committee has ` +
        `approved and frozen it.`,
    )
  }
  return toRubric(row, await selectCriteria(row.rubric_id))
}

function byDimension(rubric: Rubric): Array<{ dimension: Dimension; criteria: Rubric['criteria'] }> {
  return DIMENSIONS
    .map((dimension) => ({
      dimension,
      criteria: rubric.criteria
        .filter((c) => c.dimension === dimension)
        .sort((a, b) => a.sortOrder - b.sortOrder),
    }))
    .filter((g) => g.criteria.length > 0)
}

const pct = (n: number): string => `${(n * 100).toFixed(0)}%`

/**
 * The build-declaration rule, published alongside the rubric (E03-S03 acceptance 3, OD-3).
 *
 * The RUNS dimension is scored by actually building and starting the submission, so a team must
 * be told *before* submitting that they have to declare how. Leaving it to the submission form
 * means the first time a team learns the rule is the moment it blocks them — and leaving it out
 * of the published rules means "we were not told" is a fair complaint.
 */
const BUILD_RULES_MD = [
  '## How your submission will be built',
  '',
  'The "Runs" dimension is scored objectively: your submission is built and started inside an',
  'isolated sandbox, with no network access and no credentials. No model judges this score.',
  '',
  'When you submit, you must declare **one** of:',
  '',
  '- **A Dockerfile** — give its path relative to the repository root. We build it and start the',
  '  container, and check that it stays up.',
  '- **A build command** — a single command we can run in a standard base image for your',
  '  language, for example `npm ci && npm run build`.',
  '',
  'Your repository must be **public** at the deadline. We check it when you submit and again',
  'periodically until submissions close; if it stops being reachable we will contact you at the',
  'address you gave.',
  '',
  'A declared Dockerfile path is checked at submission time. If it is not in the repository, your',
  'submission is rejected immediately rather than silently failing to build later.',
  '',
].join('\n')

/** Markdown export (acceptance 1), carrying version and hash (acceptance 2). */
export function toMarkdown(rubric: Rubric, challengeName: string): string {
  const lines: string[] = [
    `# Scoring rubric — ${challengeName}`,
    '',
    `**Version ${rubric.version}** · frozen ${rubric.frozenAt ?? 'not frozen'}`,
    '',
    `Content hash: \`${rubric.contentHash ?? 'not set'}\``,
    '',
    'Every submission is scored against these criteria. Each criterion is scored 0–4 against the',
    'anchors below, and every score carries a file-and-line reference to the evidence it rests on.',
    '',
    '## How the dimensions combine',
    '',
    '| Dimension | Weight |',
    '|---|---:|',
  ]

  for (const dimension of DIMENSIONS) {
    lines.push(`| ${DIMENSION_LABELS[dimension]} | ${pct(rubric.dimensionWeights[dimension])} |`)
  }

  // Only published when the rubric actually scores whether the submission runs.
  if (rubric.dimensionWeights.RUNS > 0) {
    lines.push('', BUILD_RULES_MD)
  }

  for (const group of byDimension(rubric)) {
    lines.push('', `## ${DIMENSION_LABELS[group.dimension]}`, '')
    for (const c of group.criteria) {
      lines.push(
        `### ${c.name}`, '',
        `*Weight within this dimension: ${pct(c.weight)}*`, '',
        c.description, '',
        `**What a reader will look for:** ${c.evidenceSpec}`, '',
      )
      if (c.sourceRef) lines.push(`**From the brief:** ${c.sourceRef}`, '')
      lines.push('| Score | Means |', '|---:|---|')
      for (const level of [0, 1, 2, 3, 4] as const) {
        lines.push(`| ${level} | ${c.anchors[level].replace(/\|/g, '\\|')} |`)
      }
      lines.push('')
    }
  }

  return lines.join('\n')
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** HTML export (acceptance 1). Self-contained, so it can be attached or hosted anywhere. */
export function toHtml(rubric: Rubric, challengeName: string): string {
  const rows = byDimension(rubric).map((group) => {
    const criteria = group.criteria.map((c) => `
      <article class="criterion">
        <h3>${escapeHtml(c.name)}</h3>
        <p class="weight">Weight within this dimension: ${pct(c.weight)}</p>
        <p>${escapeHtml(c.description)}</p>
        <p class="evidence"><strong>What a reader will look for:</strong> ${escapeHtml(c.evidenceSpec)}</p>
        ${c.sourceRef ? `<p class="source"><strong>From the brief:</strong> ${escapeHtml(c.sourceRef)}</p>` : ''}
        <table>
          <caption class="sr-only">Score anchors for ${escapeHtml(c.name)}</caption>
          <thead><tr><th scope="col">Score</th><th scope="col">Means</th></tr></thead>
          <tbody>${([0, 1, 2, 3, 4] as const).map((l) =>
            `<tr><th scope="row">${l}</th><td>${escapeHtml(c.anchors[l])}</td></tr>`).join('')}
          </tbody>
        </table>
      </article>`).join('')
    return `<section><h2>${escapeHtml(DIMENSION_LABELS[group.dimension])}</h2>${criteria}</section>`
  }).join('')

  const buildRules = rubric.dimensionWeights.RUNS > 0
    ? `<section><h2>How your submission will be built</h2>
       <p>The &ldquo;Runs&rdquo; dimension is scored objectively: your submission is built and
       started inside an isolated sandbox, with no network access and no credentials. No model
       judges this score.</p>
       <p>When you submit, you must declare <strong>one</strong> of:</p>
       <ul>
         <li><strong>A Dockerfile</strong> &mdash; give its path relative to the repository root.</li>
         <li><strong>A build command</strong> &mdash; a single command we can run in a standard
         base image for your language.</li>
       </ul>
       <p>Your repository must be <strong>public</strong> at the deadline. We check it when you
       submit and again periodically until submissions close.</p>
       <p>A declared Dockerfile path is checked at submission time, so a wrong path is rejected
       immediately rather than silently failing to build later.</p></section>`
    : ''

  const weightRows = DIMENSIONS.map((d) =>
    `<tr><th scope="row">${escapeHtml(DIMENSION_LABELS[d])}</th><td>${pct(rubric.dimensionWeights[d])}</td></tr>`,
  ).join('')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Scoring rubric — ${escapeHtml(challengeName)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.6 ui-sans-serif, system-ui, sans-serif; max-width: 52rem; margin: 2rem auto;
         padding: 0 1rem; color: #1b1a17; background: #fbfbfa; }
  h1 { font-size: 1.6rem; } h2 { margin-top: 2.5rem; border-bottom: 1px solid #e4e2dd; padding-bottom: .3rem; }
  h3 { margin-bottom: .2rem; }
  .meta { color: #6b6862; } .weight { color: #6b6862; font-size: .9rem; margin-top: 0; }
  code { background: #f0efec; padding: .1rem .3rem; border-radius: 3px; word-break: break-all; }
  table { border-collapse: collapse; width: 100%; margin: .5rem 0 1.5rem; }
  th, td { border: 1px solid #e4e2dd; padding: .4rem .6rem; text-align: left; vertical-align: top; }
  th[scope=row] { width: 3rem; text-align: right; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  @media (prefers-color-scheme: dark) {
    body { background: #14130f; color: #ece9e2; }
    th, td { border-color: #33312b; } code { background: #23211c; }
    h2 { border-color: #33312b; } .meta, .weight { color: #a29d94; }
  }
</style>
</head>
<body>
<h1>Scoring rubric — ${escapeHtml(challengeName)}</h1>
<p class="meta">Version ${rubric.version} · frozen ${escapeHtml(rubric.frozenAt ?? 'not frozen')}</p>
<p class="meta">Content hash: <code>${escapeHtml(rubric.contentHash ?? 'not set')}</code></p>
<p>Every submission is scored against these criteria. Each criterion is scored 0–4 against the
anchors below, and every score carries a file-and-line reference to the evidence it rests on.</p>
<h2>How the dimensions combine</h2>
<table><tbody>${weightRows}</tbody></table>
${buildRules}
${rows}
</body>
</html>`
}
