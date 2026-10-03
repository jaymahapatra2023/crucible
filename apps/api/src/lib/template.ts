/**
 * `{{placeholder}}` substitution, shared (P1.5 clause 6).
 *
 * Lived in the LLM module's prompt renderer until mail templates needed the same thing. Copying
 * it would have been two implementations of one rule; importing it across the module boundary is
 * forbidden (ADR 0002). It is a pure function with no SQL and no module knowledge, which is what
 * `lib/` is for.
 *
 * An unresolved placeholder is an ERROR, not a blank. "Hello ," sent to forty teams is worse than
 * a message that failed to render.
 */
export type TemplateVariables = Record<string, string | number | boolean>

export function substitute(template: string, variables: TemplateVariables): string {
  const missing: string[] = []
  const out = template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, name: string) => {
    if (!(name in variables)) {
      missing.push(name)
      return ''
    }
    return String(variables[name])
  })
  if (missing.length > 0) {
    throw new Error(
      `Template referenced undefined variable(s): ${[...new Set(missing)].join(', ')}.`,
    )
  }
  return out
}

/** The placeholders a template uses, for declaring and checking them. */
export function placeholdersIn(template: string): string[] {
  const found = new Set<string>()
  for (const match of template.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) {
    found.add(match[1] as string)
  }
  return [...found].sort()
}
