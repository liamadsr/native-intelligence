/**
 * The Inngest fence in src/test/setup.ts. Vercel's build runs this suite with
 * the production env injected, and a test that reached a real `inngest.send`
 * (record.ts's defaultSend, unmocked) POSTed real events to production
 * Inngest after every deploy build. The fence: the keys are scrubbed, every
 * SDK send is refused without touching the network, the attempt fails the test
 * that made it (setup's afterEach), and Inngest's hosts are off-limits to fetch.
 *
 * Each case here drains the attempts it provoked, so its own afterEach passes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Inngest } from 'inngest'
import { inngest } from '@/lib/inngest/client'
import { recordAgentEvents } from '@/lib/agent-events/record'
import { AGENT_EVENT_CREATED } from '@/lib/agent-events/types'

const fence = (globalThis as unknown as { __inngestSendFence: { inngestSendAttempts: string[] } }).__inngestSendFence

function drain(): string[] {
  return fence.inngestSendAttempts.splice(0)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the Inngest fence', () => {
  it('scrubs the production keys from the test env', () => {
    for (const key of ['INNGEST_EVENT_KEY', 'INNGEST_SIGNING_KEY', 'INNGEST_BASE_URL', 'INNGEST_DEV']) {
      expect(process.env[key]).toBeUndefined()
    }
  })

  it('refuses the app client’s send without any network I/O', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await expect(inngest.send({ name: 'test/probe', data: {} })).rejects.toThrow(/REAL Inngest send/)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(drain()).toEqual(['test/probe'])
  })

  it('refuses a client that carries its own event key (a prod key in the env would not help)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const client = new Inngest({ id: 'fence-probe', eventKey: 'looks-like-a-prod-key' })
    await expect(client.send([{ name: 'a/one', data: {} }, { name: 'a/two', data: {} }])).rejects.toThrow(/mock it/)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(drain()).toEqual(['a/one, a/two'])
  })

  it('catches the original leak: recordAgentEvents with no send dep swallows the error, the fence still sees it', async () => {
    const supabase = {
      from: () => ({
        upsert: () => ({ select: async () => ({ data: [{ id: 'row-1' }], error: null }) }),
      }),
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const landed = await recordAgentEvents(
      [{ workspaceId: 'w1', userId: 'u-1', kind: 'meeting.soon', dedupeKey: 'fence-probe' }],
      supabase as never,
    )
    expect(landed).toBe(1)
    expect(warn).toHaveBeenCalledWith('[agent-event] router wake-up skipped:', expect.stringMatching(/REAL Inngest send/))
    expect(drain()).toEqual([AGENT_EVENT_CREATED])
  })

  it('keeps fetch off Inngest’s hosts', async () => {
    for (const url of [
      'https://inn.gs/e/key',
      'https://api.inngest.com/fn/register',
      'http://localhost:8288/e/key',
      'http://127.0.0.1:8288/fn/register',
    ]) {
      await expect(fetch(url, { method: 'POST' })).rejects.toThrow('fetch failed')
    }
  })
})
