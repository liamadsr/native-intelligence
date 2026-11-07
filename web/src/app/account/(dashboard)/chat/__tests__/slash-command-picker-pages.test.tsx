// @vitest-environment jsdom
/**
 * The menu's pages and skills (SlashCommandPicker over command-menu.tsx),
 * drawn in its palette frame: Pages first, then Skills, the query filtering
 * both; only the pages that are on in the workspace; and a composer that
 * offers no pages (a run's or a teammate's) lists the skills alone, with no
 * Pages tab.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { getEdition, withEffectiveSurface } from '@/lib/editions/manifest'
import { pagesFor } from '@/lib/chat-cards/page-menu'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/lib/workspace-fetch', () => ({ getClientWorkspaceId: () => 'ws-pages' }))
vi.mock('@/hooks/use-entity-sync', () => ({ useEntityListSync: () => {} }))

import { SlashCommandPicker } from '../slash-command-picker'

const SKILLS = [
  { id: 's1', slug: 'morning-brief', name: 'Morning Brief', icon: null, color: null, description: null, views_context: null },
  { id: 's2', slug: 'scout', name: 'Scout', icon: null, color: null, description: null, views_context: null },
]

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ commands: SKILLS }) }) as Response))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function render(props: Partial<Parameters<typeof SlashCommandPicker>[0]>) {
  const anchorRef = { current: null }
  await act(async () => {
    root.render(
      <SlashCommandPicker variant="palette" open query="" onSelect={() => {}} onDismiss={() => {}} anchorRef={anchorRef} {...props} />,
    )
  })
  // The commands arrive from the (stubbed) shared fetch.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

async function search(text: string) {
  const input = document.querySelector<HTMLInputElement>('[data-command-menu-input]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const labels = () => [...document.querySelectorAll('[data-command-item] [data-row-title]')].map((el) => el.textContent)
const groups = () => [...document.querySelectorAll('[role="group"]')].map((el) => el.getAttribute('aria-label'))
const tabs = () => [...document.querySelectorAll('[data-menu-tab]')].map((el) => el.getAttribute('data-menu-tab'))

describe('the menu’s pages and skills', () => {
  const full = getEdition('full')

  it('lists the pages first, then the skills, under their own headings', async () => {
    const pages = pagesFor(full, { desktop: false })
    await render({ pages, onSelectPage: () => {} })
    expect(groups()).toEqual(['Pages', 'Skills'])
    expect(labels().slice(0, 2)).toEqual([pages[0].label, pages[1].label])
    expect(labels().slice(-2)).toEqual(['Morning Brief', 'Scout'])
    expect(tabs()).toEqual(['all', 'pages', 'skills'])
  })

  it('lists only the pages that are on in the workspace', async () => {
    const pages = pagesFor(withEffectiveSurface(full, { crm: 'off', sequences: 'off', prospecting: 'off' }), { desktop: false })
    await render({ pages, onSelectPage: () => {} })
    await search('con')
    expect(labels()).not.toContain('Contacts')
    await search('act')
    expect(labels()).toContain('My Actions')
  })

  it('filters both by what is typed', async () => {
    await render({ pages: pagesFor(full, { desktop: false }), onSelectPage: () => {} })
    await search('scou')
    // No page matches "scou"; the Scout skill does, under no Pages heading.
    expect(labels()).toEqual(['Scout'])
    expect(groups()).toEqual(['Skills'])
    await search('actions')
    expect(labels()[0]).toBe('My Actions')
  })

  it('a click on a page picks it, and one on a skill picks that', async () => {
    const onSelectPage = vi.fn()
    const onSelect = vi.fn()
    await render({ pages: pagesFor(full, { desktop: false }), onSelectPage, onSelect })
    act(() => (document.querySelector('[data-page-item="actions"]') as HTMLButtonElement).click())
    expect(onSelectPage).toHaveBeenCalledWith(expect.objectContaining({ slug: 'actions' }))
    act(() => (document.querySelector('[data-skill-item="scout"]') as HTMLButtonElement).click())
    expect(onSelect).toHaveBeenCalledWith(SKILLS[1])
  })

  it('lists the skills alone where the composer offers no pages', async () => {
    await render({})
    expect(labels()).toEqual(['Morning Brief', 'Scout'])
    expect(groups()).toEqual(['Skills'])
    expect(tabs()).toEqual([])
  })
})
