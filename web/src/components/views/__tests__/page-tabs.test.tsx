// @vitest-environment jsdom
/**
 * A page's tabs (../page-tabs.tsx; Liam, 11-23: "I want to put it back in the
 * header of the pages but make it look really nice and clean like linear does
 * … it should start to the far left even though the page content is
 * indented"): one quiet pill for a list's saved views and a detail page's
 * sections, and every detail page's sections on its own first row, in the
 * card's corner, never in a card's header. The two panels too heavy to mount here (a
 * capture's, a document's) and the rest are read from their source, the way
 * capture-live-chat-section.test.tsx reads the capture panel.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DETAIL_TAB_ROW, DetailTabs, PAGE_TAB, PAGE_TAB_INSET, PAGE_TAB_ON, PAGE_TAB_OFF, pageTabClass } from '../page-tabs'
import { CardHeaderSlotsProvider } from '@/components/chat-cards/card-header-slot'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

type T = 'overview' | 'files' | 'checks'
function Page() {
  const [tab, setTab] = React.useState<T>('overview')
  return (
    <>
      <DetailTabs<T>
        label="Pull request"
        data-page-tabs=""
        tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'files', label: 'Files', count: 3, data: { 'data-page-tab': 'files' } },
          { id: 'checks', label: 'Checks', count: 0 },
        ]}
        value={tab}
        onChange={setTab}
      />
      <p data-shown={tab} />
    </>
  )
}

describe('DetailTabs', () => {
  it('a tablist: counts after the words (none at 0), the page’s own attributes kept, a press choosing', async () => {
    await act(async () => root.render(<Page />))
    const tabs = container.querySelector<HTMLElement>('[role="tablist"]')!
    expect(tabs.getAttribute('aria-label')).toBe('Pull request')
    expect(tabs.hasAttribute('data-page-tabs')).toBe(true)
    expect(Array.from(tabs.querySelectorAll('[role="tab"]')).map((b) => b.textContent)).toEqual(['Overview', 'Files3', 'Checks'])
    expect(tabs.querySelector('[data-page-tab="files"]')!.getAttribute('data-detail-tab')).toBe('files')
    expect(tabs.querySelector('[data-detail-tab="overview"]')!.getAttribute('aria-selected')).toBe('true')
    await act(async () => tabs.querySelector<HTMLButtonElement>('[data-detail-tab="files"]')!.click())
    expect(tabs.querySelector('[data-detail-tab="files"]')!.getAttribute('aria-selected')).toBe('true')
    expect(tabs.querySelector('[data-detail-tab="overview"]')!.getAttribute('aria-selected')).toBe('false')
    expect(container.querySelector('[data-shown]')!.getAttribute('data-shown')).toBe('files')
  })

  it('the chosen tab a shade lighter, at the same weight and size as the others, so nothing moves when another is picked', () => {
    expect(pageTabClass(true)).toContain(PAGE_TAB_ON)
    expect(pageTabClass(false)).toContain(PAGE_TAB_OFF)
    for (const cls of [pageTabClass(true), pageTabClass(false)]) {
      expect(cls).toContain('h-7')
      expect(cls).not.toMatch(/\bfont-(medium|semibold|bold)\b/)
    }
    // Quiet: no inverted (foreground-filled) pill any more.
    expect(pageTabClass(true)).not.toMatch(/(^|\s)bg-foreground(\s|$)/)
  })

  it('a detail page’s first row and a list’s toolbar sit in the card’s corner: 10px in, as the 48px row leaves over the 28px pills (Liam, 11-23)', () => {
    expect(PAGE_TAB_INSET).toBe('px-2.5')
    expect(DETAIL_TAB_ROW).toContain(PAGE_TAB_INSET)
    expect(DETAIL_TAB_ROW).toContain('h-12')
    expect(PAGE_TAB).toContain('h-7')
    const source = (file: string) => readFileSync(join(process.cwd(), 'src/components/views', file), 'utf8')
    expect(source('view-toolbar.tsx')).toContain("alignToContent ? PAGE_TAB_INSET : ")
    // The board's first column under the first pill.
    expect(source('view-board.tsx')).toContain('className="flex gap-4 py-4 px-2.5 overflow-x-auto')
  })
})

describe('in a card: the card’s top row (Liam, 11-24: "why is it that on prod the tabs are indented?")', () => {
  const tabs = [{ id: 'overview', label: 'Overview' }, { id: 'files', label: 'Files' }] as const

  it('the sections stand in the card body’s top row, the card’s whole width, in a row of their own; the page’s row is left empty and hides', async () => {
    const top = document.createElement('div')
    document.body.append(top)
    try {
      await act(async () =>
        root.render(
          <CardHeaderSlotsProvider value={{ left: null, right: null, pageTop: top }}>
            <div data-page-row="" className={DETAIL_TAB_ROW}>
              <DetailTabs label="Project" tabs={tabs} value="overview" onChange={() => {}} />
            </div>
          </CardHeaderSlotsProvider>,
        ),
      )
      const list = top.querySelector('[role="tablist"]')!
      expect(list.getAttribute('aria-label')).toBe('Project')
      expect(list.parentElement!.className).toBe(DETAIL_TAB_ROW)
      expect(container.querySelector('[role="tablist"]')).toBeNull()
      expect(container.querySelector('[data-page-row]')!.childElementCount).toBe(0)
      expect(DETAIL_TAB_ROW).toContain('empty:hidden')
    } finally {
      top.remove()
    }
  })

  it('`inline` keeps them in the page (the Inbox’s, over its list column); a covered page (no top row) keeps its own', async () => {
    const top = document.createElement('div')
    document.body.append(top)
    try {
      await act(async () =>
        root.render(
          <CardHeaderSlotsProvider value={{ left: null, right: null, pageTop: top }}>
            <DetailTabs label="Show" inline tabs={tabs} value="overview" onChange={() => {}} />
          </CardHeaderSlotsProvider>,
        ),
      )
      expect(top.childElementCount).toBe(0)
      expect(container.querySelector('[role="tablist"]')).not.toBeNull()
      await act(async () =>
        root.render(
          <CardHeaderSlotsProvider value={{ left: null, right: null, trail: null }}>
            <DetailTabs label="Project" tabs={tabs} value="overview" onChange={() => {}} />
          </CardHeaderSlotsProvider>,
        ),
      )
      expect(top.childElementCount).toBe(0)
      expect(container.querySelector('[role="tablist"][aria-label="Project"]')).not.toBeNull()
    } finally {
      top.remove()
    }
  })
})

describe('every detail page and the list’s saved views', () => {
  const read = (file: string) => readFileSync(join(process.cwd(), 'src', file), 'utf8')
  const pages = [
    'app/account/(dashboard)/views/project-detail-panel.tsx',
    'app/account/(dashboard)/views/initiative-detail-panel.tsx',
    'app/account/(dashboard)/views/contact-detail-panel.tsx',
    'app/account/(dashboard)/views/company-detail-panel.tsx',
    'app/account/(dashboard)/views/action-detail-panel.tsx',
    'app/account/(dashboard)/views/document-detail-panel.tsx',
    'app/account/(dashboard)/views/capture-detail-panel.tsx',
    'app/account/(dashboard)/prospecting/entry-panel.tsx',
    'app/account/(dashboard)/evals/suite-detail.tsx',
    'components/chat-cards/pages/reviews/pull-detail.tsx',
  ]

  it.each(pages)('%s: its sections on its own first row (DETAIL_TAB_ROW), none in the card’s header', (file) => {
    const source = read(file)
    expect(source).toContain("from '@/components/views/page-tabs'")
    expect(source).toMatch(/className=\{(cn\('@container\/actiontoolbar', )?DETAIL_TAB_ROW\)?\}>\n\s+(\{\/\*[\s\S]*?\*\/\}\n\s+)*(\{action && \(\n\s+)?<DetailTabs/)
    expect(source).not.toContain('tabsInHeader')
    expect(source).not.toContain('chat-cards/detail-tabs')
  })

  it('a capture keeps its own tab attributes', () => {
    const source = read('app/account/(dashboard)/views/capture-detail-panel.tsx')
    expect(source).toContain('data-capture-tabs=""')
    expect(source).toContain("data: { 'data-capture-tab': tab },")
  })

  it('a list’s saved views wear the same pill', () => {
    const source = read('components/views/view-tabs.tsx')
    expect(source).toContain('const tabClass = pageTabClass')
    expect(source).toContain('className={PAGE_TAB_ADD}')
  })
})
