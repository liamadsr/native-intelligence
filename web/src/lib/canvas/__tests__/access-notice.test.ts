/**
 * The server's word in a canvas's presence room that its sharing changed
 * (docs/plans/record-sharing.md, Phase 2): a private broadcast on the room's
 * topic, naming nobody, sent by the service role, never throwing.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { announceCanvasAccessChanged } from '../access-notice'
import { ACCESS_CHANGED_EVENT, presenceTopic } from '../presence'
import { presenceTopic as editorTopic } from '@/components/canvas/live'

const ID = '3F2B8C1E-5A4D-4E6F-9A7B-0C1D2E3F4A5B'

describe('announceCanvasAccessChanged', () => {
  it('says access_changed on the room the editor joins, with an empty payload, then lets the channel go', async () => {
    const send = vi.fn().mockResolvedValue('ok')
    const channel = { send }
    const svc = { channel: vi.fn(() => channel), removeChannel: vi.fn().mockResolvedValue('ok') }
    await announceCanvasAccessChanged(svc as unknown as SupabaseClient, ID)
    expect(svc.channel).toHaveBeenCalledWith(`canvas-presence:${ID.toLowerCase()}`, { config: { private: true, broadcast: { ack: false } } })
    expect(send).toHaveBeenCalledWith({ type: 'broadcast', event: ACCESS_CHANGED_EVENT, payload: {} })
    expect(svc.removeChannel).toHaveBeenCalledWith(channel)
    expect(editorTopic(ID)).toBe(presenceTopic(ID))
  })

  it('never throws', async () => {
    const svc = { channel: () => ({ send: () => Promise.reject(new Error('down')) }), removeChannel: vi.fn() }
    await expect(announceCanvasAccessChanged(svc as unknown as SupabaseClient, ID)).resolves.toBeUndefined()
  })
})
