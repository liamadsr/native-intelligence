/**
 * Persona composition parity (B PR 4): a work run done by a teammate carries
 * the SAME persona and skills sections a coding run does — composed by the same
 * function — after the run-as user's base prompt. A run with no teammate keeps
 * the base prompt alone, exactly as before.
 */
import { describe, it, expect } from 'vitest'
import { composeEveCodingSystemPrompt, composeWorkRunSystemPrompt, type AgentPersona } from '../agent-run-context'

const persona: AgentPersona = {
  name: 'Quill',
  agentSystemPrompt: '  You write crisp, friendly notes.  ',
  agentConfig: null,
  skills: [
    { name: 'Tone', description: 'unused when a prompt exists', system_prompt: 'Plain words, short sentences.' },
    { name: 'Summaries', description: 'Summarise meetings in five bullets.', system_prompt: null },
    { name: 'Empty', description: null, system_prompt: '   ' },
  ],
}

describe('composeWorkRunSystemPrompt', () => {
  it('appends exactly the persona sections a coding run carries', () => {
    const work = composeWorkRunSystemPrompt('BASE PROMPT', persona)
    expect(work.startsWith('BASE PROMPT\n\n')).toBe(true)
    const personaPart = work.slice('BASE PROMPT\n\n'.length)
    const coding = composeEveCodingSystemPrompt(persona, { baseBranch: 'main', branchName: 'dial8/x' })
    expect(coding.endsWith(`\n\n${personaPart}`)).toBe(true)
    expect(personaPart).toContain('## Your role: Quill')
    expect(personaPart).toContain('You write crisp, friendly notes.')
    expect(personaPart).toContain('### Tone\nPlain words, short sentences.')
    expect(personaPart).toContain('### Summaries\nSummarise meetings in five bullets.')
    expect(personaPart).not.toContain('Empty')
  })

  it('no teammate: the base prompt alone', () => {
    expect(composeWorkRunSystemPrompt('BASE PROMPT', null)).toBe('BASE PROMPT')
  })
})
