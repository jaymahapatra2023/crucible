import { describe, expect, it } from 'vitest'
import { extractJson } from './jsonExtraction.js'

describe('extractJson', () => {
  describe('direct parse', () => {
    it('parses a bare object', () => {
      const r = extractJson('{"score":3,"why":"ok"}')
      expect(r.ok).toBe(true)
      expect(r.method).toBe('direct')
      expect(r.value).toEqual({ score: 3, why: 'ok' })
    })

    it('parses a bare array', () => {
      const r = extractJson('[1,2,3]')
      expect(r.ok).toBe(true)
      expect(r.value).toEqual([1, 2, 3])
    })

    it('tolerates surrounding whitespace', () => {
      expect(extractJson('\n\n  {"a":1}  \n').value).toEqual({ a: 1 })
    })
  })

  describe('fenced blocks', () => {
    it('extracts from a ```json fence', () => {
      const r = extractJson('Here you go:\n```json\n{"a":1}\n```\nHope that helps.')
      expect(r.ok).toBe(true)
      expect(r.method).toBe('fenced')
      expect(r.value).toEqual({ a: 1 })
    })

    it('extracts from an untagged fence', () => {
      expect(extractJson('```\n{"a":1}\n```').value).toEqual({ a: 1 })
    })

    it('takes the first complete fenced block when several are present', () => {
      const r = extractJson('```json\n{"first":true}\n```\nand\n```json\n{"second":true}\n```')
      expect(r.value).toEqual({ first: true })
    })
  })

  describe('leading and trailing prose', () => {
    it('recovers an object buried in prose', () => {
      const r = extractJson('I considered the repository carefully. {"score":4} That is my answer.')
      expect(r.ok).toBe(true)
      expect(r.method).toBe('balanced-scan')
      expect(r.value).toEqual({ score: 4 })
    })

    it('is not fooled by braces inside string values', () => {
      const r = extractJson('Result: {"note":"a } brace and a { brace","n":1} done')
      expect(r.ok).toBe(true)
      expect(r.value).toEqual({ note: 'a } brace and a { brace', n: 1 })
    })

    it('is not fooled by escaped quotes', () => {
      const r = extractJson('x {"q":"he said \\"hi\\" loudly"} y')
      expect(r.value).toEqual({ q: 'he said "hi" loudly' })
    })
  })

  describe('truncated output', () => {
    it('repairs an object cut off after a complete pair', () => {
      const r = extractJson('{"a":1,"b":2')
      expect(r.ok).toBe(true)
      expect(r.method).toBe('repaired-truncation')
      expect(r.value).toEqual({ a: 1, b: 2 })
    })

    it('repairs nested structures cut off mid-array', () => {
      const r = extractJson('{"items":[{"id":1},{"id":2}')
      expect(r.ok).toBe(true)
      expect(r.value).toEqual({ items: [{ id: 1 }, { id: 2 }] })
    })

    it('drops a dangling key with no value rather than inventing one', () => {
      const r = extractJson('{"a":1,"b":')
      expect(r.ok).toBe(true)
      expect(r.value).toEqual({ a: 1 })
    })

    it('repairs inside an unterminated fence', () => {
      const r = extractJson('```json\n{"a":1,"b":2')
      expect(r.ok).toBe(true)
      expect(r.value).toEqual({ a: 1, b: 2 })
    })

    it('keeps a trailing string inside an array — it is a value, not a dangling key', () => {
      const r = extractJson('{"tags":["alpha","beta"')
      expect(r.ok).toBe(true)
      expect(r.value).toEqual({ tags: ['alpha', 'beta'] })
    })

    it('drops a dangling key that has a colon but no value', () => {
      const r = extractJson('{"a":1,"b":  ')
      expect(r.ok).toBe(true)
      expect(r.value).toEqual({ a: 1 })
    })

    it('handles a string truncated mid-value', () => {
      const r = extractJson('{"a":1,"b":"partial text that never clos')
      expect(r.ok).toBe(true)
      expect(r.value).toEqual({ a: 1 })
    })

    it('never fabricates a value for a truncated pair', () => {
      const r = extractJson('{"score":')
      // Either it fails, or it yields an object without a fabricated score — never score:0.
      if (r.ok) expect(r.value).not.toHaveProperty('score')
    })
  })

  describe('failure', () => {
    it('fails loudly on empty output', () => {
      const r = extractJson('')
      expect(r.ok).toBe(false)
      expect(r.error).toMatch(/empty/i)
    })

    it('fails loudly when there is no JSON at all', () => {
      const r = extractJson('I am unable to answer that question.')
      expect(r.ok).toBe(false)
      expect(r.error).toMatch(/no parseable json/i)
    })

    it('fails on a non-string input', () => {
      expect(extractJson(undefined as unknown as string).ok).toBe(false)
    })
  })
})
