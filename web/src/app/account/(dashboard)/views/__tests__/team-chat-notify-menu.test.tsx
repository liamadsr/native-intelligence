// @vitest-environment jsdom
/**
 * The channel's notifications menu (docs/plans/channels-inbox.md, phase 1):
 * Signal and Noise are 560's levels, the timed mutes are a snooze, and
 * "turn back on" ends whichever is on. Radix's menu is replaced by a plain
 * always-open one, so the items are buttons.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, type ReactNode } from 'react'

vi.mock('@/components/ui/dropdown-menu', async () => {
  const { createElement: e } = await import('react')
  type ItemProps = { children?: ReactNode; onSelect?: () => void; className?: string } & Record<string, unknown>
  return {
    DropdownMenu: ({ children }: { children?: ReactNode }) => e('div', null, children),
    DropdownMenuTrigger: ({ children }: { children?: ReactNode }) => e('div', null, children),
    DropdownMenuContent: ({ children }: { children?: ReactNode }) => e('div', { 'data-menu': '' }, children),
    DropdownMenuSeparator: () => e('hr'),
    DropdownMenuItem: ({ children, onSelect, className: _c, ...rest }: ItemProps) => e('button', { type: 'button', ...rest, onClick: () => onSelect?.() }, children),
  }
})

import { TeamChatNotifyMenu, notifyMenuSummary } from '../team-chat-notify-menu'

let root: Root
let host: HTMLDivElement
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function draw(props: Partial<Parameters<typeof TeamChatNotifyMenu>[0]> = {}) {
  const onChange = vi.fn()
  const onSnooze = vi.fn()
  act(() => root.render(h(TeamChatNotifyMenu, { kind: 'channel', level: 'mentions', mutedUntil: null, onChange, onSnooze, ...props })))
  return { onChange, onSnooze }
}
const q = (sel: string) => host.querySelector<HTMLElement>(sel)

describe('TeamChatNotifyMenu', () => {
  it('offers Signal and Noise, Noise chosen by default for a channel', () => {
    draw()
    expect(q('[data-team-chat-notify-option="all"]')?.textContent).toContain('Signal')
    expect(q('[data-team-chat-notify-option="mentions"]')?.textContent).toContain('Noise')
    expect(q('[data-team-chat-notify-option="mentions"] [aria-label="Chosen"]')).not.toBeNull()
    expect(q('[data-team-chat-notify-option="all"] [aria-label="Chosen"]')).toBeNull()
  })

  it('picking Signal stores all', () => {
    const { onChange } = draw()
    act(() => q('[data-team-chat-notify-option="all"]')!.click())
    expect(onChange).toHaveBeenCalledWith('all')
  })

  it('picking the level already chosen does nothing', () => {
    const { onChange } = draw({ level: 'all' })
    act(() => q('[data-team-chat-notify-option="all"]')!.click())
    expect(onChange).not.toHaveBeenCalled()
  })

  it('a timed mute snoozes until a future time', () => {
    const { onSnooze, onChange } = draw()
    const before = Date.now()
    act(() => q('[data-team-chat-snooze-option="hour"]')!.click())
    expect(onChange).not.toHaveBeenCalled()
    const until = Date.parse(onSnooze.mock.calls[0][0])
    expect(until - before).toBeGreaterThanOrEqual(3_599_000)
    expect(until - before).toBeLessThanOrEqual(3_601_000)
  })

  it('"until I turn it back on" is the muted level', () => {
    const { onChange } = draw()
    act(() => q('[data-team-chat-notify-option="muted"]')!.click())
    expect(onChange).toHaveBeenCalledWith('muted')
  })

  it('while snoozed: says until when, and turning back on ends the snooze only', () => {
    const until = new Date(Date.now() + 30 * 60_000).toISOString()
    const { onSnooze, onChange } = draw({ level: 'all', mutedUntil: until })
    expect(q('[data-team-chat-snooze-option="hour"]')).toBeNull()
    expect(q('[data-team-chat-snooze-state]')?.textContent).toMatch(/^Muted until/)
    expect(q('[data-team-chat-snoozed]')).not.toBeNull()
    act(() => q('[data-team-chat-unmute]')!.click())
    expect(onSnooze).toHaveBeenCalledWith(null)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('while muted: turning back on goes to the default (Noise for a channel, Signal for a DM)', () => {
    let r = draw({ level: 'muted' })
    act(() => q('[data-team-chat-unmute]')!.click())
    expect(r.onChange).toHaveBeenCalledWith('mentions')
    expect(r.onSnooze).not.toHaveBeenCalled()
    r = draw({ kind: 'dm', level: 'muted' })
    act(() => q('[data-team-chat-unmute]')!.click())
    expect(r.onChange).toHaveBeenCalledWith('all')
  })

  it('a snooze that has passed counts as none', () => {
    draw({ mutedUntil: new Date(Date.now() - 1000).toISOString() })
    expect(q('[data-team-chat-unmute]')).toBeNull()
    expect(q('[data-team-chat-snooze-option="week"]')).not.toBeNull()
  })
})

describe('notifyMenuSummary', () => {
  it('names the state', () => {
    const now = new Date(2026, 10, 23, 10, 0)
    expect(notifyMenuSummary('all', null, now)).toBe('Signal')
    expect(notifyMenuSummary('mentions', null, now)).toBe('Noise')
    expect(notifyMenuSummary('muted', null, now)).toBe('Muted')
    expect(notifyMenuSummary('all', new Date(2026, 10, 23, 11, 0).toISOString(), now)).toMatch(/^Muted until /)
  })
})
