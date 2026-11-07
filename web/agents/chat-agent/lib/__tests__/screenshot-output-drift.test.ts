/**
 * The three agents that proxy the in-app browser tools each carry a copy of
 * lib/screenshot-output.ts (the eve bundler can't share code across agents).
 * The copies must stay identical apart from comments, and the tool names they
 * key on must still be the browser tools' names in src/lib/ai/tools/browser.ts.
 * Normalization is url-guard-drift.test.ts's: block comments, whole-line //
 * comments and whitespace runs out; everything else must match.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SCREENSHOT_TOOL_NAMES } from '../screenshot-output'

const AGENTS = ['chat-agent', 'work-agent', 'skill-runner'] as const
const AGENTS_ROOT = new URL('../../../', import.meta.url)
const BROWSER_TOOLS = fileURLToPath(new URL('../src/lib/ai/tools/browser.ts', AGENTS_ROOT))

function read(agent: string): string {
  return readFileSync(fileURLToPath(new URL(`${agent}/lib/screenshot-output.ts`, AGENTS_ROOT)), 'utf8')
}

function normalize(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

describe('agents/*/lib/screenshot-output.ts', () => {
  const canonical = normalize(read('chat-agent'))

  it('the chat-agent original survives normalization', () => {
    expect(canonical).toContain('export function screenshotModelOutput')
    expect(canonical.length).toBeGreaterThan(800)
  })

  for (const agent of AGENTS.filter((a) => a !== 'chat-agent')) {
    it(`${agent} matches the chat-agent original (comments aside)`, () => {
      expect(normalize(read(agent))).toBe(canonical)
    })
  }

  it('keys on tool names the browser tools still define', () => {
    const source = readFileSync(BROWSER_TOOLS, 'utf8')
    for (const name of SCREENSHOT_TOOL_NAMES) expect(source).toContain(`    ${name}: tool({`)
    // The field the helper strips is the one the cloud browser's relay returns.
    expect(readFileSync(fileURLToPath(new URL('../src/lib/cloud-browser/cdp/commands.ts', AGENTS_ROOT)), 'utf8')).toContain(
      "return { screenshotBase64, mediaType: 'image/jpeg' }",
    )
  })
})
