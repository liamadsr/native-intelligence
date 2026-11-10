/**
 * The caller's Supabase JWT sealed into a device-ask run token
 * (src/lib/chat/chat-run-credential.ts): AES-256-GCM under a key derived from
 * the chat internal secret, bound to the token's (conversationId, userId,
 * workspaceId). Pinned: it round-trips for its own binding; it never opens for
 * another binding, a tampered blob, another secret, or a JWT naming a user other
 * than the binding's; and the sealed form never contains the JWT in the clear.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { sealRunCredential, openRunCredential } from '../chat-run-credential'

const SECRET = 'test-chat-internal-secret-abcdefghij'
const BIND = { conversationId: 'conv-dev', userId: 'user-1', workspaceId: 'ws-1' }
const jwtFor = (sub: string) =>
  `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ sub, role: 'authenticated' })).toString('base64url')}.c2ln`

describe('sealRunCredential / openRunCredential', () => {
  beforeEach(() => {
    process.env.CHAT_INTERNAL_SECRET = SECRET
  })
  afterEach(() => {
    delete process.env.CHAT_INTERNAL_SECRET
    delete process.env.RUN_SKILL_INTERNAL_SECRET
  })

  it('round-trips for its own binding, and the sealed form hides the JWT', () => {
    const jwt = jwtFor('user-1')
    const sealed = sealRunCredential(jwt, BIND)
    expect(sealed).not.toContain(jwt.split('.')[1])
    expect(Buffer.from(sealed, 'base64url').toString('utf8')).not.toContain('user-1')
    expect(openRunCredential(sealed, BIND)).toBe(jwt)
  })

  it('a fresh IV per seal (two seals of the same JWT differ)', () => {
    const jwt = jwtFor('user-1')
    expect(sealRunCredential(jwt, BIND)).not.toBe(sealRunCredential(jwt, BIND))
  })

  it.each([
    ['another conversation', { ...BIND, conversationId: 'conv-other' }],
    ['another user', { ...BIND, userId: 'user-2' }],
    ['another workspace', { ...BIND, workspaceId: 'ws-2' }],
  ])('never opens for %s', (_label, bind) => {
    expect(openRunCredential(sealRunCredential(jwtFor('user-1'), BIND), bind)).toBeNull()
  })

  it('never opens a tampered blob, garbage, or an empty string', () => {
    const raw = Buffer.from(sealRunCredential(jwtFor('user-1'), BIND), 'base64url')
    raw[raw.length - 1] ^= 0x01
    expect(openRunCredential(raw.toString('base64url'), BIND)).toBeNull()
    expect(openRunCredential('not-a-blob', BIND)).toBeNull()
    expect(openRunCredential('', BIND)).toBeNull()
  })

  it('never opens under another secret, or with no secret at all', () => {
    const sealed = sealRunCredential(jwtFor('user-1'), BIND)
    process.env.CHAT_INTERNAL_SECRET = 'a-different-secret-0123456789'
    expect(openRunCredential(sealed, BIND)).toBeNull()
    delete process.env.CHAT_INTERNAL_SECRET
    expect(openRunCredential(sealed, BIND)).toBeNull()
  })

  it('a JWT whose sub is not the binding’s user is refused (never act as someone else)', () => {
    expect(openRunCredential(sealRunCredential(jwtFor('user-2'), BIND), BIND)).toBeNull()
    expect(openRunCredential(sealRunCredential('nid_device_token', BIND), BIND)).toBeNull()
  })

  it('sealing needs the secret', () => {
    delete process.env.CHAT_INTERNAL_SECRET
    expect(() => sealRunCredential(jwtFor('user-1'), BIND)).toThrow(/CHAT_INTERNAL_SECRET/)
  })
})
