/**
 * Rendering a mail template (E43-S02, P3.3).
 *
 * Services pass variables and get a subject and body back. The wording lives in the database,
 * versioned, so an organiser can fix a sentence forty teams will read without a deploy — and so
 * the exact text a team received is recoverable from the version that was active at the time.
 *
 * A missing variable is an error before the message exists, not a blank inside it. "Hello ,"
 * arriving at forty addresses is the failure this refuses to produce.
 */
import { AppError } from '../../../lib/appError.js'
import { substitute, type TemplateVariables } from '../../../lib/template.js'
import { selectActiveMailTemplate } from '../db/mailTemplateDb.js'

export interface RenderedMail {
  subject: string
  body: string
  /** Which version produced it, recorded with the delivery so wording changes are traceable. */
  templateVersion: number
}

export async function renderMail(mailKey: string, variables: TemplateVariables): Promise<RenderedMail> {
  const template = await selectActiveMailTemplate(mailKey)
  if (!template) {
    throw new AppError('INTERNAL_ERROR',
      `No active mail template for '${mailKey}'. Templates are created by migration (P3.3); `
      + 'this one is missing or every version has been deactivated.')
  }

  // Declared variables are checked against what was supplied BEFORE substitution, so the
  // refusal names every missing one at once rather than the first the body happens to reach.
  const missing = template.variables.filter((name) => !(name in variables))
  if (missing.length > 0) {
    throw new AppError('INTERNAL_ERROR',
      `Mail template '${mailKey}' v${template.version} needs ${missing.join(', ')} and was not `
      + 'given them.')
  }

  return {
    subject: substitute(template.subject, variables),
    body: substitute(template.body, variables),
    templateVersion: template.version,
  }
}
