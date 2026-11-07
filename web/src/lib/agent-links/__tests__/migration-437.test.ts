/**
 * Migration 437: a linked agent's thread (outside_channel 'dial8') passes
 * the check that 428 set, and only on a guest's own thread.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DIAL8_CHANNEL } from '@/lib/chat/channel-turn'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/437_agent_link_threads.sql'), 'utf8')
const BODY = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')

describe('migration 437', () => {
  it('holds no backslash (one MCP transport decodes escapes)', () => {
    expect(SQL).not.toContain('\\')
  })

  it("allows the app's dial8 channel on a guest's thread, keeping slack and sms as they were", () => {
    expect(DIAL8_CHANNEL).toBe('dial8')
    expect(BODY).toContain('drop constraint if exists chat_conversations_outside_channel_check;')
    expect(BODY).toContain("outside_channel is null or ( is_home is null and ( outside_channel = 'slack' or (outside_channel in ('sms', 'dial8') and agent_guest_id is not null) ) )")
  })
})
