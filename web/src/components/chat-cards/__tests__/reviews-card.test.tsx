// @vitest-environment jsdom
/**
 * The Reviews card (docs/plans/github-reviews.md, phase 1): a section's pull
 * requests from GET /api/account/github/reviews, its filters, List and Board,
 * a pull request's panel (description, checks, linked actions, files) and a
 * merge that always confirms first.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act } from 'react'
import { makeStore, mountRoot } from './page-card-harness'

const hoisted = vi.hoisted(() => ({ toastSuccess: vi.fn(), toastError: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: hoisted.toastSuccess, error: hoisted.toastError } }))
vi.mock('@/components/ui/markdown', () => ({ Markdown: ({ children }: { children: string }) => React.createElement('div', { 'data-md': '' }, children) }))
vi.mock('../card-body', () => ({
  CardRecordPanel: ({ record }: { record: { type: string; id: string } }) => React.createElement('div', { 'data-record-panel': `${record.type}:${record.id}` }),
  useOpenRecords: () => {
    const [stack, setStack] = React.useState<Array<{ type: string; id: string }>>([])
    return { current: stack[stack.length - 1] ?? null, open: (r: { type: string; id: string }) => setStack((s) => [...s, r]), close: () => setStack([]) }
  },
}))

import ReviewsCard from '../pages/reviews-card'
import { cleanBody } from '../pages/reviews/pull-panel'
import type { PageCardSpec } from '@/lib/chat-cards/pages'
import type { ReviewPr } from '@/lib/github/reviews'

const spec: PageCardSpec = { kind: 'reviews', title: 'Reviews' }
const SHA = 'd'.repeat(40)

const pr = (n: number, over: Partial<ReviewPr> = {}): ReviewPr => ({
  id: `PR_${n}`,
  repo: 'acme/app',
  number: n,
  title: `Change ${n}`,
  url: `https://github.com/acme/app/pull/${n}`,
  state: 'open',
  draft: false,
  mergeable: 'MERGEABLE',
  mergeState: 'CLEAN',
  reviewDecision: 'APPROVED',
  checks: 'SUCCESS',
  createdAt: '2026-11-20T10:00:00Z',
  updatedAt: '2026-11-21T10:00:00Z',
  additions: 12,
  deletions: 3,
  changedFiles: 1,
  headRef: 'eng-1-change',
  headSha: SHA,
  baseRef: 'main',
  author: { login: 'dana', avatarUrl: null },
  labels: [],
  assignees: [],
  permission: 'WRITE',
  mergeMethods: ['squash', 'merge'],
  linked: [],
  ...over,
})

const READY = pr(1, { linked: [{ id: 'act-1', identifier: 'ENG-1', title: 'Fix it' }] })
const DRAFT = pr(2, { draft: true })
const FAILING = pr(3, { checks: 'FAILURE' })
const CLOSED = pr(4, { state: 'closed' })

let list: ReviewPr[]
let pull: (repo: string, n: number) => Response
let mergeAnswer: () => Response
const asked: string[] = []
const posts: unknown[] = []
let mount: ReturnType<typeof mountRoot>

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })

beforeEach(() => {
  asked.length = 0
  posts.length = 0
  localStorage.clear()
  hoisted.toastSuccess.mockClear()
  hoisted.toastError.mockClear()
  list = [READY, DRAFT, FAILING, CLOSED]
  pull = (_repo, n) => {
    const p = list.find((x) => x.number === n)!
    return json({
      pr: p,
      body: 'Fixes the login.<!-- template hint -->',
      checks: [{ name: 'test', outcome: 'success', url: 'https://ci.test/1' }],
      files: [{ filename: 'src/a.ts', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1,2 +1,2 @@\n-old\n+new\n same', previousFilename: null }],
      mergeBlocker: n === 1 ? null : 'It is a draft.',
    })
  }
  mergeAnswer = () => json({ merged: true, sha: 'e'.repeat(40) })
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    asked.push(`${url.pathname}${url.search}`)
    if (url.pathname === '/api/account/github/reviews') return json({ viewer: { login: 'dana' }, total: list.length, cursor: null, prs: list })
    if (url.pathname === '/api/account/github/reviews/pull') return pull(url.searchParams.get('repo')!, Number(url.searchParams.get('number')))
    if (url.pathname === '/api/account/github/reviews/merge') {
      posts.push(JSON.parse(String(init?.body)))
      return mergeAnswer()
    }
    return json({}, 404)
  })
  mount = mountRoot()
})
afterEach(() => {
  mount.unmount()
  vi.unstubAllGlobals()
})

const settle = async () => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}
const q = <T extends Element = HTMLElement>(sel: string) => (mount.container.querySelector<T>(sel) ?? document.body.querySelector<T>(sel))
const rows = () => Array.from(mount.container.querySelectorAll<HTMLElement>('[data-reviews-row]')).map((r) => r.dataset.reviewsRow)
const click = async (sel: string) => {
  await act(async () => q(sel)!.click())
  await settle()
}

async function render() {
  await mount.render(React.createElement(ReviewsCard, { toolCallId: 'rev-1', spec, store: makeStore('rev-1', spec), fullScreen: true }))
  await settle()
}

describe('ReviewsCard', () => {
  it('opens on review requests, open, recently updated, and lists each pull request', async () => {
    await render()
    expect(asked[0]).toBe('/api/account/github/reviews?section=review_requests')
    expect(rows()).toEqual(['acme/app#1', 'acme/app#2', 'acme/app#3', 'acme/app#4'])
    const row = q('[data-reviews-row="acme/app#1"]')!
    expect(row.textContent).toContain('Change 1')
    expect(row.textContent).toContain('acme/app#1')
    expect(row.textContent).toContain('Approved')
    expect(row.textContent).toContain('+12')
    expect(row.querySelector('[data-reviews-linked="act-1"]')!.textContent).toBe('ENG-1')
  })

  it('asks again for each section and filter, and remembers them on this device', async () => {
    await render()
    await click('[data-reviews-section="authored"]')
    expect(asked.at(-1)).toBe('/api/account/github/reviews?section=authored')
    await click('[data-reviews-state="all"]')
    expect(asked.at(-1)).toBe('/api/account/github/reviews?section=authored&state=all')
    const repo = q<HTMLInputElement>('[data-reviews-filter="repo"]')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(repo, 'acme/app')
      repo.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      repo.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await settle()
    expect(asked.at(-1)).toBe('/api/account/github/reviews?section=authored&state=all&repo=acme%2Fapp')
    const sort = q<HTMLSelectElement>('[data-reviews-filter="sort"]')!
    await act(async () => {
      sort.value = 'created'
      sort.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await settle()
    expect(asked.at(-1)).toContain('sort=created')
    expect(JSON.parse(localStorage.getItem('ni:reviews:prefs')!).filters).toMatchObject({ section: 'authored', state: 'all', repo: 'acme/app', sort: 'created' })
  })

  it('draws the board by column, closed-unmerged ones noted under it', async () => {
    await render()
    await click('[data-reviews-layout="board"]')
    const col = (c: string) => Array.from(q(`[data-reviews-column="${c}"]`)!.querySelectorAll<HTMLElement>('[data-reviews-card]')).map((e) => e.dataset.reviewsCard)
    expect(col('ready')).toEqual(['acme/app#1'])
    expect(col('draft')).toEqual(['acme/app#2'])
    expect(col('checks_failing')).toEqual(['acme/app#3'])
    expect(col('merged')).toEqual([])
    expect(q('[data-reviews-closed-note]')!.textContent).toContain('1 closed without merging')
  })

  it('opens the panel: description without template comments, checks, linked actions, the diff, and GitHub for reviewing', async () => {
    await render()
    await click('[data-reviews-row="acme/app#1"]')
    expect(asked).toContain('/api/account/github/reviews/pull?repo=acme%2Fapp&number=1')
    const panel = q('[data-reviews-panel="acme/app#1"]')!
    expect(panel.querySelector('[data-md]')!.textContent).toBe('Fixes the login.')
    expect(panel.querySelector('[data-reviews-checks]')!.textContent).toContain('test')
    expect(panel.querySelector<HTMLAnchorElement>('[data-reviews-github]')!.href).toBe('https://github.com/acme/app/pull/1')
    await click('[data-reviews-panel] [data-reviews-linked="act-1"]')
    expect(q('[data-record-panel="action:act-1"]')).not.toBeNull()
  })

  it('shows the files changed as a read-only diff', async () => {
    await render()
    await click('[data-reviews-row="acme/app#1"]')
    await click('[data-reviews-tab="files"]')
    const file = q('[data-reviews-file="src/a.ts"]')!
    expect(Array.from(file.querySelectorAll<HTMLElement>('[data-diff]')).map((r) => r.dataset.diff)).toEqual(['hunk', 'del', 'add', 'ctx'])
    expect(file.querySelector('textarea, input, [contenteditable]')).toBeNull()
  })

  it('merges only after the confirm, pinned to the head it showed, with the method picked', async () => {
    await render()
    await click('[data-reviews-row="acme/app#1"]')
    await click('[data-reviews-merge]')
    // Nothing merges before the confirm.
    expect(posts).toEqual([])
    const merge = document.body.querySelector<HTMLInputElement>('[data-reviews-method="merge"]')!
    await act(async () => merge.click())
    await act(async () => document.body.querySelector<HTMLElement>('[data-reviews-merge-confirm]')!.click())
    await settle()
    expect(posts).toEqual([{ repo: 'acme/app', number: 1, method: 'merge', sha: SHA }])
    expect(hoisted.toastSuccess).toHaveBeenCalledWith('Merged acme/app#1')
  })

  it('offers no merge while something blocks it, and says what', async () => {
    await render()
    await click('[data-reviews-row="acme/app#2"]')
    expect(q<HTMLButtonElement>('[data-reviews-merge]')!.disabled).toBe(true)
    expect(q('[data-reviews-merge-blocker]')!.textContent).toBe('It is a draft.')
  })

  it('says GitHub refused the merge in its own words', async () => {
    mergeAnswer = () => json({ error: 'Required status check is expected.', code: 'merge_refused' }, 409)
    await render()
    await click('[data-reviews-row="acme/app#1"]')
    await click('[data-reviews-merge]')
    await act(async () => document.body.querySelector<HTMLElement>('[data-reviews-merge-confirm]')!.click())
    await settle()
    expect(hoisted.toastError).toHaveBeenCalledWith('Required status check is expected.')
  })

  it('points to Connectors when GitHub is not connected', async () => {
    vi.stubGlobal('fetch', async () => json({ error: 'Connect GitHub in Settings › Connectors to see your pull requests.', code: 'github_not_connected' }, 409))
    await render()
    expect(q('[data-reviews-error="github_not_connected"]')!.textContent).toContain('Connect GitHub')
    expect(q<HTMLAnchorElement>('[data-reviews-error] a')!.getAttribute('href')).toBe('/account/settings/connectors')
  })

  it('moves with J and K, and opens with Enter', async () => {
    await render()
    const listbox = q('[role="listbox"]')!
    listbox.focus()
    await act(async () => listbox.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true })))
    await act(async () => listbox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    await settle()
    expect(q('[data-reviews-panel="acme/app#2"]')).not.toBeNull()
  })
})

describe('opened on one pull request (a GitHub notice)', () => {
  it('opens its panel, even one not in the section listed', async () => {
    list = [READY]
    pull = (_repo, n) => json({ pr: pr(n, { title: 'From a notice' }), body: '', checks: [], files: [], mergeBlocker: 'It is a draft.' })
    const onSpec: PageCardSpec = { kind: 'reviews', title: 'Reviews', target: { type: 'github_pr', id: 'acme/app#9', label: 'From a notice' } }
    await mount.render(React.createElement(ReviewsCard, { toolCallId: 'rev-2', spec: onSpec, store: makeStore('rev-2', onSpec), fullScreen: true }))
    await settle()
    expect(asked).toContain('/api/account/github/reviews/pull?repo=acme%2Fapp&number=9')
    expect(q('[data-reviews-panel="acme/app#9"]')!.textContent).toContain('From a notice')
  })
})

describe('cleanBody', () => {
  it('drops HTML comments', () => {
    expect(cleanBody('<!-- hi -->\nBody <!--\nmore\n--> end')).toBe('Body  end')
  })
})
