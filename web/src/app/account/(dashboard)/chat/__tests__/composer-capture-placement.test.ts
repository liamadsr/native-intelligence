import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * Capture lives once, in the main chat's composer, left of the mic and Send
 * (Liam, 2026-10-19: moved out of the top bar, "just the icon", "Start
 * capture" on hover): ComposerCaptureButton (../composer-capture-button). The
 * top bar's Capture pill (top-bar/capture-bar-button, with its calendar) is
 * no longer rendered anywhere.
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

describe('Capture: once, in the main chat’s composer', () => {
  const input = strip(readFileSync(join(ROOT, CHAT_INPUT), 'utf8'))

  it('is rendered in the composer only, for the main chat, and the top bar has no Capture', () => {
    expect(renderedIn('<ComposerCaptureButton')).toEqual([CHAT_INPUT])
    expect(input).toContain('{mainComposer && recording && <ComposerCaptureButton recording={recording} />}')
    // The chat panel hands it the recording it reads already.
    expect(strip(readFileSync(join(ROOT, 'src/app/account/(dashboard)/chat/chat-panel.tsx'), 'utf8'))).toContain('recording={recording}')
    expect(renderedIn('<CaptureBarButton')).toEqual([])
    expect(strip(readFileSync(join(ROOT, TOP_BAR), 'utf8'))).not.toMatch(/Capture(Bar)?Button/)
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
