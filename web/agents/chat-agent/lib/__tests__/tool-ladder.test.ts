import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The tool ladder in the main chat's instructions and the work agent's:
 * cheapest source first (what is already in front of the agent, the page open
 * in its browser included), the browser only where the chat has one, then the
 * person; a broken connector reported, never routed around. Short, because
 * the model reads it every turn. The main chat's is one line of "Working
 * well" since the goal-driven rewrite (docs/plans/goal-driven-main-agent.md
 * §1); the work agent's is still its own "Choosing a tool:" section.
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

/** The main chat's "Know before you speak." bullet, to the next bullet. */
function knowBeforeYouSpeak(text: string): string {
  const start = text.indexOf('- Know before you speak.')
  expect(start).toBeGreaterThan(-1)
  const end = text.indexOf('\n- ', start + 1)
  return text.slice(start, end < 0 ? undefined : end)
}

const words = (s: string) => s.split(/\s+/).filter(Boolean).length

describe('the tool ladder', () => {
  it('main chat: check the thing itself; what is in front of it, tools, web, then its browser, then the person', () => {
    const md = read('chat-agent')
    const flat = knowBeforeYouSpeak(md).replace(/\s+/g, ' ')
    expect(flat).toContain('Check the thing itself (the thread with its later replies, the event, the record) before you call anything unanswered, late, done or urgent.')
    const order = ["what's in front of you", 'the workspace and connected apps', 'the web', 'your browser', 'then ask']
    const at = order.map((o) => flat.indexOf(o))
    expect(at.every((i) => i > -1), JSON.stringify(at)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    // The cloud browser answers on every surface (cloud browser C5).
    expect(flat).not.toContain('desktop only')
    // F2: a broken connection is offered back, still never routed around (its Connect card is `connect`'s note).
    expect(md.replace(/\s+/g, ' ')).toContain("- Never work around a broken connector with the browser: say it's broken and offer to reconnect.")
    // Quick helpers (A4 slice 3) are the helper roster's ("Models for helpers") to say, not the ladder's.
    expect(flat).not.toContain('`helpers`')
    expect(words(flat)).toBeLessThanOrEqual(60)
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
