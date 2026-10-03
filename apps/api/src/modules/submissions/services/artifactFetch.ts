/**
 * Reading the supporting documents a team attached (E36).
 *
 * `submission.artifact_urls` has held up to five links per team since E03 and nothing has ever
 * read them. Two judging criteria — whether the presentation covers the architecture, and whether
 * the demo depicts the functionality — have no evidence anywhere in a repository, so these links
 * are the only place that evidence can come from.
 *
 * **This is the most dangerous code in the module and it is worth saying why.** It takes a URL
 * chosen by a competition entrant and fetches it from inside the evaluation network. That is
 * server-side request forgery unless the boundary holds, and the text it returns is then shown to
 * a language model that scores that same entrant — which makes it the most directly
 * attacker-controlled input in the system, because the team chooses both the address and every
 * word at it.
 *
 * Four defences, and the first is the only one that fails closed:
 *
 *  1. **An allow-list of hosts.** Not a deny-list of private ranges: a deny-list has to be right
 *     about every redirect, every DNS rebind and every address family, and it only has to be
 *     wrong once. The list starts narrow and a refusal names the host, so widening it is an
 *     organiser's informed decision rather than a guess.
 *  2. **https only, with no credentials in the URL** — the same rule `checkUrl` applies to
 *     repositories.
 *  3. **A byte cap enforced while reading**, not after: a content-length header is a claim.
 *  4. **Extraction through the port**, so only shapes a real extractor handles are read at all.
 *
 * Redirects are not followed. A redirect is the host handing the request to somewhere that was
 * never on the list, which is precisely the hole the list exists to close.
 */
import { AppError } from '../../../lib/appError.js'
import { createLogger } from '../../../lib/logger.js'
import { recordAudit } from '../../../lib/ports/auditPort.js'
import { extraction } from '../../../lib/ports/extractionPort.js'
import { getJson, getNumber } from '../../platform/services/configService.js'
import { selectSubmission } from '../db/submissionDb.js'
import { upsertArtifact, type ArtifactRow, type ArtifactStatus } from '../db/artifactDb.js'

const log = createLogger('submissions', 'artifactFetch')

/** Long enough for a large PDF on a slow host, short enough not to stall a cohort. */
const TIMEOUT_MS = 20_000

interface Attempt {
  status: ArtifactStatus
  contentType: string | null
  bytes: number
  text: string | null
  detail: string
}

export interface FetchReport {
  submissionId: number
  artifacts: ArtifactRow[]
}

/**
 * Fetch every link on a submission, recording an outcome for each.
 *
 * Never throws for a single bad link. A team with one dead URL and one good architecture document
 * must end up with the good one read — failing the whole operation would throw away evidence
 * because of the link that had none.
 */
export async function fetchArtifacts(input: {
  submissionId: number
  actor: string
}): Promise<FetchReport> {
  const submission = await selectSubmission(input.submissionId)
  if (!submission) {
    throw new AppError('NOT_FOUND', `Submission ${input.submissionId} was not found.`)
  }

  const [hosts, maxBytes, maxChars] = await Promise.all([
    getJson<string[]>('submissions.artifact_hosts'),
    getNumber('submissions.artifact_max_bytes'),
    getNumber('submissions.artifact_max_chars'),
  ])

  const artifacts: ArtifactRow[] = []
  for (const url of submission.artifactUrls) {
    const attempt = await attemptOne(url, { hosts, maxBytes, maxChars })
    artifacts.push(await upsertArtifact({
      submissionId: input.submissionId,
      url,
      status: attempt.status,
      contentType: attempt.contentType,
      bytes: attempt.bytes,
      textContent: attempt.text,
      detail: attempt.detail,
      fetchedBy: input.actor,
    }))
  }

  await recordAudit({
    actor: input.actor, action: 'submissions.artifacts_fetched', subjectType: 'submission',
    subjectId: String(input.submissionId),
    // Counts by outcome. Not the URLs: a team's private link is not audit-trail material, and
    // the rows themselves hold them for anyone who needs them.
    payload: {
      total: artifacts.length,
      fetched: artifacts.filter((a) => a.status === 'FETCHED').length,
      refused: artifacts.filter((a) => a.status === 'REFUSED').length,
    },
  })
  log.info('artifacts fetched', {
    submissionId: input.submissionId, total: artifacts.length,
    fetched: artifacts.filter((a) => a.status === 'FETCHED').length,
  })

  return { submissionId: input.submissionId, artifacts }
}

async function attemptOne(
  raw: string, limits: { hosts: readonly string[]; maxBytes: number; maxChars: number },
): Promise<Attempt> {
  const permitted = permit(raw, limits.hosts)
  if (!permitted.ok) {
    return {
      status: 'REFUSED', contentType: null, bytes: 0, text: null, detail: permitted.detail,
    }
  }

  try {
    const response = await fetch(permitted.url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: 'text/plain, text/markdown, text/html, application/pdf, */*' },
    })

    const rejected = rejectResponse(response)
    if (rejected) return rejected

    const contentType = response.headers.get('content-type') ?? 'application/octet-stream'
    const filename = decodeURIComponent(permitted.url.pathname.split('/').pop() ?? 'document')

    if (!extraction().supports(contentType, filename)) {
      return {
        status: 'UNSUPPORTED_TYPE', contentType, bytes: 0, text: null,
        detail: `Nothing here reads '${contentType.split(';')[0]}'. Attach a PDF, a Word `
          + `document, Markdown or plain text.`,
      }
    }

    const body = await readCapped(response, limits.maxBytes)
    if (!body.ok) {
      return {
        status: 'TOO_LARGE', contentType, bytes: body.bytes, text: null,
        detail: `That document is over the ${Math.round(limits.maxBytes / 1024)} KB limit.`,
      }
    }

    const extracted = await extraction().extract({
      buffer: body.buffer, filename, mediaType: contentType,
    })
    if (!extracted.ok || extracted.text.trim() === '') {
      return {
        status: extracted.ok ? 'EMPTY' : 'UNSUPPORTED_TYPE',
        contentType, bytes: body.bytes, text: null,
        detail: extracted.ok
          ? 'The document was read but held no text — a deck of images, most likely.'
          : extracted.detail,
      }
    }

    const truncated = extracted.text.length > limits.maxChars
    return {
      status: 'FETCHED',
      contentType,
      bytes: body.bytes,
      text: truncated ? extracted.text.slice(0, limits.maxChars) : extracted.text,
      // Said plainly, because a reader judging from a truncated document needs to know that is
      // what they are doing (P5.1).
      detail: truncated
        ? `Read the first ${limits.maxChars} characters of ${extracted.text.length}.`
        : '',
    }
  } catch (err) {
    // Deliberately not the raw error: a fetch failure message can carry the resolved address,
    // which tells an entrant about the evaluation network's shape.
    log.warn('artifact fetch failed', { host: permitted.url.hostname, err })
    return {
      status: 'UNREACHABLE', contentType: null, bytes: 0, text: null,
      detail: 'The link could not be fetched within the time allowed.',
    }
  }
}

/**
 * Whether the response itself disqualifies the link, before any body is read.
 *
 * A redirect is REFUSED rather than UNREACHABLE: it hands the request to a host that was never
 * checked, which is the hole the allow-list exists to close. Naming the destination lets an
 * organiser allow it deliberately if that is what they mean.
 */
function rejectResponse(response: Response): Attempt | null {
  if (response.status >= 300 && response.status < 400) {
    return {
      status: 'REFUSED', contentType: null, bytes: 0, text: null,
      detail: `That link redirects to ${response.headers.get('location') ?? 'elsewhere'}, and a `
        + `redirect leaves the allowed hosts. Attach the final address instead.`,
    }
  }
  if (!response.ok) {
    return {
      status: 'UNREACHABLE', contentType: null, bytes: 0, text: null,
      detail: `The host answered ${response.status}. Check the link is public.`,
    }
  }
  return null
}

/** The boundary. Everything past this point is talking to an address an entrant chose. */
function permit(
  raw: string, hosts: readonly string[],
): { ok: true; url: URL } | { ok: false; detail: string } {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return { ok: false, detail: 'That is not a valid URL.' }
  }

  if (url.protocol !== 'https:') {
    return {
      ok: false,
      detail: `Only https:// links are fetched; this one uses ${url.protocol.replace(':', '')}.`,
    }
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, detail: 'Remove the credentials embedded in the link.' }
  }

  const hostname = url.hostname.toLowerCase().replace(/^www\./, '')
  if (!hosts.some((h) => h.toLowerCase() === hostname)) {
    return {
      ok: false,
      // Names the host, so widening the list is a decision rather than a guess.
      detail: `${url.hostname} is not an allowed host for supporting links. Allowed: `
        + `${hosts.join(', ')}.`,
    }
  }
  return { ok: true, url }
}

/**
 * Read the body, stopping at the cap.
 *
 * Streamed rather than trusting `content-length`: the header is a claim by the same host that
 * chose the body, and a 2 KB claim with a 2 GB stream behind it is how a fetch becomes an outage.
 */
async function readCapped(
  response: Response, maxBytes: number,
): Promise<{ ok: true; buffer: Buffer; bytes: number } | { ok: false; bytes: number }> {
  const reader = response.body?.getReader()
  if (!reader) return { ok: true, buffer: Buffer.alloc(0), bytes: 0 }

  const chunks: Buffer[] = []
  let bytes = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (bytes > maxBytes) {
      await reader.cancel()
      return { ok: false, bytes }
    }
    chunks.push(Buffer.from(value))
  }
  return { ok: true, buffer: Buffer.concat(chunks), bytes }
}
