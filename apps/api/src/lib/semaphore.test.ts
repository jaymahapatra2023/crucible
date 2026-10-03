import { describe, expect, it } from 'vitest'
import { Semaphore } from './semaphore.js'

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('Semaphore', () => {
  it('permits up to capacity concurrently', async () => {
    const sem = new Semaphore(2)
    let running = 0
    let peak = 0
    const task = async () => sem.run(async () => {
      running++
      peak = Math.max(peak, running)
      await tick()
      running--
    })
    await Promise.all([task(), task(), task(), task(), task()])
    expect(peak).toBe(2)
  })

  it('releases the permit even when the task throws', async () => {
    const sem = new Semaphore(1)
    await expect(sem.run(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(sem.available).toBe(1)
    await expect(sem.run(async () => 'ok')).resolves.toBe('ok')
  })

  it('queues work beyond capacity rather than dropping it', async () => {
    const sem = new Semaphore(1)
    const order: number[] = []
    const tasks = [1, 2, 3].map((n) => sem.run(async () => { order.push(n); await tick() }))
    await Promise.all(tasks)
    expect(order).toEqual([1, 2, 3])
  })

  it('grows capacity at runtime and releases waiters immediately', async () => {
    const sem = new Semaphore(1)
    let concurrent = 0
    let peak = 0
    const task = async () => sem.run(async () => {
      concurrent++; peak = Math.max(peak, concurrent)
      await new Promise((r) => setTimeout(r, 20))
      concurrent--
    })
    const running = [task(), task(), task()]
    sem.resize(3)
    await Promise.all(running)
    expect(peak).toBeGreaterThan(1)
  })

  it('treats a capacity below one as one', () => {
    expect(new Semaphore(0).available).toBe(1)
    expect(new Semaphore(-5).available).toBe(1)
  })
})
