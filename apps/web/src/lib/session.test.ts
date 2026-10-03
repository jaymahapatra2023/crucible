/**
 * The session snapshot is stable (E50): a store snapshot that changes reference on every read
 * makes React loop, which is exactly what took every page down until this test existed.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { endSession, getUserSnapshot, startSession } from './session.js'

beforeEach(() => endSession())

describe('getUserSnapshot', () => {
  it('returns the same reference while the session is unchanged', () => {
    startSession('tok', { userId: '1', email: 'a@b.c', displayName: 'A', role: 'admin' })
    const first = getUserSnapshot()
    expect(first).not.toBeNull()
    expect(getUserSnapshot()).toBe(first)
  })

  it('changes reference only when the session changes', () => {
    startSession('tok', { userId: '1', email: 'a@b.c', displayName: 'A', role: 'admin' })
    const first = getUserSnapshot()
    startSession('tok2', { userId: '2', email: 'b@b.c', displayName: 'B', role: 'viewer' })
    const second = getUserSnapshot()
    expect(second).not.toBe(first)
    expect(second?.role).toBe('viewer')
    endSession()
    expect(getUserSnapshot()).toBeNull()
  })
})
