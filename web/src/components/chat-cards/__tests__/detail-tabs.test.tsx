// @vitest-environment jsdom
/**
 * A detail page's sections in a card's header (../detail-tabs.tsx; Liam,
 * 11-23: "these details view pages … that show the different pages at the
 * top … feel out of place"): the capsule itself, and the two panels too heavy
 * to mount here (a capture's, a document's), read from their source the way
 * capture-live-chat-section.test.tsx reads the capture panel.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DetailTabsInHeader, useDetailTabsInHeader } from '../detail-tabs'
import { CardHeaderSlotsProvider } from '../card-header-slot'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let right: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  right = document.createElement('div')
  document.body.append(right, container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  right.remove()
})

type T = 'overview' | 'files' | 'checks'
function Page() {
  const [tab, setTab] = React.useState<T>('overview')
  const inCard = useDetailTabsInHeader()
  return (
    <>
      <DetailTabsInHeader<T>
        label="Pull request"
        tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'files', label: 'Files', count: 3, data: { 'data-page-tab': 'files' } },
          { id: 'checks', label: 'Checks', count: 0 },
        ]}
        value={tab}
        onChange={setTab}
      />
      <p data-in-card={String(inCard)} data-shown={tab} />
    </>
  )
}

describe('DetailTabsInHeader', () => {
  it('in a card: a 24px tablist in the right slot, counts after the words (none at 0), the page’s own attributes on each tab, a press choosing', async () => {
    await act(async () => root.render(<CardHeaderSlotsProvider value={{ left: null, right }}><Page /></CardHeaderSlotsProvider>))
    const capsule = right.querySelector<HTMLElement>('[data-detail-tabs="header"]')!
    expect(capsule.getAttribute('role')).toBe('tablist')
    expect(capsule.getAttribute('aria-label')).toBe('Pull request')
    expect(capsule.className).toContain('h-6')
    expect(Array.from(capsule.querySelectorAll('[role="tab"]')).map((b) => b.textContent)).toEqual(['Overview', 'Files3', 'Checks'])
    expect(capsule.querySelector('[data-page-tab="files"]')!.getAttribute('data-detail-tab')).toBe('files')
    expect(capsule.querySelector('[data-detail-tab="overview"]')!.getAttribute('aria-selected')).toBe('true')
    expect(container.querySelector('[data-in-card]')!.getAttribute('data-in-card')).toBe('true')
    await act(async () => capsule.querySelector<HTMLButtonElement>('[data-detail-tab="files"]')!.click())
    expect(capsule.querySelector('[data-detail-tab="files"]')!.getAttribute('aria-selected')).toBe('true')
    expect(container.querySelector('[data-shown]')!.getAttribute('data-shown')).toBe('files')
  })

  it('outside a card: nothing, and the page knows to keep its own row', async () => {
    await act(async () => root.render(<Page />))
    expect(document.querySelector('[data-detail-tabs="header"]')).toBeNull()
    expect(container.querySelector('[data-in-card]')!.getAttribute('data-in-card')).toBe('false')
  })
})

describe('the capture’s and the document’s sections', () => {
  const read = (file: string) => readFileSync(join(process.cwd(), 'src/app/account/(dashboard)/views', file), 'utf8')

  it('a capture: the shown sections in the header, its own tab attribute kept; the row’s pills only outside a card, the row gone when empty', () => {
    const source = read('capture-detail-panel.tsx')
    expect(source).toContain('const tabsInHeader = useDetailTabsInHeader()')
    expect(source).toContain('tabs={CAPTURE_SECTIONS.filter(sectionShown).map((tab) => ({')
    expect(source).toContain("data: { 'data-capture-tab': tab },")
    expect(source).toContain('value={activeSection}\n        onChange={setActiveSection}')
    expect(source).toContain('<div className="flex h-10 shrink-0 items-center gap-2 px-5 empty:hidden">')
    expect(source).toContain('{!tabsInHeader && (\n        <div data-capture-tabs=""')
  })

  it('a document: Overview / Agents / History in the header; the row’s pills only outside a card, the row gone when empty', () => {
    const source = read('document-detail-panel.tsx')
    expect(source).toContain('const tabsInHeader = useDetailTabsInHeader()')
    expect(source).toContain('tabs={DOCUMENT_SECTIONS.map((tab) => ({ id: tab, label: SECTION_LABELS[tab] }))}')
    expect(source).toContain('value={activeSection}\n        onChange={setActiveSection}')
    expect(source).toContain('<div className="flex h-10 shrink-0 items-center px-5 empty:hidden">\n        {!tabsInHeader && (')
  })
})
