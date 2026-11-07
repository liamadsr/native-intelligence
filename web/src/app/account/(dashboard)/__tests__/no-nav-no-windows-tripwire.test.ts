/**
 * P5 (docs/plans/one-agent-and-chat-pages.md, Part 2 "No nav"): the dashboard
 * is ONE chat (docs/plans/one-chat.md), and every page is a card in it. The nav rail, the page
 * picker, floating windows, page history, ⌘K and the page hotkeys are gone for
 * good — this pins that nothing brings them back by the side door:
 *
 *   • their modules are deleted, and nothing in src/ imports them;
 *   • the only global hotkeys the shell registers are ⌘, (settings) and ⌘N (a
 *     capture) — no bare-letter page keys (t, m, d, p, b, w), no ⌘K;
 *   • the tabs are gone too: no tab strip, no chat history, no chat titles.
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
const DASH = 'src/app/account/(dashboard)'

const GONE = [
  `${DASH}/nav-menu.tsx`,
  `${DASH}/gooey-nav.tsx`,
  `${DASH}/use-page-windows.ts`,
  `${DASH}/content-windows.tsx`,
  `${DASH}/content-window-frame.ts`,
  `${DASH}/content-window-tuck.tsx`,
  `${DASH}/window-motion.ts`,
  `${DASH}/use-window-geometry.ts`,
  `${DASH}/use-content-drag.ts`,
  `${DASH}/window-drag-surface.ts`,
  `${DASH}/backdrop-click.ts`,
  `${DASH}/command-palette-bridge.tsx`,
  `${DASH}/tabs/windows.ts`,
  `${DASH}/tabs/tab-content.tsx`,
  `${DASH}/tabs/chat-windows-stash.ts`,
  `${DASH}/tabs/window-shortcuts.ts`,
  `${DASH}/tabs/conversation-context.ts`,
  `${DASH}/views/flows/flow-open-signal.ts`,
  'src/components/command-palette.tsx',
  'src/components/email/mail-open-signal.ts',
  'src/components/views/window-history.tsx',
  'src/components/views/window-close.tsx',
  'src/components/views/window-page-title.tsx',
  'src/components/views/use-window-header-corner.ts',
  'src/components/bots/bot-page/use-page-window.ts',
]

/** Module specifiers that would mean one of them came back. */
const GONE_IMPORTS = [
  /['"][^'"]*\/nav-menu['"]/,
  /['"][^'"]*\/gooey-nav['"]/,
  /['"][^'"]*\/content-windows?['"]/,
  /['"][^'"]*\/content-window-(frame|tuck)['"]/,
  /['"][^'"]*\/window-motion['"]/,
  /['"][^'"]*\/use-window-geometry['"]/,
  /['"][^'"]*\/use-content-drag['"]/,
  /['"][^'"]*\/window-drag-surface['"]/,
  /['"][^'"]*\/backdrop-click['"]/,
  /['"][^'"]*\/command-palette(-bridge)?['"]/,
  /['"][^'"]*\/tabs\/windows['"]/,
  /['"][^'"]*\/tab-content['"]/,
  /['"][^'"]*\/conversation-context['"]/,
  /['"][^'"]*\/(flow|mail)-open-signal['"]/,
  /['"][^'"]*\/window-(history|close|page-title)['"]/,
  /['"][^'"]*\/use-window-header-corner['"]/,
  /['"][^'"]*\/use-page-window['"]/,
  /['"][^'"]*\/use-page-windows['"]/,
]

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) sourceFiles(path, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(path)
  }
  return out
}

describe('no nav, no windows (P5)', () => {
  it('the nav, the page picker, the windows, page history and ⌘K are deleted', () => {
    for (const file of GONE) expect(existsSync(join(ROOT, file)), file).toBe(false)
  })

  it('nothing in src/ imports them', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(join(ROOT, 'src'))) {
      if (file.endsWith('no-nav-no-windows-tripwire.test.ts')) continue
      const text = readFileSync(file, 'utf8')
      const imports = text.match(/(?:from\s+|import\(\s*|vi\.mock\(\s*)['"][^'"]+['"]/g) ?? []
      for (const spec of imports) {
        if (GONE_IMPORTS.some((re) => re.test(spec))) offenders.push(`${relative(ROOT, file)}: ${spec}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('the shell’s global hotkeys are ⌘, and ⌘N only: no page keys, no ⌘K', () => {
    const bar = readFileSync(join(ROOT, DASH, 'top-bar/top-bar.tsx'), 'utf8')
    const block = bar.match(/useHotkeys\(\[([\s\S]*?)\]\)/)
    expect(block, 'the top bar’s hotkeys').not.toBeNull()
    const keys = [...block![1].matchAll(/key:\s*'([^']+)'(?:,\s*mod:\s*(true))?/g)].map((m) => `${m[2] ? 'mod+' : ''}${m[1]}`)
    expect(keys).toEqual(['mod+,', 'mod+n'])
    // ⌘K nowhere in the app.
    for (const file of sourceFiles(join(ROOT, 'src'))) {
      if (file.includes('__tests__')) continue
      expect(readFileSync(file, 'utf8'), relative(ROOT, file)).not.toMatch(/key:\s*'k',\s*mod:\s*true/)
    }
  })

  it('there are no tabs: one main chat, no tab strip, no chat history, no titles (one-chat Slice 1)', () => {
    for (const file of [
      `${DASH}/tabs/tab-context.tsx`,
      `${DASH}/tabs/tab-bar.tsx`,
      `${DASH}/tabs/chat-tabs.ts`,
      `${DASH}/tabs/lazy-chat.ts`,
      `${DASH}/tabs/tab-wake.tsx`,
      `${DASH}/tabs/use-tab-reorder.ts`,
      `${DASH}/chat/chat-history-popover.tsx`,
      `${DASH}/chat/use-chat-auto-title.ts`,
      `${DASH}/chat/start-chat.ts`,
      'src/app/api/account/chat/title/route.ts',
      'src/components/bots/bot-page/conversations.tsx',
    ]) {
      expect(existsSync(join(ROOT, file)), file).toBe(false)
    }
    // The chat history list is gone; creating a conversation (its POST) stays.
    const history = readFileSync(join(ROOT, 'src/app/api/account/chat-history/route.ts'), 'utf8')
    expect(history).not.toMatch(/export async function GET\b/)
    expect(history).toMatch(/export async function POST\b/)
    const types = readFileSync(join(ROOT, DASH, 'main-chat/types.ts'), 'utf8')
    expect(types).not.toMatch(/\btitle\??:/)
    expect(types).not.toMatch(/TabState|TabAction/)
  })

  it('the workspace-switch curtain has the chat row to cover', () => {
    const shell = readFileSync(join(ROOT, DASH, 'dashboard-shell.tsx'), 'utf8')
    expect(shell).toMatch(/id=\{CONTENT_PANEL_ID\}/)
    expect(readFileSync(join(ROOT, 'src/app/account/workspace-transition.tsx'), 'utf8')).toMatch(/getElementById\(CONTENT_PANEL_ID\)/)
  })
})
