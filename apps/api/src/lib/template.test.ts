/**
 * Placeholder substitution, shared by prompts and mail (E43, P1.5 clause 6).
 *
 * The property that matters is the refusal: a missing variable is an error before the text
 * exists, not a blank inside it. "Hello ," arriving at forty addresses is the failure this stops.
 */
import { describe, expect, it } from 'vitest'
import { placeholdersIn, substitute } from './template.js'

describe('substitute', () => {
  it('fills every placeholder, tolerating whitespace inside the braces', () => {
    expect(substitute('Hello {{ name }}, code {{code}}.', { name: 'Ada', code: 42 }))
      .toBe('Hello Ada, code 42.')
  })

  it('REFUSES a missing variable rather than rendering a blank', () => {
    expect(() => substitute('Hello {{name}},', {}))
      .toThrow(/undefined variable\(s\): name/)
  })

  it('names every missing variable at once, de-duplicated', () => {
    expect(() => substitute('{{a}} {{b}} {{a}}', {}))
      .toThrow(/undefined variable\(s\): a, b\./)
  })

  it('leaves text with no placeholders alone', () => {
    expect(substitute('nothing here', { unused: 1 })).toBe('nothing here')
  })
})

describe('placeholdersIn', () => {
  it('lists each placeholder once, sorted', () => {
    expect(placeholdersIn('{{z}} and {{a}} and {{ z }}')).toEqual(['a', 'z'])
  })
})
