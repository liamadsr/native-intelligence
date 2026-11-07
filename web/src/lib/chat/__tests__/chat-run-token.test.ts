/**
 * Signed chat-run-token tests (the eve chat runtime's trust boundary).
 *
 * The token is the whole cross-instance mechanism: it must round-trip (including
 * the optional agentId/skillId), reject tampering, reject expiry, and
 * reject a wrong/absent secret, honoring the CHAT_INTERNAL_SECRET →
 * RUN_SKILL_INTERNAL_SECRET fallback.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  CHAT_RUN_TOKEN_HEADER,
  extractChatRunToken,
  isBotConversation,
  mintChatRunToken,
  HOME_TURN_TOKEN_MAX_TTL_MS,
  verifyChatRunToken,
  verifyInternalSecret,
  internalSecret,
  type ChatRunTokenClaims,
} from '../chat-run-token'

const SECRET = 'test-chat-internal-secret-1234567890'

const CLAIMS: Omit<ChatRunTokenClaims, 'exp'> = {
  conversationId: 'conv-1',
  workspaceId: 'ws-1',
  userId: 'user-1',
  agentId: 'agent-1',
  skillId: 'skill-1',
}

describe('chat-run token sign/verify', () => {
  beforeEach(() => {
    process.env.CHAT_INTERNAL_SECRET = SECRET
  })
  afterEach(() => {
    delete process.env.CHAT_INTERNAL_SECRET
    delete process.env.RUN_SKILL_INTERNAL_SECRET
  })

  it('round-trips the claims (incl. optional agentId/skillId)', () => {
    const token = mintChatRunToken(CLAIMS)
    const verified = verifyChatRunToken(token)
    expect(verified).not.toBeNull()
    expect(verified!.conversationId).toBe('conv-1')
    expect(verified!.workspaceId).toBe('ws-1')
    expect(verified!.userId).toBe('user-1')
    expect(verified!.agentId).toBe('agent-1')
    expect(verified!.skillId).toBe('skill-1')
    expect(typeof verified!.exp).toBe('number')
  })

  it('round-trips with agentId/skillId ABSENT (default assistant)', () => {
    const token = mintChatRunToken({ conversationId: 'c', workspaceId: 'w', userId: 'u' })
    const verified = verifyChatRunToken(token)
    expect(verified).not.toBeNull()
    expect(verified!.agentId).toBeUndefined()
    expect(verified!.skillId).toBeUndefined()
  })

  it('round-trips the device surface claim (absent for in-app chat)', () => {
    const device = verifyChatRunToken(
      mintChatRunToken({ conversationId: 'conv-dev', workspaceId: 'w', userId: 'u', surface: 'device_ask' }),
    )
    expect(device!.surface).toBe('device_ask')
    expect(verifyChatRunToken(mintChatRunToken(CLAIMS))!.surface).toBeUndefined()
  })

  it('round-trips the teammate claim (bots v2) — absent for an ordinary chat, and NOT a surface', () => {
    const t = verifyChatRunToken(mintChatRunToken({ ...CLAIMS, teammateId: 'tm-1' }))
    expect(t!.teammateId).toBe('tm-1')
    expect(t!.surface).toBeUndefined()
    expect(verifyChatRunToken(mintChatRunToken(CLAIMS))!.teammateId).toBeUndefined()
  })

  it('rejects a validly-signed token whose teammateId is empty or not a string', () => {
    const { createHmac } = require('node:crypto')
    const signed = (claims: Record<string, unknown>) => {
      const payload = Buffer.from(JSON.stringify({ ...claims, exp: Date.now() + 60_000 }), 'utf8').toString('base64url')
      return `${payload}.${createHmac('sha256', SECRET).update(payload).digest('base64url')}`
    }
    expect(verifyChatRunToken(signed({ ...CLAIMS, teammateId: '' }))).toBeNull()
    expect(verifyChatRunToken(signed({ ...CLAIMS, teammateId: 7 }))).toBeNull()
    expect(verifyChatRunToken(signed({ ...CLAIMS, teammateId: 'tm-1' }))!.teammateId).toBe('tm-1')
  })

  it('round-trips a teammate chat’s item (bots v3 1d), and refuses one without a teammate', () => {
    const job = '77777777-7777-4777-8777-777777777777'
    const t = verifyChatRunToken(mintChatRunToken({ ...CLAIMS, teammateId: 'tm-1', aboutWorkItemId: job }))
    expect(t!.aboutWorkItemId).toBe(job)
    expect(verifyChatRunToken(mintChatRunToken({ ...CLAIMS, teammateId: 'tm-1', aboutCardId: 'card-1' }))!.aboutCardId).toBe('card-1')
    expect(verifyChatRunToken(mintChatRunToken(CLAIMS))!.aboutWorkItemId).toBeUndefined()
    const { createHmac } = require('node:crypto')
    const signed = (claims: Record<string, unknown>) => {
      const payload = Buffer.from(JSON.stringify({ ...claims, exp: Date.now() + 60_000 }), 'utf8').toString('base64url')
      return `${payload}.${createHmac('sha256', SECRET).update(payload).digest('base64url')}`
    }
    expect(verifyChatRunToken(signed({ ...CLAIMS, aboutWorkItemId: job }))).toBeNull()
    expect(verifyChatRunToken(signed({ ...CLAIMS, aboutCardId: 'card-1' }))).toBeNull()
    expect(verifyChatRunToken(signed({ ...CLAIMS, teammateId: 'tm-1', aboutWorkItemId: 7 }))).toBeNull()
  })

  it('round-trips a bot conversation (bots v4 Phase C: teammateIn chat), only with a teammate and never about an item', () => {
    const t = verifyChatRunToken(mintChatRunToken({ conversationId: 'conv-bot', workspaceId: 'w', userId: 'u', teammateId: 'tm-1', teammateIn: 'chat' }))
    expect(t).toMatchObject({ teammateId: 'tm-1', teammateIn: 'chat' })
    expect(t!.surface).toBeUndefined()
    expect(isBotConversation(t!)).toBe(true)
    // A teammate token without it is the bot's own thread.
    const thread = verifyChatRunToken(mintChatRunToken({ ...CLAIMS, teammateId: 'tm-1' }))!
    expect(thread.teammateIn).toBeUndefined()
    expect(isBotConversation(thread)).toBe(false)
    expect(isBotConversation(verifyChatRunToken(mintChatRunToken(CLAIMS))!)).toBe(false)
    const { createHmac } = require('node:crypto')
    const signed = (claims: Record<string, unknown>) => {
      const payload = Buffer.from(JSON.stringify({ ...claims, exp: Date.now() + 60_000 }), 'utf8').toString('base64url')
      return `${payload}.${createHmac('sha256', SECRET).update(payload).digest('base64url')}`
    }
    const base = { conversationId: 'c', workspaceId: 'w', userId: 'u' }
    expect(verifyChatRunToken(signed({ ...base, teammateIn: 'chat' }))).toBeNull()
    expect(verifyChatRunToken(signed({ ...base, teammateId: 'tm-1', teammateIn: 'thread' }))).toBeNull()
    expect(verifyChatRunToken(signed({ ...base, teammateId: 'tm-1', teammateIn: 7 }))).toBeNull()
    expect(verifyChatRunToken(signed({ ...base, teammateId: 'tm-1', teammateIn: 'chat', aboutCardId: 'card-1' }))).toBeNull()
    expect(verifyChatRunToken(signed({ ...base, teammateId: 'tm-1', teammateIn: 'chat', aboutWorkItemId: 'job-1' }))).toBeNull()
    expect(verifyChatRunToken(signed({ ...base, teammateId: 'tm-1', teammateIn: 'chat' }))!.teammateIn).toBe('chat')
  })

  it('round-trips a focused conversation (one-agent S3: focusArea), the main agent’s only: never with a teammate or a surface', () => {
    const t = verifyChatRunToken(mintChatRunToken({ conversationId: 'conv-f', workspaceId: 'w', userId: 'u', focusArea: 'mail' }))
    expect(t).toMatchObject({ focusArea: 'mail' })
    const { createHmac } = require('node:crypto')
    const signed = (claims: Record<string, unknown>) => {
      const payload = Buffer.from(JSON.stringify({ ...claims, exp: Date.now() + 60_000 }), 'utf8').toString('base64url')
      return `${payload}.${createHmac('sha256', SECRET).update(payload).digest('base64url')}`
    }
    const base = { conversationId: 'c', workspaceId: 'w', userId: 'u' }
    expect(verifyChatRunToken(signed({ ...base, focusArea: 'inbox' }))).toBeNull()
    expect(verifyChatRunToken(signed({ ...base, focusArea: 'mail', teammateId: 'tm-1' }))).toBeNull()
    expect(verifyChatRunToken(signed({ ...base, focusArea: 'mail', teammateId: 'tm-1', teammateIn: 'chat' }))).toBeNull()
    expect(verifyChatRunToken(signed({ ...base, focusArea: 'mail', surface: 'device_ask' }))).toBeNull()
    expect(verifyChatRunToken(signed({ ...base, focusArea: 'crm' }))!.focusArea).toBe('crm')
  })

  it('round-trips a server-minted token (idle compaction, a home turn), and refuses any other server value', () => {
    const t = verifyChatRunToken(mintChatRunToken({ conversationId: 'c', workspaceId: 'w', userId: 'u', server: 'idle_compaction' }))
    expect(t).toMatchObject({ server: 'idle_compaction' })
    const { createHmac } = require('node:crypto')
    const signed = (claims: Record<string, unknown>) => {
      const payload = Buffer.from(JSON.stringify({ ...claims, exp: Date.now() + 60_000 }), 'utf8').toString('base64url')
      return `${payload}.${createHmac('sha256', SECRET).update(payload).digest('base64url')}`
    }
    const base = { conversationId: 'c', workspaceId: 'w', userId: 'u' }
    expect(verifyChatRunToken(signed({ ...base, server: 'home_turn' }))).toMatchObject({ server: 'home_turn' })
    expect(verifyChatRunToken(signed({ ...base, server: 'root' }))).toBeNull()
    expect(verifyChatRunToken(signed({ ...base, server: true }))).toBeNull()
    // Never with a sealed credential, a surface or a relay.
    expect(verifyChatRunToken(signed({ ...base, server: 'home_turn', cred: 'sealed' }))).toBeNull()
    expect(verifyChatRunToken(signed({ ...base, server: 'home_turn', surface: 'device_ask' }))).toBeNull()
    // A home turn's reason: a known one, only on a home turn's token.
    expect(verifyChatRunToken(signed({ ...base, server: 'home_turn', homeTurnReason: 'event' }))).toMatchObject({ server: 'home_turn', homeTurnReason: 'event' })
    expect(verifyChatRunToken(signed({ ...base, server: 'home_turn', homeTurnReason: 'text' }))).toBeNull()
    expect(verifyChatRunToken(signed({ ...base, server: 'home_turn', homeTurnReason: 'anything' }))).toBeNull()
    expect(verifyChatRunToken(signed({ ...base, server: 'idle_compaction', homeTurnReason: 'event' }))).toBeNull()
    expect(verifyChatRunToken(signed({ ...base, server: 'channel_turn', surface: 'sms', homeTurnReason: 'event' }))).toBeNull()
    expect(verifyChatRunToken(signed({ ...base, homeTurnReason: 'event' }))).toBeNull()
  })

  it('round-trips a relayed thread turn (bots v4 Phase A4: relay), only in a bot’s own thread', () => {
    const t = verifyChatRunToken(mintChatRunToken({ conversationId: 'thread', workspaceId: 'w', userId: 'u', teammateId: 'tm-1', relay: 'relay-1', aboutWorkItemId: 'job-1' }))
    expect(t).toMatchObject({ teammateId: 'tm-1', relay: 'relay-1', aboutWorkItemId: 'job-1' })
    expect(t!.surface).toBeUndefined()
    const { createHmac } = require('node:crypto')
    const signed = (claims: Record<string, unknown>) => {
      const payload = Buffer.from(JSON.stringify({ ...claims, exp: Date.now() + 60_000 }), 'utf8').toString('base64url')
      return `${payload}.${createHmac('sha256', SECRET).update(payload).digest('base64url')}`
    }
    const base = { conversationId: 'c', workspaceId: 'w', userId: 'u' }
    // Never the main chat's, a bot conversation's or a surface's; always a non-empty string.
    expect(verifyChatRunToken(signed({ ...base, relay: 'relay-1' }))).toBeNull()
    expect(verifyChatRunToken(signed({ ...base, teammateId: 'tm-1', teammateIn: 'chat', relay: 'relay-1' }))).toBeNull()
    expect(verifyChatRunToken(signed({ ...base, teammateId: 'tm-1', surface: 'device_ask', relay: 'relay-1' }))).toBeNull()
    expect(verifyChatRunToken(signed({ ...base, teammateId: 'tm-1', relay: '' }))).toBeNull()
    expect(verifyChatRunToken(signed({ ...base, teammateId: 'tm-1', relay: 7 }))).toBeNull()
    expect(verifyChatRunToken(signed({ ...base, teammateId: 'tm-1', relay: 'relay-1' }))!.relay).toBe('relay-1')
  })

  it('rejects a validly-signed token carrying an UNKNOWN surface', () => {
    const { createHmac } = require('node:crypto')
    const payload = Buffer.from(
      JSON.stringify({ ...CLAIMS, surface: 'admin', exp: Date.now() + 60_000 }),
      'utf8',
    ).toString('base64url')
    const sig = createHmac('sha256', SECRET).update(payload).digest('base64url')
    expect(verifyChatRunToken(`${payload}.${sig}`)).toBeNull()
  })

  it('a sealed credential (cred) round-trips on a surface AND a browser token, and is refused as a non-string', () => {
    const { createHmac } = require('node:crypto')
    const signed = (claims: Record<string, unknown>) => {
      const payload = Buffer.from(JSON.stringify({ ...claims, exp: Date.now() + 60_000 }), 'utf8').toString('base64url')
      return `${payload}.${createHmac('sha256', SECRET).update(payload).digest('base64url')}`
    }
    const device = { conversationId: 'conv-dev', workspaceId: 'w', userId: 'u', surface: 'device_ask' as const }
    expect(verifyChatRunToken(mintChatRunToken({ ...device, cred: 'sealed-blob' }))!.cred).toBe('sealed-blob')
    expect(verifyChatRunToken(signed({ ...CLAIMS, cred: 'sealed-blob' }))!.cred).toBe('sealed-blob')
    expect(verifyChatRunToken(signed({ ...CLAIMS, cred: 42 }))).toBeNull()
    expect(verifyChatRunToken(signed({ ...device, cred: 42 }))).toBeNull()
  })

  it('round-trips the ChatGPT plan claim (the free tier), only as exactly true', () => {
    const { createHmac } = require('node:crypto')
    const signed = (claims: Record<string, unknown>) => {
      const payload = Buffer.from(JSON.stringify({ ...claims, exp: Date.now() + 60_000 }), 'utf8').toString('base64url')
      return `${payload}.${createHmac('sha256', SECRET).update(payload).digest('base64url')}`
    }
    expect(verifyChatRunToken(mintChatRunToken({ ...CLAIMS, chatgptPlan: true }))!.chatgptPlan).toBe(true)
    expect(verifyChatRunToken(mintChatRunToken(CLAIMS))!.chatgptPlan).toBeUndefined()
    expect(verifyChatRunToken(signed({ ...CLAIMS, chatgptPlan: 'yes' }))).toBeNull()
    expect(verifyChatRunToken(signed({ ...CLAIMS, chatgptPlan: false }))).toBeNull()
  })

  describe('ttlMs override (device ask)', () => {
    const DEVICE = { conversationId: 'conv-dev', workspaceId: 'w', userId: 'u', surface: 'device_ask' as const }
    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-09-25T12:00:00Z'))
    })
    afterEach(() => vi.useRealTimers())

    it('a short-TTL device token is refused once its TTL passes, while a default chat token keeps 60 min', () => {
      const device = mintChatRunToken(DEVICE, { ttlMs: 73_000 })
      const chat = mintChatRunToken(CLAIMS)
      expect(verifyChatRunToken(device)!.exp - Date.now()).toBe(73_000)
      expect(verifyChatRunToken(chat)!.exp - Date.now()).toBe(60 * 60 * 1000)
      vi.setSystemTime(Date.now() + 73_001)
      expect(verifyChatRunToken(device)).toBeNull()
      expect(verifyChatRunToken(chat)).not.toBeNull()
    })

    it('can only SHORTEN: a ttlMs above the default is clamped to 60 min', () => {
      const t = mintChatRunToken(DEVICE, { ttlMs: 24 * 60 * 60 * 1000 })
      expect(verifyChatRunToken(t)!.exp - Date.now()).toBe(60 * 60 * 1000)
    })

    it('a home turn’s server token alone may outlive 60 min (its turn’s hour plus a later idle compaction), clamped at 90', () => {
      const home = { conversationId: 'conv-home', workspaceId: 'w', userId: 'u', server: 'home_turn' as const }
      expect(verifyChatRunToken(mintChatRunToken(home, { ttlMs: 84 * 60_000 }))!.exp - Date.now()).toBe(84 * 60_000)
      expect(verifyChatRunToken(mintChatRunToken(home, { ttlMs: 24 * 60 * 60_000 }))!.exp - Date.now()).toBe(HOME_TURN_TOKEN_MAX_TTL_MS)
      expect(HOME_TURN_TOKEN_MAX_TTL_MS).toBe(90 * 60_000)
      // Any other caller, idle compaction's server token included, stays at 60.
      const idle = { ...home, server: 'idle_compaction' as const }
      expect(verifyChatRunToken(mintChatRunToken(idle, { ttlMs: 84 * 60_000 }))!.exp - Date.now()).toBe(60 * 60 * 1000)
      expect(verifyChatRunToken(mintChatRunToken(CLAIMS, { ttlMs: 84 * 60_000 }))!.exp - Date.now()).toBe(60 * 60 * 1000)
    })

    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects a ttlMs of %s', (ttlMs) => {
      expect(() => mintChatRunToken(DEVICE, { ttlMs })).toThrow(/ttlMs/)
    })
  })

  it('rejects a TAMPERED payload (signature mismatch)', () => {
    const token = mintChatRunToken(CLAIMS)
    const [payload, sig] = token.split('.')
    const tamperedPayload = Buffer.from(
      JSON.stringify({ ...CLAIMS, workspaceId: 'ws-ATTACKER', exp: Date.now() + 60_000 }),
      'utf8',
    ).toString('base64url')
    expect(verifyChatRunToken(`${tamperedPayload}.${sig}`)).toBeNull()
    expect(verifyChatRunToken(`${payload}.${sig.slice(0, -2)}xy`)).toBeNull()
  })

  it('rejects an EXPIRED token', () => {
    const { createHmac } = require('node:crypto')
    const expiredPayload = Buffer.from(
      JSON.stringify({ ...CLAIMS, exp: Date.now() - 1000 }),
      'utf8',
    ).toString('base64url')
    const sig = createHmac('sha256', SECRET).update(expiredPayload).digest('base64url')
    expect(verifyChatRunToken(`${expiredPayload}.${sig}`)).toBeNull()
  })

  it('rejects when the secret is UNSET (fail closed)', () => {
    const token = mintChatRunToken(CLAIMS)
    delete process.env.CHAT_INTERNAL_SECRET
    expect(verifyChatRunToken(token)).toBeNull()
  })

  it('rejects a token signed with a DIFFERENT secret', () => {
    const token = mintChatRunToken(CLAIMS)
    process.env.CHAT_INTERNAL_SECRET = 'a-completely-different-secret'
    expect(verifyChatRunToken(token)).toBeNull()
  })

  it('rejects malformed input', () => {
    expect(verifyChatRunToken('')).toBeNull()
    expect(verifyChatRunToken(null)).toBeNull()
    expect(verifyChatRunToken('no-dot')).toBeNull()
    expect(verifyChatRunToken('.onlysig')).toBeNull()
    expect(verifyChatRunToken('onlypayload.')).toBeNull()
  })

  it('mint throws when the secret is unset', () => {
    delete process.env.CHAT_INTERNAL_SECRET
    expect(() => mintChatRunToken(CLAIMS)).toThrow(/CHAT_INTERNAL_SECRET/)
  })

  it('falls back to RUN_SKILL_INTERNAL_SECRET when CHAT_INTERNAL_SECRET is unset', () => {
    delete process.env.CHAT_INTERNAL_SECRET
    process.env.RUN_SKILL_INTERNAL_SECRET = SECRET
    const token = mintChatRunToken(CLAIMS)
    expect(verifyChatRunToken(token)).not.toBeNull()
  })
})

describe('verifyInternalSecret (constant-time shared secret)', () => {
  beforeEach(() => {
    process.env.CHAT_INTERNAL_SECRET = SECRET
  })
  afterEach(() => {
    delete process.env.CHAT_INTERNAL_SECRET
    delete process.env.RUN_SKILL_INTERNAL_SECRET
  })

  it('accepts the exact secret', () => {
    expect(verifyInternalSecret(SECRET)).toBe(true)
  })
  it('rejects a wrong secret, empty, null, and length mismatch', () => {
    expect(verifyInternalSecret('wrong')).toBe(false)
    expect(verifyInternalSecret('')).toBe(false)
    expect(verifyInternalSecret(null)).toBe(false)
    expect(verifyInternalSecret(SECRET + 'x')).toBe(false)
  })
  it('rejects everything when the env secret is unset', () => {
    delete process.env.CHAT_INTERNAL_SECRET
    expect(verifyInternalSecret(SECRET)).toBe(false)
    expect(internalSecret()).toBeNull()
  })
})

describe('extractChatRunToken', () => {
  it('reads the token from its header ONLY (never ?token=, which lands in logs)', () => {
    const withHeader = new Request('https://app.test/x?token=from-query', { headers: { [CHAT_RUN_TOKEN_HEADER]: 'from-header' } })
    expect(extractChatRunToken(withHeader)).toBe('from-header')
    expect(extractChatRunToken(new Request('https://app.test/x?token=from-query'))).toBeNull()
  })
})
