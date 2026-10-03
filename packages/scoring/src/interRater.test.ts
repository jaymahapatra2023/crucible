/**
 * How much the human rankers agree with each other (E33).
 *
 * The number that makes the machine's correlation interpretable. Everything tested here is about
 * refusing to report a comforting figure: one person is not agreement, near-perfect agreement
 * between exactly two people is worth questioning, and the worst pair — not the average — is what
 * a consensus can be trusted to.
 */
import { describe, expect, it } from 'vitest'
import { interRaterAgreement } from './calibration.js'

const ranking = (ranker: string, order: readonly string[]) =>
  order.map((entryId, index) => ({ entryId, ranker, position: index + 1 }))

const ENTRIES = ['a', 'b', 'c', 'd', 'e', 'f']

describe('when there is nobody to disagree with', () => {
  it('reports NONE for a single ranker, never 1.0', () => {
    // The most misleading number the report could carry: one person agrees with themselves by
    // construction, and calling that perfect agreement would invite a GO on one person's taste.
    const result = interRaterAgreement(ranking('ada', ENTRIES))

    expect(result.strength).toBe('NONE')
    expect(result.lowest).toBeNull()
    expect(result.note).toMatch(/Only ada has ranked this set/)
    expect(result.note).toMatch(/one reader's taste/)
  })

  it('says so plainly when nobody has ranked anything', () => {
    const result = interRaterAgreement([])
    expect(result.strength).toBe('NONE')
    expect(result.note).toMatch(/Nobody has ranked this set/)
  })

  it('reports the pair but no coefficient when two rankers share too few entries', () => {
    const result = interRaterAgreement([
      ...ranking('ada', ['a', 'b', 'c']),
      ...ranking('grace', ['d', 'e', 'f']),
    ])
    expect(result.pairs).toHaveLength(1)
    expect(result.pairs[0]?.rho).toBeNull()
    expect(result.strength).toBe('NONE')
    expect(result.note).toMatch(/overlaps on enough entries/)
  })
})

describe('reading the agreement', () => {
  it('is STRONG when two people order a set the same way', () => {
    const result = interRaterAgreement([
      ...ranking('ada', ENTRIES),
      ...ranking('grace', ['a', 'c', 'b', 'd', 'f', 'e']),
    ])
    expect(result.strength).toBe('STRONG')
    expect(result.lowest).toBeGreaterThan(0.7)
  })

  it('is WEAK when they do not share an ordering, and says the machine is not the problem', () => {
    const result = interRaterAgreement([
      ...ranking('ada', ENTRIES),
      ...ranking('grace', ['f', 'e', 'd', 'c', 'b', 'a']),
    ])

    expect(result.strength).toBe('WEAK')
    expect(result.lowest).toBeLessThan(0)
    // The whole reason this measurement exists.
    expect(result.note).toMatch(/no stable human judgement/)
    expect(result.note).toMatch(/not evidence the machine is wrong/)
  })

  it('takes the WORST pair, not the average — a consensus is only as good as its weakest pair', () => {
    const result = interRaterAgreement([
      ...ranking('ada', ENTRIES),
      ...ranking('grace', ENTRIES),
      ...ranking('alan', ['f', 'e', 'd', 'c', 'b', 'a']),
    ])

    expect(result.pairs).toHaveLength(3)
    expect(result.strength).toBe('WEAK')
    // Ada and Grace agree perfectly; averaging would hide Alan entirely.
    expect(result.mean).toBeGreaterThan(result.lowest!)
  })

  it('names every pair, so one outlying ranker stays visible', () => {
    const result = interRaterAgreement([
      ...ranking('ada', ENTRIES),
      ...ranking('grace', ENTRIES),
      ...ranking('alan', ENTRIES),
    ])
    expect(result.pairs.map((p) => `${p.a}|${p.b}`).sort())
      .toEqual(['ada|alan', 'ada|grace', 'alan|grace'])
  })
})

describe('agreement too good to take at face value', () => {
  it('asks whether two near-identical rankings were arrived at independently', () => {
    // The exact shape of the trap this was written for, at the real set's size: eleven
    // repositories, one ordering, three adjacent pairs swapped, entered under two names. ρ is
    // about 0.97 and means nothing at all.
    const eleven = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k']
    const result = interRaterAgreement([
      ...ranking('ranker-a', eleven),
      ...ranking('ranker-b', ['b', 'a', 'd', 'c', 'e', 'f', 'h', 'g', 'i', 'j', 'k']),
    ])

    expect(result.strength).toBe('STRONG')
    expect(result.note).toMatch(/arrived at independently/)
    // A question, not a finding: two people really can land this close.
    expect(result.note).toMatch(/worth asking whether/)
  })

  it('does not ask it of three rankers, where near-agreement is far less suspicious', () => {
    const result = interRaterAgreement([
      ...ranking('ada', ENTRIES),
      ...ranking('grace', ENTRIES),
      ...ranking('alan', ENTRIES),
    ])
    expect(result.note).not.toMatch(/independently/)
  })
})
