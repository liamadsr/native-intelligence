// @vitest-environment jsdom
/**
 * The "Remembered: …" chip (one-agent plan Part 3, "Memory"): what it reads
 * off a `remember` result, what it says for a personal line and for a
 * workspace proposal, and Undo, which deletes the line. Also its one branch
 * in today's chat (chat-message.tsx) until P1's renderer registry takes it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import { RememberedChip, rememberedFromToolOutput, rememberedLabel, type RememberedData } from '../remembered-chip'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const personal: RememberedData = { id: 'line-1', area: 'mail', scope: 'personal', status: 'active', text: "Sign off with 'Best, Liam'", already: false }
const aboutYou: RememberedData = { id: 'fact-1', area: null, scope: 'profile', status: 'active', text: 'Keep answers short', already: false }
const proposal: RememberedData = { id: 'line-2', area: 'prospecting', scope: 'workspace', status: 'proposed', text: 'We sell to Series A fintech', already: false }

describe('rememberedFromToolOutput', () => {
  it('reads a saved line off the result, and nothing off a failed or malformed one', () => {
    expect(
      rememberedFromToolOutput({ success: true, remembered: { id: 'line-1', area: 'mail', area_name: 'Mail', scope: 'personal', status: 'active', text: 'x' } }),
    ).toEqual({ id: 'line-1', area: 'mail', scope: 'personal', status: 'active', text: 'x', already: false })
    expect(
      rememberedFromToolOutput({ success: true, already: true, remembered: { id: 'line-1', area: 'mail', scope: 'personal', status: 'active', text: 'x' } })?.already,
    ).toBe(true)
    expect(rememberedFromToolOutput({ success: false, code: 'NOTE_FULL', error: '…' })).toBeNull()
    expect(rememberedFromToolOutput({ success: true, remembered: { id: 'x', area: 'email', scope: 'personal', text: 'x' } })).toBeNull()
    expect(rememberedFromToolOutput('Remembered')).toBeNull()
  })

  it('reads a fact about the person (scope profile) with no area, and labels it about them', () => {
    expect(
      rememberedFromToolOutput({ success: true, remembered: { id: 'fact-1', area: null, area_name: 'About you', scope: 'profile', status: 'active', text: 'Keep answers short' } }),
    ).toEqual(aboutYou)
    expect(rememberedLabel(aboutYou)).toBe('Remembered about you: Keep answers short')
    expect(rememberedLabel({ ...aboutYou, already: true })).toBe('Already remembered about you: Keep answers short')
    // An area line still needs a real area.
    expect(rememberedFromToolOutput({ success: true, remembered: { id: 'x', area: null, scope: 'personal', text: 'x' } })).toBeNull()
  })

  it('labels a personal line “Remembered” and a proposal as proposed to the workspace', () => {
    expect(rememberedLabel(personal)).toBe("Remembered: Sign off with 'Best, Liam'")
    expect(rememberedLabel(proposal)).toBe('Proposed to the workspace: We sell to Series A fintech')
    // Only a workspace line is proposed to the workspace; a personal one waiting is still theirs.
    expect(rememberedLabel({ ...personal, status: 'proposed', already: true })).toBe("Already remembered: Sign off with 'Best, Liam'")
    expect(rememberedLabel({ ...proposal, already: true })).toBe('Already proposed to the workspace: We sell to Series A fintech')
  })
})

describe('RememberedChip', () => {
  let container: HTMLDivElement
  let root: Root
  const fetchMock = vi.fn()

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  const undoButton = () => [...container.querySelectorAll('button')].find((b) => /Undo/.test(b.textContent ?? ''))!

  it('Undo deletes the line, then says it was forgotten', async () => {
    fetchMock.mockResolvedValue(new Response('{"ok":true}', { status: 200 }))
    act(() => root.render(h(RememberedChip, { data: personal })))
    expect(container.textContent).toContain("Remembered: Sign off with 'Best, Liam'")
    await act(async () => undoButton().click())
    expect(fetchMock).toHaveBeenCalledWith('/api/account/memory/line-1', { method: 'DELETE' })
    expect(container.textContent).toContain('Forgotten')
    expect(container.querySelector('button')).toBeNull()
  })

  it('a profile fact from a turn that read outside text says it waits for the person, and Undo withdraws it', async () => {
    fetchMock.mockResolvedValue(new Response('{"ok":true}', { status: 200 }))
    const waiting: RememberedData = { ...aboutYou, status: 'proposed' }
    expect(rememberedLabel(waiting)).toBe('Waiting for you in What Dial8 has learned: Keep answers short')
    act(() => root.render(h(RememberedChip, { data: waiting })))
    expect(container.textContent).toContain('Accept it to remember')
    await act(async () => undoButton().click())
    expect(fetchMock).toHaveBeenCalledWith('/api/account/memory/profile/fact-1', { method: 'DELETE' })
    expect(container.textContent).toContain('Proposal withdrawn')
  })

  it('Undo on a fact about the person deletes the fact, not an area line', async () => {
    fetchMock.mockResolvedValue(new Response('{"ok":true}', { status: 200 }))
    act(() => root.render(h(RememberedChip, { data: aboutYou })))
    expect(container.textContent).toContain('Every workspace')
    await act(async () => undoButton().click())
    expect(fetchMock).toHaveBeenCalledWith('/api/account/memory/profile/fact-1', { method: 'DELETE' })
    expect(container.textContent).toContain('Forgotten')
  })

  it('a proposal says it waits for an admin, and Undo withdraws it', async () => {
    fetchMock.mockResolvedValue(new Response('{"ok":true}', { status: 200 }))
    act(() => root.render(h(RememberedChip, { data: proposal })))
    expect(container.textContent).toContain('Waiting for an admin')
    await act(async () => undoButton().click())
    expect(container.textContent).toContain('Proposal withdrawn')
  })

  it('a line that was already there says so and offers no Undo', () => {
    act(() => root.render(h(RememberedChip, { data: { ...personal, already: true } })))
    expect(container.textContent).toContain("Already remembered: Sign off with 'Best, Liam'")
    expect(container.querySelector('button')).toBeNull()
  })

  it('a member’s proposal an admin already settled is not reported withdrawn', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 404 }))
    act(() => root.render(h(RememberedChip, { data: proposal })))
    await act(async () => undoButton().click())
    expect(container.textContent).not.toContain('Proposal withdrawn')
    expect(container.textContent).toContain('An admin already settled it')
    expect(container.querySelector('button')).toBeNull()
  })

  it('a failed Undo keeps the chip and offers a retry; a line already gone counts as undone', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 500 }))
    act(() => root.render(h(RememberedChip, { data: personal })))
    await act(async () => undoButton().click())
    expect(container.textContent).toContain('Undo failed, retry')
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 404 }))
    await act(async () => undoButton().click())
    expect(container.textContent).toContain('Forgotten')
  })
})
