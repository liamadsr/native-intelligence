/** Read-along's word as shown (../read-along): clean of the punctuation round it, nothing that's part of it lost. */
import { describe, expect, it } from 'vitest'
import { cleanWord } from '../read-along'

describe('cleanWord', () => {
  it('drops the punctuation round a word', () => {
    expect(['Hello,', '"quoted"', '(aside)', 'end.', 'really?!', '**bold**', '“curly”', 'list:'].map(cleanWord)).toEqual([
      'Hello',
      'quoted',
      'aside',
      'end',
      'really',
      'bold',
      'curly',
      'list',
    ])
  })
  it("keeps what's part of the word", () => {
    expect(["don't", 'well-known', '3.5', '$40,', '20%.', 'U.S.', 'dial8.ai'].map(cleanWord)).toEqual([
      "don't",
      'well-known',
      '3.5',
      '$40',
      '20%',
      'U.S.',
      'dial8.ai',
    ])
  })
  it('shows nothing for punctuation alone', () => {
    expect([',', '—', '...'].map(cleanWord)).toEqual(['', '', ''])
  })
})
