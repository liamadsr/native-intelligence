import { describe, expect, it } from 'vitest'
import { removeFillers } from '../fillers'

describe('removeFillers', () => {
  it('takes out the sounds that are never words, with their commas', () => {
    expect(removeFillers('So, um, we should ship it')).toBe('So, we should ship it')
    expect(removeFillers('I think uh the APIM team')).toBe('I think the APIM team')
    expect(removeFillers('Um, so we need to talk')).toBe('So we need to talk')
    expect(removeFillers('we went there uh.')).toBe('we went there.')
    expect(removeFillers('is that right, um?')).toBe('is that right?')
    expect(removeFillers('Ummm, hmm, okay. Erm, next')).toBe('Okay. Next')
  })

  it('leaves words alone, and answers like uh-huh', () => {
    expect(removeFillers('I like it, you know, I mean it')).toBe('I like it, you know, I mean it')
    expect(removeFillers('uh-huh, sounds good')).toBe('uh-huh, sounds good')
    expect(removeFillers('the umbrella and the hummus')).toBe('the umbrella and the hummus')
    expect(removeFillers('Ahmed and Erma')).toBe('Ahmed and Erma')
  })

  it('returns the same text when there is nothing to remove', () => {
    const text = 'Nothing  to   remove here.'
    expect(removeFillers(text)).toBe(text)
  })
})
