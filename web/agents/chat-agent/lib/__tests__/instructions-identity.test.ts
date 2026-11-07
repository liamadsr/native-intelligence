/**
 * The chat-agent's static instructions.md comes before every conversation's
 * own prompt, so its opening line about who the model is must defer to a
 * teammate chat's (bots v2). Live on DEV it read "You are Dial8's chat
 * assistant, driving the user's main in-app chat." unconditionally, and a
 * teammate asked "Who are you?" answered as Dial8's chat assistant.
 *
 * Pins: no unconditional identity line; the deferral rule names the heading
 * the teammate persona section really opens with (TEAMMATE_IDENTITY_HEADING),
 * so renaming one without the other fails here; and the main chat's own
 * `## Who you are` block, when the user named their assistant (Interactive
 * mode, src/lib/ai/chat-system-prompt.ts assistantIdentityBlock), opens with
 * the same heading.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderTeammatePersonaSection, TEAMMATE_IDENTITY_HEADING } from '@/lib/chat/teammate-chat'

const instructions = readFileSync(join(__dirname, '../../instructions.md'), 'utf8')
/** The opening paragraph, on one line. */
const opening = instructions.slice(0, instructions.indexOf('\n\n')).replace(/\s+/g, ' ')

describe('chat-agent instructions.md: who the model is', () => {
  it('opens by making it depend on the conversation, not with an unconditional identity', () => {
    expect(opening.startsWith('Who you are depends on the conversation.')).toBe(true)
    // The always-on framing, the same as the base prompt's opening (src/lib/ai/system-prompt.ts DIAL8_IDENTITY).
    expect(opening).toContain("In the user's main in-app chat you are their always-on agent, under the name they gave you in Settings → Preferences (\"Assistant\" by default; Dial8 is the product):")
    // No line anywhere states an identity on its own.
    expect(instructions.match(/^You are /gm)).toBeNull()
  })

  it('defers to the teammate section: you ARE that teammate, by its name, never Dial8', () => {
    expect(opening).toContain(`carries a \`${TEAMMATE_IDENTITY_HEADING}\` section naming that teammate`)
    // One agent (one-chat Slice 2): a teammate chat is its own window, never the main chat; a persona drives only a live call.
    expect(opening).toContain('the one main agent for them and their team, and no custom agent or other teammate takes your place there.')
    expect(opening).toContain('one of the user\'s AI teammates, in its own small window, and its system prompt')
    expect(opening).not.toContain('picked it as the agent')
    expect(opening).toContain('On a live call, the call\'s own conversation runs as the live agent picked for that call')
    expect(opening).toContain('you ARE that teammate: use its name, speak in the first person as it')
    expect(opening).toContain('when asked who you are or what your name is, answer as it')
    expect(opening).toContain('Never call yourself Assistant, Dial8 or their always-on agent there.')
    expect(opening).not.toContain("chat assistant")
    expect(opening).toContain('That section wins over every other line about who you are')
  })

  it('a named assistant: the main chat goes by the name its `## Who you are` section gives', async () => {
    expect(opening).toContain(
      `When they named you, the main chat's system prompt carries a \`${TEAMMATE_IDENTITY_HEADING}\` section giving that name, and you go by it there, as their assistant.`,
    )
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
})
