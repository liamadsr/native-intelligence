// @vitest-environment jsdom
/**
 * A meeting's invite link in its conversation's header (../meeting-link-button.tsx;
 * Liam, 11-23: "the invite link doesn't have to show it should just be a copy
 * invite link button"): one Copy invite link button for everyone, the link
 * never drawn, when it works its tooltip; the host's other moves in a menu
 * beside it; a link that no longer works a quiet chip, or New invite link for
 * the host of a turned-off one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { MeetingView } from '@/lib/meeting-links/shape'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { client, clip } = vi.hoisted(() => ({
  client: {
    meeting: null as MeetingView | null,
    newLink: vi.fn(async () => ({ ok: true as const, url: 'https://example.test/m/new' })),
  },
  clip: vi.fn(async () => true),
}))
vi.mock('sonner', () => ({ toast: vi.fn() }))
vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: clip }))
vi.mock('@/lib/meeting-links/client', () => ({
  fetchMeetingOf: async () => client.meeting,
  requestNewLink: client.newLink,
  requestRevoke: vi.fn(async () => ({ ok: true })),
  requestEnd: vi.fn(async () => ({ ok: true })),
}))

const { MeetingLinkButton } = await import('../meeting-link-button')

const HOUR = 3_600_000
function meeting(over: Partial<MeetingView> = {}): MeetingView {
  const now = Date.now()
  return {
    id: 'm1',
    channel_id: 'c1',
    host_member_id: 'host',
    title: 'Test call',
    starts_at: new Date(now).toISOString(),
    ends_at: new Date(now + HOUR).toISOString(),
    opens_at: new Date(now - HOUR).toISOString(),
    closes_at: new Date(now + 30 * 24 * HOUR).toISOString(),
    revoked_at: null,
    url: 'https://example.test/m/abc',
    ...over,
  } as MeetingView
}

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  clip.mockClear()
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function draw(meId: string | null) {
  await act(async () => root.render(<MeetingLinkButton channelId="c1" meId={meId} live={false} />))
  await act(async () => {})
}
const copyButton = () => container.querySelector<HTMLButtonElement>('[data-meeting-link-copy]')

describe('the invite link in the header', () => {
  it('one Copy invite link button for everyone: the link itself never drawn, when it works its tooltip; a click copies it and says so', async () => {
    client.meeting = meeting()
    await draw('someone')
    expect(copyButton()!.textContent).toBe('Copy invite link')
    expect(copyButton()!.getAttribute('title')).toMatch(/^Works until /)
    expect(container.textContent).not.toContain('example.test')
    // Not the host: no menu.
    expect(container.querySelector('[data-meeting-link-menu]')).toBeNull()
    await act(async () => copyButton()!.click())
    expect(clip).toHaveBeenCalledWith('https://example.test/m/abc')
    expect(copyButton()!.textContent).toBe('Copied')
    expect(copyButton()!.getAttribute('aria-label')).toBe('Invite link copied')
  })

  it('the host’s other moves in a menu beside it; a link that opens later says when', async () => {
    client.meeting = meeting({ opens_at: new Date(Date.now() + HOUR).toISOString() })
    await draw('host')
    expect(container.querySelector('[data-meeting-link-menu]')).not.toBeNull()
    expect(copyButton()!.getAttribute('title')).toMatch(/^Opens /)
    // 24px, as every header control.
    expect(copyButton()!.className).toContain('h-6')
  })

  it('a turned-off link: New invite link for the host, a quiet chip for everyone else; a run-out link, Link expired', async () => {
    client.meeting = meeting({ revoked_at: new Date().toISOString() })
    await draw('host')
    const make = container.querySelector<HTMLButtonElement>('[data-meeting-new-link]')!
    expect(make.textContent).toBe('New invite link')
    await act(async () => make.click())
    expect(client.newLink).toHaveBeenCalledWith('m1')
    expect(copyButton()).not.toBeNull()

    client.meeting = meeting({ revoked_at: new Date().toISOString() })
    act(() => root.unmount())
    root = createRoot(container)
    await draw('someone')
    expect(container.querySelector('[data-meeting-link-off="revoked"]')!.textContent).toBe('Link off')

    client.meeting = meeting({ closes_at: new Date(Date.now() - HOUR).toISOString() })
    act(() => root.unmount())
    root = createRoot(container)
    await draw('host')
    expect(container.querySelector('[data-meeting-link-off="closed"]')!.textContent).toBe('Link expired')
    expect(copyButton()).toBeNull()
  })
})
