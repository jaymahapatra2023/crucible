import { afterEach, describe, expect, it, vi } from 'vitest'
import { publish, resetHub, runTopic, subscribe, subscriberCount, unsubscribe, unsubscribeAll } from './progressHub.js'

/** Minimal stand-in for a live socket: readyState 1 means OPEN. */
function fakeSocket(readyState = 1) {
  return { readyState, send: vi.fn() } as unknown as Parameters<typeof subscribe>[1] & {
    send: ReturnType<typeof vi.fn>
  }
}

afterEach(() => resetHub())

describe('progress hub (P5.1)', () => {
  it('delivers a message to every subscriber of a topic', () => {
    const a = fakeSocket()
    const b = fakeSocket()
    subscribe('run:1', a)
    subscribe('run:1', b)

    publish('run:1', 'stage', { stage: 'scan', outcome: 'ok' })

    expect(a.send).toHaveBeenCalledOnce()
    expect(b.send).toHaveBeenCalledOnce()
    const message = JSON.parse(a.send.mock.calls[0]![0] as string)
    expect(message).toMatchObject({ topic: 'run:1', type: 'stage', payload: { stage: 'scan' } })
    expect(message.at).toMatch(/^\d{4}-/)
  })

  it('does not deliver across topics', () => {
    const a = fakeSocket()
    subscribe('run:1', a)
    publish('run:2', 'status', { status: 'RUNNING' })
    expect(a.send).not.toHaveBeenCalled()
  })

  it('publishing to a topic with no subscribers is a no-op, not an error', () => {
    expect(() => publish('run:99', 'status', {})).not.toThrow()
  })

  it('skips a socket that is not open', () => {
    const closed = fakeSocket(3)
    subscribe('run:1', closed)
    publish('run:1', 'status', {})
    expect(closed.send).not.toHaveBeenCalled()
  })

  it('one failing subscriber does not stop delivery to the others', () => {
    const bad = fakeSocket()
    bad.send.mockImplementation(() => { throw new Error('socket gone') })
    const good = fakeSocket()
    subscribe('run:1', bad)
    subscribe('run:1', good)

    expect(() => publish('run:1', 'status', {})).not.toThrow()
    expect(good.send).toHaveBeenCalledOnce()
  })

  it('unsubscribes one socket and cleans up the empty topic', () => {
    const a = fakeSocket()
    subscribe('run:1', a)
    expect(subscriberCount('run:1')).toBe(1)
    unsubscribe('run:1', a)
    expect(subscriberCount('run:1')).toBe(0)
  })

  it('unsubscribeAll removes a socket from every topic it joined', () => {
    const a = fakeSocket()
    subscribe('run:1', a)
    subscribe('run:2', a)
    unsubscribeAll(a)
    expect(subscriberCount('run:1')).toBe(0)
    expect(subscriberCount('run:2')).toBe(0)
  })

  it('names run topics consistently', () => {
    expect(runTopic(42)).toBe('run:42')
  })
})
