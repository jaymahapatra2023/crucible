/**
 * DMing a member and resolving a username (E49). `fetch` is stubbed; what is under test is the
 * classification of Discord's answers, the nonce that makes a retry safe, and the split that
 * keeps a long message readable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetEnvCache } from '../../config/env.js'
import { DiscordSendError, resetDiscordBreaker, setDiscordSleeper } from './discordClient.js'
import { chunkContent, resolveMember, sendDiscordDm } from './discordApi.js'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const message = {
  to: 'a@b.test', discordUserId: '123456789012345678', subject: 'Your code', body: 'Hello\nline',
  idempotencyKey: 'token-issued/1',
}

beforeEach(() => {
  vi.stubEnv('DISCORD_BOT_TOKEN', 'bot-token-for-tests-1234567890')
  vi.stubEnv('DISCORD_GUILD_ID', '999999999999999999')
  resetEnvCache()
  resetDiscordBreaker()
  setDiscordSleeper(async () => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  resetEnvCache()
})

describe('sending a DM', () => {
  it('opens the DM channel, posts with an enforced nonce, and names the channel', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body ?? '{}')) as Record<string, unknown> })
      return url.endsWith('/users/@me/channels') ? json({ id: 'dm1' }) : json({ id: 'msg1' })
    }))
    const result = await sendDiscordDm(message)
    expect(result).toMatchObject({ delivered: true, channel: 'discord', providerRef: 'discord:msg1' })
    expect(calls[0]!.body).toEqual({ recipient_id: '123456789012345678' })
    expect(calls[1]!.url).toContain('/channels/dm1/messages')
    expect(calls[1]!.body).toMatchObject({ enforce_nonce: true })
    expect(String(calls[1]!.body['nonce'])).toMatch(/^[0-9]{1,25}$/)
    expect(String(calls[1]!.body['content'])).toContain('**Your code**')
  })

  it('is REJECTED, not retried, when the user does not accept DMs (50007)', async () => {
    const fetchMock = vi.fn(async () => json({ code: 50007, message: 'Cannot send messages to this user' }, 403))
    vi.stubGlobal('fetch', fetchMock)
    await expect(sendDiscordDm(message)).rejects.toMatchObject({ kind: 'REJECTED', retryable: false })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries a 5xx, then gives up UNAVAILABLE', async () => {
    const fetchMock = vi.fn(async () => json({ message: 'boom' }, 502))
    vi.stubGlobal('fetch', fetchMock)
    await expect(sendDiscordDm(message)).rejects.toMatchObject({ kind: 'UNAVAILABLE' })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('treats a 429 as retryable', async () => {
    let n = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      n++
      if (n === 1) return json({ retry_after: 0.1, message: 'slow down' }, 429)
      return url.endsWith('/users/@me/channels') ? json({ id: 'dm1' }) : json({ id: 'msg1' })
    }))
    expect((await sendDiscordDm(message)).delivered).toBe(true)
  })

  it('opens the breaker after three transient failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({}, 503)))
    await expect(sendDiscordDm(message)).rejects.toBeInstanceOf(DiscordSendError)
    await expect(sendDiscordDm(message)).rejects.toThrow(/rested for a minute/)
  })

  it('splits a long body at line boundaries and never mid-line', () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i} ${'x'.repeat(60)}`)
    const parts = chunkContent(lines.join('\n'), 500)
    expect(parts.length).toBeGreaterThan(1)
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(500)
    expect(parts.join('\n')).toBe(lines.join('\n'))
  })
})

describe('resolving a username', () => {
  const member = (username: string, id: string, nick: string | null = null) =>
    ({ user: { id, username, global_name: null }, nick })

  it('returns the id for an exact username, case-insensitively', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json([member('Grace_H', '111111111111111111', 'Grace')])))
    expect(await resolveMember('@grace_h')).toEqual({ found: true, userId: '111111111111111111', displayName: 'Grace' })
  })

  it('does not accept a prefix match as the person', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json([member('grace_hopper', '1'.repeat(18))])))
    expect((await resolveMember('grace')).found).toBe(false)
  })

  it('says not in the server, and unavailable when Discord cannot be asked', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json([])))
    expect(await resolveMember('nobody')).toMatchObject({ found: false, reason: 'NOT_IN_SERVER' })
    vi.stubGlobal('fetch', vi.fn(async () => json({}, 503)))
    expect(await resolveMember('nobody')).toMatchObject({ found: false, reason: 'UNAVAILABLE' })
  })
})
