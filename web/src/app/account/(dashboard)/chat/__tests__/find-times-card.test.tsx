// @vitest-environment jsdom
/**
 * The find_times card (../find-times-card.tsx) and its place in the chat's
 * tool renderers: the times to offer, a group's people with a tick or
 * "unknown: reason", and the generic chip for a call still running or one
 * that failed before reading anyone.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, type ReactNode } from 'react'
import type { DynamicToolUIPart } from 'ai'
import { FindTimesCard } from '../find-times-card'
import { rendererFor, type ToolRenderContext } from '../tool-renderers'
import type { FindTimesCardData } from '@/lib/availability/find-times-card'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const draw = (node: ReactNode) => act(() => root.render(node as never))

const GROUP: FindTimesCardData = {
  durationMinutes: 30,
  zone: 'EST',
  suggested: ['Tue, Nov 3, 10:00 AM – 10:30 AM', 'Wed, Nov 4, 2:00 PM – 2:30 PM'],
  people: [
    { name: 'Ada Finch', you: true, known: true, reason: null, zone: null },
    { name: 'Dana Whitfield', you: false, known: true, reason: null, zone: 'CST' },
  ],
  unknown: false,
}

describe('FindTimesCard', () => {
  it('the times, then each person with a tick', () => {
    draw(h(FindTimesCard, { data: GROUP }))
    expect(container.textContent).toContain('Times that work for everyone · 30 min · EST')
    expect([...container.querySelectorAll('[data-find-times-suggested] li')].map((li) => li.textContent)).toEqual(GROUP.suggested)
    const people = [...container.querySelectorAll('[data-find-times-people] li')]
    expect(people.map((li) => li.textContent)).toEqual(['You', 'Dana Whitfield · CST'])
    expect(people.map((li) => li.getAttribute('data-coverage'))).toEqual(['complete', 'complete'])
  })

  it('someone unknown: no times, and why', () => {
    draw(
      h(FindTimesCard, {
        data: { ...GROUP, suggested: [], unknown: true, people: [GROUP.people![0], { name: 'Sam Ortiz', you: false, known: false, reason: "they don't share their availability", zone: null }] },
      }),
    )
    expect(container.textContent).toContain('No common times · 30 min')
    expect(container.querySelector('[data-find-times-suggested]')).toBeNull()
    const sam = container.querySelector('[data-coverage="unknown"]')
    expect(sam?.textContent).toBe("Sam Ortiz · unknown: they don't share their availability")
  })

  it('the person alone: the times, no people', () => {
    draw(h(FindTimesCard, { data: { ...GROUP, people: null } }))
    expect(container.textContent).toContain('Times that work · 30 min')
    expect(container.querySelector('[data-find-times-people]')).toBeNull()
  })

  it('nothing free: says so', () => {
    draw(h(FindTimesCard, { data: { ...GROUP, people: null, suggested: [] } }))
    expect(container.textContent).toBe('Nothing free in this range · 30 min')
  })
})

describe('the chat renders it for find_times', () => {
  const ctx = (state: ToolRenderContext['state'], output?: unknown): ToolRenderContext =>
    ({
      part: (output === undefined
        ? { type: 'dynamic-tool', toolName: 'find_times', toolCallId: 't1', state: 'input-available', input: {} }
        : { type: 'dynamic-tool', toolName: 'find_times', toolCallId: 't1', state: 'output-available', input: {}, output }) as DynamicToolUIPart,
      toolName: 'find_times',
      toolCallId: 't1',
      state,
      textContent: '',
      links: undefined,
      lastEmailDraftToolCallId: null,
      lastPlanToolCallId: null,
      lastAttachmentImageToolCallId: null,
      allAttachmentImages: [],
      attachmentLinks: [],
      onEntityClick: () => {},
    }) as ToolRenderContext

  it('a result with times is the card; a running or failed call is the chip', () => {
    const entry = rendererFor('find_times')
    expect(entry).toBeDefined()
    const card = entry!.render(ctx('result', { success: true, time_zone: 'America/New_York', duration_minutes: 30, suggested: [{ label: 'Tue, Nov 3, 10:00 AM to 10:30 AM' }], free: [] }))
    expect(card).toBeTruthy()
    draw(card)
    expect(container.querySelector('[data-find-times-card]')).not.toBeNull()
    expect(entry!.render(ctx('call'))).toBeUndefined()
    expect(entry!.render(ctx('result', { success: false, error: 'No calendar connected.' }))).toBeUndefined()
  })
})
