import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * The Listen mode toggle (components/read-aloud/listen-mode-toggle.tsx) lives
 * once, for the whole app, in the top bar near the workspace pill (../top-bar),
 * with only the Capture button between them (Liam, 2026-10-09: Capture moves
 * up next to the workspace picker).
 * Liam, 2026-09-27: "it should live in the top header of the page next to the
 * workspace picker, that way we only show it once". The page headers that
 * carried it before (Mail, the team board, Docs, My Actions, an open action)
 * don't: which windows listen mode reads is shown by their pulse
 * (components/read-aloud/listen-frame.tsx).
 *
 * A source check, because TabBar is too heavy to mount here and the property
 * is where the component is rendered at all: every `<ListenModeToggle` in
 * src/, outside tests. The render harnesses in list-header-listen-mode.test.tsx
 * and views/__tests__/listen-mode-toggle-placement.test.tsx check the headers
 * that used to carry it.
 */

const ROOT = process.cwd()
const TOP_BAR = 'src/app/account/(dashboard)/top-bar/top-bar.tsx'

/** Block comments (JSX `{/* … *\/}` included) and whole-line `//` comments. */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

function sourceFiles(dir: string): string[] {
  const files: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name !== '__tests__') files.push(...sourceFiles(path))
    } else if (/\.(tsx?|jsx?)$/.test(name) && !/\.test\.[jt]sx?$/.test(name)) {
      files.push(path)
    }
  }
  return files
}

describe('the Listen mode toggle: once, in the top bar', () => {
  const topBar = strip(readFileSync(join(ROOT, TOP_BAR), 'utf8'))

  // And over a full-screen card, which covers the bar (Liam, 2026-10-09: the
  // Interactive button and its controls should show in full screen, top
  // right): the same switch, once, in show-tool-card's FullScreenInteractive.
  const FULL_SCREEN_CARD = 'src/components/chat-cards/show-tool-card.tsx'

  it('is rendered in the top bar, once, and over a full-screen card, once', () => {
    const renderedIn = sourceFiles(join(ROOT, 'src'))
      .filter((file) => strip(readFileSync(file, 'utf8')).includes('<ListenModeToggle'))
      .map((file) => relative(ROOT, file))
      .sort()
    expect(renderedIn).toEqual([FULL_SCREEN_CARD, TOP_BAR].sort())
    expect(topBar.match(/<ListenModeToggle\b/g)).toHaveLength(1)
    const card = strip(readFileSync(join(ROOT, FULL_SCREEN_CARD), 'utf8'))
    expect(card.match(/<ListenModeToggle\b/g)).toHaveLength(1)
    expect(card.slice(card.indexOf('function FullScreenInteractive'))).toMatch(/^function FullScreenInteractive[\s\S]*?<ListenModeToggle/)
  })

  it("sits in the bar's trailing cluster: the toggle, then the side panel's toggle, then the workspace pill at the very end", () => {
    const trail = topBar.indexOf('data-tab-bar-trail')
    const toggle = topBar.indexOf('<ListenModeToggle')
    const sidePanel = topBar.indexOf('<SidePanelToggle')
    const pill = topBar.indexOf('<WorkspaceSwitcher variant="pill"')
    expect(trail).toBeGreaterThan(-1)
    expect(sidePanel).toBeGreaterThan(-1)
    expect(pill).toBeGreaterThan(-1)
    expect(trail).toBeLessThan(toggle)
    expect(toggle).toBeLessThan(sidePanel)
    expect(sidePanel).toBeLessThan(pill)
    // The pill ends the bar: no control after it.
    expect(topBar.slice(pill + 1).match(/<[A-Z]\w*/g)).toBeNull()
  })
})
