import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The tool ladder ("Choosing a tool:") in the main chat's instructions and the
 * work agent's: cheapest source first (what is already in front of the agent,
 * the page open in its browser included), unless the person named a tool; the
 * browser only where the chat has one; a broken connector reported, never routed
 * around. Short, because
 * the model reads it every turn.
 */
const read = (agent: string) => readFileSync(join(__dirname, '../../..', agent, 'instructions.md'), 'utf8')

/** The section, from its heading to the next one (a line ending in a colon after a blank line). */
function ladder(text: string): string {
  const start = text.indexOf('Choosing a tool:')
  const next = text.slice(start + 1).search(/\n\n[A-Z][^\n]*:\n/)
  const end = next < 0 ? -1 : start + 1 + next
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return text.slice(start, end)
}

const words = (s: string) => s.split(/\s+/).filter(Boolean).length

describe('the tool ladder', () => {
  it('main chat: what is in front of it, tools, web, then its cloud browser, then the person', () => {
    const section = ladder(read('chat-agent'))
    const order = ['this conversation', 'the page open in your browser\n  (`read_browser_page`)', 'workspace tools and connected apps', '`web_search` and\n  `web_fetch`', '`run_browser_task`', 'ask the person']
    const flat = section.replace(/\s+/g, ' ')
    const at = order.map((o) => flat.indexOf(o.replace(/\s+/g, ' ')))
    expect(at.every((i) => i > -1)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    // The cloud browser answers on every surface (cloud browser C5).
    expect(section).not.toContain('desktop only')
    // Reading the open page is rung 1, before any tool call; a named tool skips the ladder.
    expect(at[1]).toBeLessThan(flat.indexOf('(2)'))
    expect(flat).toContain('Unless the person asked for a specific tool,')
    // F2: a broken connection is offered back as a Connect card, still never routed around.
    expect(section).toContain('If a connector or tool is broken, say so and offer `connect`. Never work\n  around it with the browser.')
    // Quick helpers (A4 slice 3) are the helper roster's ("Models for helpers")
    // and the base prompt's to say, not the ladder's.
    expect(flat).not.toContain('`helpers`')
    expect(words(section)).toBeLessThanOrEqual(110)
  })

  it('work agent: no browser rung, and asking follows its own rules', () => {
    const section = ladder(read('work-agent'))
    expect(section).not.toContain('run_browser_task')
    expect(section).toContain('You have no browser.')
    expect(section.replace(/\s+/g, ' ')).toContain('as the asking rules below allow')
    expect(section.replace(/\s+/g, ' ')).toContain('Unless the brief or the user names a specific tool,')
    expect(section.replace(/\s+/g, ' ')).toContain('(3) `web_search` and `web_fetch`')
    expect(section).toContain('If a connector or tool is broken, say so')
    expect(words(section)).toBeLessThanOrEqual(90)
  })
})
