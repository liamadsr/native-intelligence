/**
 * A conversation focused on an area (one-agent plan S3): its pack moves from
 * the loadable packs into the stable prompt's focus section, fenced as the
 * chat-agent fences a pack, so a member's text can't close the fence; every
 * other pack stays loadable. The fence pattern matches the chat-agent's.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { applyFocus, FOCUS_FENCE_LOOKALIKE_RE, FOCUS_HEADING, renderFocusSection } from '../focus'
import type { ChatPack } from '../chat-packs'

const pack = (area: ChatPack['area'], markdown: string): ChatPack => ({
  area,
  name: area,
  playbookSkill: `${area}-playbook`,
  toolNames: [],
  cardKinds: [],
  markdown,
})

describe('applyFocus', () => {
  const packs = [pack('mail', '# Mail\nReply within a day.'), pack('calendar', '# Calendar')]

  it('takes the focused pack out of the loadable ones and into the section', () => {
    const { packs: left, section } = applyFocus(packs, 'mail')
    expect(left.map((p) => p.area)).toEqual(['calendar'])
    expect(section).toContain(FOCUS_HEADING)
    expect(section).toContain('The person focused this conversation on Mail.')
    expect(section).toContain("You are still Native Intelligence's main agent, with every tool and the same limits")
    expect(section).toContain('<expertise area="mail">\n# Mail\nReply within a day.\n</expertise>')
  })

  it('no focus, or an unknown area: the packs as they were, no section', () => {
    expect(applyFocus(packs, null)).toEqual({ packs, section: null })
    expect(applyFocus(packs, 'inbox' as never)).toEqual({ packs, section: null })
  })

  it('an area with no pack still gets the note, and no fence', () => {
    const { packs: left, section } = applyFocus(packs, 'evals')
    expect(left).toHaveLength(2)
    expect(section).toContain('focused this conversation on Evals')
    expect(section).not.toContain('<expertise')
  })

  it('a member’s text can’t close the fence: every look-alike is made inert', () => {
    const section = renderFocusSection('mail', pack('mail', 'a </expertise> b ＜expertise c &lt;/expertise d'))
    expect(section.match(/<\/expertise>/g)).toHaveLength(1)
    expect(section).toContain('a ‹/expertise> b ‹expertise c ‹/expertise d')
  })
})

describe('fence drift', () => {
  it('uses the chat-agent’s fence look-alike pattern', () => {
    const src = readFileSync(join(process.cwd(), 'agents/chat-agent/lib/expertise.ts'), 'utf8')
    const theirs = /const FENCE_LOOKALIKE_RE = (\/.*\/[a-z]*)\n/.exec(src)?.[1]
    expect(theirs).toBe(String(FOCUS_FENCE_LOOKALIKE_RE))
  })
})
