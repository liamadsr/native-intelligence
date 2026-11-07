import { describe, expect, it } from 'vitest'
import { finishSentence } from '../punctuation'

describe('finishSentence', () => {
  it('ends a finished sentence with a full stop', () => {
    expect(finishSentence('We shipped the update yesterday')).toBe('We shipped the update yesterday.')
    expect(finishSentence('Thanks, Liam and the APIM team')).toBe('Thanks, Liam and the APIM team.')
  })

  it('leaves punctuation, short replies and unfinished sentences alone', () => {
    expect(finishSentence('Can you send it by Friday?')).toBe('Can you send it by Friday?')
    expect(finishSentence('It works.')).toBe('It works.')
    expect(finishSentence('No')).toBe('No')
    expect(finishSentence('Sounds good')).toBe('Sounds good')
    expect(finishSentence('I want to talk to')).toBe('I want to talk to')
    expect(finishSentence('send it to the')).toBe('send it to the')
  })
})
