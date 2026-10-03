/**
 * Counting semaphore for bounded parallelism (E10-S02, P11.1).
 *
 * Crucible's concurrency limits are configuration (P3.6), so the permit count is resizable at
 * runtime: an operator who lowers `llm.concurrency` mid-run takes effect on the next acquire
 * rather than requiring a restart.
 */

export class Semaphore {
  private permits: number
  private capacity: number
  private readonly waiting: Array<() => void> = []

  constructor(capacity: number) {
    this.capacity = Math.max(1, capacity)
    this.permits = this.capacity
  }

  get available(): number {
    return this.permits
  }

  get queued(): number {
    return this.waiting.length
  }

  /** Change the permit count. Growing releases waiters immediately. */
  resize(capacity: number): void {
    const next = Math.max(1, capacity)
    const delta = next - this.capacity
    this.capacity = next
    this.permits += delta
    while (this.permits > 0 && this.waiting.length > 0) {
      const resolve = this.waiting.shift()
      if (!resolve) break
      this.permits--
      resolve()
    }
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--
      return
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve))
  }

  release(): void {
    const resolve = this.waiting.shift()
    if (resolve) {
      resolve()
      return
    }
    if (this.permits < this.capacity) this.permits++
  }

  /** Run `fn` holding one permit, releasing it even if `fn` throws. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }
}
