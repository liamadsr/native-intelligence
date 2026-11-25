/**
 * The chat-agent's static instructions.md comes before every conversation's
 * own prompt, so its opening about who the model is must defer to a
 * teammate chat's (bots v2). Live on DEV it read "You are Native Intelligence's chat
 * assistant, driving the user's main in-app chat." unconditionally, and a
 * teammate asked "Who are you?" answered as Native Intelligence's chat assistant.
 *
 * Pins: no unconditional identity line; the deferral rule names the heading
 * the teammate persona section really opens with (TEAMMATE_IDENTITY_HEADING),
 * so renaming one without the other fails here; and the main chat's own
 * `## Who you are` block, when the user named their assistant (Interactive
 * mode, src/lib/ai/chat-system-prompt.ts assistantIdentityBlock), opens with
 * the same heading. Since the goal-driven rewrite
 * (docs/plans/goal-driven-main-agent.md §1) the opening is its "# Who you are"
 * section.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderTeammatePersonaSection, TEAMMATE_IDENTITY_HEADING } from '@/lib/chat/teammate-chat'

const instructions = readFileSync(join(__dirname, '../../instructions.md'), 'utf8')
/** The opening section, from its heading to the next one, on one line. */
const opening = instructions.slice(0, instructions.indexOf('\n# ', 1)).replace(/\s+/g, ' ')

describe('chat-agent instructions.md: who the model is', () => {
  it('opens with who you are, depending on the conversation, not with an unconditional identity', () => {
    expect(opening.startsWith('# Who you are In the person\'s main chat you are their always-on agent in Native Intelligence')).toBe(true)
    // The always-on framing, the same as the base prompt's opening (src/lib/ai/system-prompt.ts NI_IDENTITY), by the app's default name.
    expect(opening).toContain(`under the name they gave you ("Assistant" unless the \`${TEAMMATE_IDENTITY_HEADING}\` section names you otherwise)`)
    // No line anywhere states an identity on its own.
    expect(instructions.match(/^You are /gm)).toBeNull()
  })

  it('defers to the teammate section: there you are that teammate, in the first person, never Assistant or Native Intelligence', () => {
    // One agent (one-chat Slice 2): the one main agent; a persona drives only a live call.
    expect(opening).toContain('You are the one main agent for them and their team.')
    expect(opening).toContain(`In a teammate chat, the \`${TEAMMATE_IDENTITY_HEADING}\` section names that teammate: there you are it, in the first person, and never Assistant or Native Intelligence.`)
    expect(opening).toContain('On a live call, the live agent picked for that call speaks.')
    expect(opening).toContain('That section wins over anything else about who you are.')
    expect(opening).not.toContain('picked it as the agent')
    expect(opening).not.toContain('chat assistant')
  })

  it('a named assistant: the main chat goes by the name its `## Who you are` section gives', async () => {
    const { assistantIdentityBlock } = await import('@/lib/ai/chat-system-prompt')
    expect(assistantIdentityBlock('Joseph').startsWith(`${TEAMMATE_IDENTITY_HEADING}\nYour name is Joseph`)).toBe(true)
  })

  it('names the heading the teammate persona section really opens with', () => {
    for (const identity of [
      { name: 'Triage', isSystem: true, systemKey: 'triage' },
      { name: 'Ghostwriter', isSystem: false, systemKey: null },
    ]) {
      expect(renderTeammatePersonaSection(identity, null).startsWith(`${TEAMMATE_IDENTITY_HEADING}\n`), identity.name).toBe(true)
    }
  })

  it('names both reply markers the app writes (src/lib/chat/message-reply.ts), and what "this" points at', async () => {
    const { messageReplyNote } = await import('@/lib/chat/message-reply')
    const flat = instructions.replace(/\s+/g, ' ')
    const marker = (part: boolean, role: 'assistant' | 'user') => messageReplyNote({ messageId: 'm', role, quote: '…', part })
    expect(flat).toContain(`\`${marker(false, 'assistant')}\``)
    expect(flat).toContain(`\`${marker(true, 'assistant')}\``)
    expect(marker(false, 'user')).toContain('my own earlier message')
    expect(flat).toContain('(or "my own earlier message") answers exactly those words: "this", "that" and "it" point there; don\'t ask which.')
  })

  it('a post goes out only by their click or a card, and its playbook loads first', () => {
    expect(instructions).toContain('A post to their social accounts goes out only by their own click or an approval card; before writing one, `load_skill` `content-playbook`.')
  })

  it('names the focus heading the prompt really carries (src/lib/packs/focus.ts)', async () => {
    const { FOCUS_HEADING } = await import('@/lib/packs/focus')
    expect(instructions).toContain(`"${FOCUS_HEADING.replace(/^## /, '')}", when present`)
  })
})
