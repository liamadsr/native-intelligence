/**
 * Voice mode's turn note (voice-mode-prompt.ts): only a turn voice mode sent
 * gets it, and it asks for a reply written to be heard.
 */
import { describe, expect, it } from 'vitest'
import { isVoiceModeTurn, renderVoiceModeSection } from '../voice-mode-prompt'

describe('isVoiceModeTurn', () => {
  it('is true only for an explicit true', () => {
    expect(isVoiceModeTurn({ voiceMode: true })).toBe(true)
    expect(isVoiceModeTurn({ voiceMode: 'true' })).toBe(false)
    expect(isVoiceModeTurn({ voiceMode: 1 })).toBe(false)
    expect(isVoiceModeTurn({})).toBe(false)
    expect(isVoiceModeTurn(null)).toBe(false)
    expect(isVoiceModeTurn(undefined)).toBe(false)
  })
})

describe('renderVoiceModeSection', () => {
  const note = renderVoiceModeSection('Joseph')

  it('says the reply is read aloud, as the assistant', () => {
    expect(note.startsWith('## Voice conversation (spoken)\n')).toBe(true)
    expect(note).toContain('everything you write back is read aloud to them as Joseph')
  })

  it('asks for short, plain, spoken sentences', () => {
    expect(note).toContain('usually one to three sentences')
    expect(note).toContain('give the gist and offer to go deeper')
    expect(note).toContain('no headings, bullet points, numbered lists, tables, links, code, emoji or ids read out')
    expect(note).toContain('the way people say them')
  })

  it('invites a natural filler now and then, never every sentence', () => {
    expect(note).toContain('"um", "oh", "hmm"')
    expect(note).toContain('Sparingly, never in every sentence')
  })

  it('keeps tools and cards working, said briefly', () => {
    expect(note).toContain("I've put it on screen")
  })
})
