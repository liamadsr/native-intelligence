import { describe, expect, it } from 'vitest'
import { vocabularyLogLines } from '../log'

const ready = { ready: true, terms: 2431, version: 'abc', workspaceId: 'aa5dc58b-c0cf', problem: null }

describe('vocabularyLogLines', () => {
  it('says what was heard, written, fixed and nearly fixed', () => {
    const lines = vocabularyLogLines({
      state: ready,
      heard: 'the APAM team and the api am team',
      wrote: 'the APIM team and the api am team',
      corrections: [{ kind: 'sound', from: 'APAM', to: 'APIM', output: 'APIM', index: 1, length: 1, score: 0.9 }],
      nearMisses: [{ from: 'api am', to: 'APIM', score: 0.87, reason: 'ordinary words', index: 6 }],
    })
    expect(lines).toEqual([
      'vocab ready: 2431 terms (vabc), workspace aa5dc58b',
      'vocab heard: the APAM team and the api am team',
      'vocab wrote: the APIM team and the api am team',
      'vocab fixed: "APAM" → APIM (sound 0.90)',
      'vocab near: "api am" → APIM 0.87, left alone (ordinary words)',
    ])
  })

  it('says why nothing was corrected when there is no word list', () => {
    const lines = vocabularyLogLines({
      state: { ready: false, terms: 0, version: null, workspaceId: null, problem: 'the server answered 500' },
      heard: 'hello',
      wrote: 'hello',
      corrections: [],
      nearMisses: [],
    })
    expect(lines).toEqual(['vocab off: the server answered 500', 'vocab heard: hello'])
  })

  it('splits long text so every line fits the desktop log', () => {
    const long = 'word '.repeat(200).trim()
    const lines = vocabularyLogLines({ state: ready, heard: long, wrote: long, corrections: [], nearMisses: [] })
    expect(lines.filter((l) => l.startsWith('vocab heard')).length).toBe(4)
    expect(lines.every((l) => l.length <= 400)).toBe(true)
    expect(lines.at(-1)).toBe('vocab: nothing close to a term')
  })
})
