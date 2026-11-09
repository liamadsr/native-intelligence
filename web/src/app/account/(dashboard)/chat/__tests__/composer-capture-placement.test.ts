import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * Capture (ComposerCaptureButton, ../composer-capture-button): from `md` up in
 * the top bar's right header, beside the side panel's toggle (Liam, 11-09:
 * "move the capture button and make a component like the one we have on the
 * left"); below `md` (a phone, where that header doesn't show) in the main
 * chat's composer, left of the mic and Send (Liam, 2026-10-19). The old top
 * bar Capture pill (top-bar/capture-bar-button, with its calendar) is no
 * longer rendered anywhere.
 *
 * A source check, because the composer and the top bar are too heavy to
 * mount here and the property is where the control is rendered at all. Its
 * behaviour is in composer-capture-button.test.
 */

const ROOT = process.cwd()
const CHAT_INPUT = 'src/app/account/(dashboard)/chat/chat-input.tsx'
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

const renderedIn = (tag: string) =>
  sourceFiles(join(ROOT, 'src'))
    .filter((file) => strip(readFileSync(file, 'utf8')).includes(tag))
    .map((file) => relative(ROOT, file))

describe('Capture: the top bar’s right header from md up, the main chat’s composer on a phone', () => {
  const input = strip(readFileSync(join(ROOT, CHAT_INPUT), 'utf8'))

  it('is rendered in the top bar’s right header and, for a phone only, in the main chat’s composer', () => {
    expect(renderedIn('<ComposerCaptureButton').sort()).toEqual([CHAT_INPUT, TOP_BAR].sort())
    // The composer's: the main chat's, below md only.
    const phoneOnly = input.indexOf('data-composer-capture-phone-only="" className="contents md:hidden"')
    expect(phoneOnly).toBeGreaterThan(-1)
    expect(input.indexOf('<ComposerCaptureButton recording={recording} />', phoneOnly)).toBeGreaterThan(phoneOnly)
    expect(input).toContain('{mainComposer && recording && (')
    // The top bar's: in its right header (md and up), with the side panel's toggle.
    const bar = strip(readFileSync(join(ROOT, TOP_BAR), 'utf8'))
    const header = bar.indexOf('data-top-bar-right-header=""')
    expect(header).toBeGreaterThan(-1)
    expect(bar.indexOf('<ComposerCaptureButton recording={recording} />', header)).toBeGreaterThan(header)
    expect(bar.indexOf('<SidePanelToggle variant="header" />', header)).toBeGreaterThan(header)
    // The chat panel hands it the recording it reads already.
    expect(strip(readFileSync(join(ROOT, 'src/app/account/(dashboard)/chat/chat-panel.tsx'), 'utf8'))).toContain('recording={recording}')
    expect(renderedIn('<CaptureBarButton')).toEqual([])
  })

  it('sits right of the row’s spacer, left of the mic and the send slot', () => {
    const spacer = input.indexOf('<div className="min-w-0 flex-1" />')
    const capture = input.indexOf('<ComposerCaptureButton')
    const mic = input.indexOf('<DictationButton', capture)
    const send = input.indexOf('<PromptInputActions className="shrink-0">', capture)
    expect(spacer).toBeGreaterThan(-1)
    expect(spacer).toBeLessThan(capture)
    expect(capture).toBeLessThan(mic)
    expect(mic).toBeLessThan(send)
  })
})
