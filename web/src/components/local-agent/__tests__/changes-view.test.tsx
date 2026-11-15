// @vitest-environment jsdom
/**
 * The Changes view of an edit job (changes-view.tsx): the diff is read from
 * the job's own Mac (the desktop's `local_agent_diff`) only in the app on
 * that Mac; anywhere else one line says where to read it, with the pull
 * request's link when there is one. Its states (reading, cut, empty, a file
 * without a preview, a long file collapsed, an app too old, a refusal) are
 * said plainly, and the person's notes on lines and files go to the job as
 * ONE follow-up message.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { LocalAgentDiff } from '@/lib/tauri-bridge'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mac = vi.hoisted(() => ({
  desktop: true,
  deviceId: 'mac-1',
  diff: vi.fn(),
}))
vi.mock('@/lib/platform', () => ({ isDesktopApp: () => mac.desktop }))
vi.mock('@/lib/tauri-bridge', () => ({
  tauriBridge: {
    localAgent: {
      device: async () => ({ ok: true, value: { deviceId: mac.deviceId, name: 'Studio Mac', platform: 'macos', appVersion: '1.0.0' } }),
      diff: mac.diff,
    },
  },
}))

import { ChangesView, noPreviewText, showsCounts, splitPath } from '../changes-view'
import { DiffLineRow } from '@/components/documents/diff-line-row'
import { LARGE_FILE_LINES } from '@/lib/local-agent/changes'

const SID = '11111111-2222-4333-8444-555555555555'
const PR = 'https://github.com/fernhill/studio-site/pull/42'

const DIFF: LocalAgentDiff = {
  base: 'main',
  head: 'abc1234',
  truncated: false,
  files: [
    {
      path: 'src/export.ts',
      status: 'modified',
      additions: 2,
      deletions: 1,
      binary: false,
      patch: '@@ -10,3 +10,4 @@\n   const rows = read()\n-  return rows\n+  const kept = rows.filter(Boolean)\n+  return kept\n',
    },
    { path: 'assets/logo.png', status: 'added', additions: 0, deletions: 0, binary: true, patch: '' },
    { path: '.env.local', status: 'modified', additions: 1, deletions: 1, binary: false, patch: '' },
    {
      path: 'src/big.ts',
      status: 'added',
      additions: LARGE_FILE_LINES + 1,
      deletions: 0,
      binary: false,
      patch: `@@ -0,0 +1,${LARGE_FILE_LINES + 1} @@\n${Array.from({ length: LARGE_FILE_LINES + 1 }, (_, i) => `+line ${i}`).join('\n')}`,
    },
  ],
}

let container: HTMLDivElement
let root: Root
const sent: string[] = []
let sendResult: { ok: true } | { ok: false; message: string } = { ok: true }

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

async function mount(over: { canMessage?: boolean; prUrl?: string | null; deviceId?: string } = {}) {
  await act(async () => {
    root.render(
      h(ChangesView, {
        sessionId: SID,
        deviceId: over.deviceId ?? 'mac-1',
        deviceName: 'Studio Mac',
        branch: 'dial8/studio-site-11111111',
        prUrl: over.prUrl ?? null,
        canMessage: over.canMessage ?? true,
        onSendNotes: async (text: string) => {
          sent.push(text)
          return sendResult
        },
      }),
    )
  })
  await settle()
  await settle()
}

const q = <T extends Element = HTMLElement>(sel: string) => container.querySelector<T>(sel)
const file = (path: string) => q(`[data-changes-file="${path}"]`)!

function typeInto(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(() => {
  mac.desktop = true
  mac.deviceId = 'mac-1'
  mac.diff.mockReset()
  mac.diff.mockResolvedValue({ ok: true, value: DIFF })
  sent.length = 0
  sendResult = { ok: true }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('where the changes can be read', () => {
  it('outside the desktop app: one line naming the Mac, and the pull request when there is one; nothing is read', async () => {
    mac.desktop = false
    await mount({ prUrl: PR })
    expect(q('[data-changes-elsewhere]')?.textContent).toBe('The changes can be read in the Native Intelligence app on Studio Mac.')
    expect(q<HTMLAnchorElement>('[data-changes-pr]')?.href).toBe(PR)
    expect(q('[data-changes-pr]')?.textContent).toContain('pull request #42')
    expect(mac.diff).not.toHaveBeenCalled()
  })

  it('the app on another Mac is elsewhere too; without a pull request, no link', async () => {
    mac.deviceId = 'mac-2'
    await mount()
    expect(q('[data-changes-place]')?.getAttribute('data-changes-place')).toBe('elsewhere')
    expect(q('[data-changes-pr]')).toBeNull()
    expect(mac.diff).not.toHaveBeenCalled()
  })

  it('the app on the job’s Mac reads the job’s diff from it', async () => {
    await mount()
    expect(mac.diff).toHaveBeenCalledWith(SID)
    expect(q('[data-changes-summary]')?.textContent).toBe(`4 files changed · +${LARGE_FILE_LINES + 4} −2 · dial8/studio-site-11111111 against main`)
  })
})

describe('the diff’s states', () => {
  it('each file with how it changed and its counts; a readable diff with line numbers', async () => {
    await mount()
    expect(file('src/export.ts').getAttribute('data-changes-file-status')).toBe('modified')
    expect(file('src/export.ts').textContent).toContain('Modified')
    const lines = [...file('src/export.ts').querySelectorAll('[data-changes-line]')].map((l) => l.getAttribute('data-changes-line'))
    expect(lines).toEqual(['new:10', 'old:11', 'new:11', 'new:12'])
    expect(file('src/export.ts').textContent).toContain('const kept = rows.filter(Boolean)')
  })

  it('a binary file and one listed without its contents say so; a long file opens collapsed', async () => {
    await mount()
    expect(file('assets/logo.png').querySelector('[data-changes-no-preview]')?.textContent).toBe('Binary file: no preview.')
    expect(file('.env.local').querySelector('[data-changes-no-preview]')?.textContent).toContain('a name that looks like it holds secrets')
    const big = file('src/big.ts')
    expect(big.querySelector('[data-changes-toggle]')?.getAttribute('aria-expanded')).toBe('false')
    expect(big.querySelectorAll('[data-changes-line]')).toHaveLength(0)
    await act(async () => big.querySelector<HTMLButtonElement>('[data-changes-toggle]')!.click())
    expect(big.querySelectorAll('[data-changes-line]')).toHaveLength(LARGE_FILE_LINES + 1)
  })

  it('a cut diff says what the limits are; an empty one says there is nothing yet', async () => {
    mac.diff.mockResolvedValueOnce({ ok: true, value: { ...DIFF, truncated: true } })
    await mount()
    expect(q('[data-changes-truncated]')?.textContent).toContain('at most 300 files, 200 KB of one file and 2 MB in all')
    mac.diff.mockResolvedValueOnce({ ok: true, value: { ...DIFF, files: [] } })
    await act(async () => q<HTMLButtonElement>('[aria-label="Read the changes again"]')!.click())
    await settle()
    expect(q('[data-changes-empty]')?.textContent).toBe('No changes on this branch yet.')
  })

  it('an app without the command asks for an update; a refusal says why and offers a retry', async () => {
    mac.diff.mockResolvedValueOnce({ ok: false, unavailable: true, error: 'command local_agent_diff not found' })
    await mount()
    expect(q('[data-changes-unsupported]')?.textContent).toContain('Update Native Intelligence on this Mac')
    await act(async () => root.unmount())
    root = createRoot(container)
    mac.diff.mockResolvedValueOnce({ ok: false, unavailable: false, error: 'the job’s worktree is gone' })
    await mount()
    expect(q('[data-changes-error]')?.textContent).toContain('The changes couldn’t be read: the job’s worktree is gone')
  })

  it('noPreviewText: a rename without changes reads as one', () => {
    expect(noPreviewText({ binary: false, patch: '', status: 'renamed' })).toBe('Renamed without changes.')
    expect(noPreviewText({ binary: false, patch: '@@ -1 +1 @@', status: 'modified' })).toBeNull()
  })
})

describe('review notes', () => {
  async function note(selector: string, text: string) {
    await act(async () => q<HTMLElement>(selector)!.click())
    const box = q<HTMLTextAreaElement>('[data-changes-note-editor] textarea')!
    await act(async () => typeInto(box, text))
    await act(async () => q<HTMLButtonElement>('[data-changes-add-note]')!.click())
  }

  it('notes on a line and on a file collect, then go to the job as ONE message listing each with its file and line', async () => {
    await mount()
    await note('[data-changes-file="src/export.ts"] [data-changes-line="new:11"]', 'Keep the empty rows: the totals need them.')
    await note('[data-changes-file="assets/logo.png"] [data-changes-file-note]', 'Use the SVG instead.')
    await note('[data-changes-file="src/export.ts"] [data-changes-line="old:11"]', 'Why did this go?')
    expect(q('[data-changes-notes]')?.getAttribute('data-changes-notes')).toBe('3')
    expect(sent).toEqual([])
    await act(async () => q<HTMLButtonElement>('[data-changes-send]')!.click())
    await settle()
    expect(sent).toEqual([
      [
        'Review notes on your changes. Please address each one, then tell me what you changed:',
        '',
        '1. File "assets/logo.png" (the whole file):',
        '   Use the SVG instead.',
        '',
        '2. File "src/export.ts", removed line 11:',
        '   ```',
        '     return rows',
        '   ```',
        '   Why did this go?',
        '',
        '3. File "src/export.ts", line 11:',
        '   ```',
        '     const kept = rows.filter(Boolean)',
        '   ```',
        '   Keep the empty rows: the totals need them.',
      ].join('\n'),
    ])
    // Nothing kept beyond the message.
    expect(q('[data-changes-note]')).toBeNull()
    expect(q('[data-changes-sent]')?.textContent).toBe('Your 3 notes went to the agent as one message.')
  })

  it('a note can be removed; a refused send keeps the notes and says why', async () => {
    await mount()
    await note('[data-changes-file="src/export.ts"] [data-changes-line="new:10"]', 'First')
    await note('[data-changes-file="src/export.ts"] [data-changes-line="new:12"]', 'Second')
    await act(async () => q<HTMLButtonElement>('[aria-label="Remove the note on src/export.ts, line 10"]')!.click())
    sendResult = { ok: false, message: 'This local agent has ended.' }
    await act(async () => q<HTMLButtonElement>('[data-changes-send]')!.click())
    await settle()
    expect(sent).toEqual(['Review notes on your changes. Please address each one, then tell me what you changed:\n\n1. File "src/export.ts", line 12:\n   ```\n     return kept\n   ```\n   Second'])
    expect(q('[data-changes-notes]')?.textContent).toContain('This local agent has ended.')
    expect(q('[data-changes-note]')).not.toBeNull()
  })

  it('a job that can’t take a message: the notes stay, Send is off and says why', async () => {
    await mount({ canMessage: false })
    await note('[data-changes-file="src/export.ts"] [data-changes-line="new:10"]', 'Rename this')
    expect(q<HTMLButtonElement>('[data-changes-send]')?.disabled).toBe(true)
    expect(q('[data-changes-notes]')?.textContent).toContain('This job can’t take a message now.')
  })
})

describe('how it reads in a narrow panel', () => {
  it('splitPath: the folders are what gets cut, the file name stays whole', () => {
    expect(splitPath('src/components/export-panel.tsx')).toEqual({ dir: 'src/components/', name: 'export-panel.tsx' })
    expect(splitPath('README.md')).toEqual({ dir: '', name: 'README.md' })
  })

  it('a path draws its folders (cut first) apart from its name; a rename shows both, the old giving first', async () => {
    mac.diff.mockResolvedValueOnce({
      ok: true,
      value: {
        ...DIFF,
        files: [{ path: 'src/next/name.ts', oldPath: 'src/old/name.ts', status: 'renamed', additions: 0, deletions: 0, binary: false, patch: '' }],
      },
    })
    await mount()
    const label = file('src/next/name.ts').querySelector('[data-changes-path]')!
    expect(label.getAttribute('title')).toBe('src/old/name.ts → src/next/name.ts')
    const parts = [...label.querySelectorAll('span.font-mono')]
    expect(parts.map((p) => p.className.includes('shrink-[999]'))).toEqual([true, false])
    expect(parts[1].textContent).toBe('src/next/name.ts')
    expect(parts[1].lastElementChild?.textContent).toBe('name.ts')
    expect(parts[1].lastElementChild?.className).not.toContain('shrink-[999]')
  })

  it('no counts for a binary file or a rename that changed nothing', async () => {
    expect(showsCounts({ binary: true, status: 'added', additions: 0, deletions: 0 })).toBe(false)
    expect(showsCounts({ binary: false, status: 'renamed', additions: 0, deletions: 0 })).toBe(false)
    expect(showsCounts({ binary: false, status: 'renamed', additions: 2, deletions: 1 })).toBe(true)
    expect(showsCounts({ binary: false, status: 'modified', additions: 0, deletions: 0 })).toBe(true)
    await mount()
    expect(file('assets/logo.png').querySelector('[data-changes-counts]')).toBeNull()
    expect(file('src/export.ts').querySelector('[data-changes-counts]')?.textContent).toBe('+2 −1')
  })

  it('a hunk header is one line, its full text in the title; code rows keep numbers and sign in their own columns, removed lines unstruck', async () => {
    await mount()
    const hunk = file('src/export.ts').querySelector('[data-changes-hunk]')!
    expect(hunk.className).toContain('truncate')
    expect(hunk.getAttribute('title')).toBe('@@ -10,3 +10,4 @@')
    const removed = file('src/export.ts').querySelector('[data-diff-row="removed"]')!
    expect(removed.className).toContain('grid')
    expect(removed.className).not.toContain('line-through')
    expect([...removed.children].map((c) => c.textContent)).toEqual(['11', '', '−', '  return rows'])
    expect(removed.lastElementChild?.className).toContain('whitespace-pre-wrap')
  })

  it('the documents’ own diff row is as it was: struck when removed, the text flowing after its sign', async () => {
    await act(async () => root.render(h(DiffLineRow, { kind: 'removed', text: 'old words' })))
    const row = q('[data-diff-row="removed"]')!
    expect(row.className).toContain('line-through')
    expect(row.className).not.toContain('grid')
    expect(row.textContent).toBe('−old words')
  })
})
