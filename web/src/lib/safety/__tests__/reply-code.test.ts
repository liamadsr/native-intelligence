import { afterEach, describe, expect, it, vi } from 'vitest'
import { CODE_ALPHABET, REPLY_CODE_LENGTH, bindReplyToApproval, isYesOrNoWord, replyNamesACode } from '../caller'
import { serverReplyCode } from '../reply-code'

/** The channels' reply codes: keyed (an approval id alone doesn't give the code), stable, six unambiguous characters. */
describe('serverReplyCode', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('is stable, six characters of the code alphabet, never a yes or no word, and reads as a code', () => {
    for (let i = 0; i < 300; i++) {
      const code = serverReplyCode(`approval-${i}`)
      expect(code).toBe(serverReplyCode(`approval-${i}`))
      expect(code).toHaveLength(REPLY_CODE_LENGTH)
      expect([...code].every((ch) => CODE_ALPHABET.includes(ch))).toBe(true)
      expect(isYesOrNoWord(code)).toBe(false)
      expect(replyNamesACode(`yes ${code}`)).toBe('worded')
    }
  })

  it('depends on the server secret, not on the id alone', () => {
    vi.stubEnv('RUN_SKILL_INTERNAL_SECRET', 'secret-one')
    const one = serverReplyCode('approval-1')
    vi.stubEnv('RUN_SKILL_INTERNAL_SECRET', 'secret-two')
    expect(serverReplyCode('approval-1')).not.toBe(one)
  })

  it('binds through bindReplyToApproval when passed as the code', () => {
    const ref = { approvalId: 'approval-1', ownerUserId: 'u1', status: 'pending', expiresAt: null }
    const code = serverReplyCode('approval-1')
    expect(bindReplyToApproval(`yes ${code}`, { callerClass: 'person_remote', userId: 'u1' }, [ref], Date.now(), serverReplyCode)).toEqual({ bound: true, decision: 'approve', approvalId: 'approval-1' })
  })
})
