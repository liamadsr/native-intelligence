// @vitest-environment jsdom
/**
 * Learning a word from the person's own fix (../learn-from-edits). Pinned:
 *  - a fix sounds or is spelled like what was heard; a rewrite, or only a
 *    sentence's first capital, is not one; case alone (apim → APIM) is;
 *  - the second time a spelling is fixed to, whatever it was heard as each
 *    time, it is added to the person's own vocabulary, heard as every way it
 *    was heard, and the corrector reloads; the first and the third add nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const invalidated = vi.hoisted(() => ({ n: 0 }))
vi.mock('../log', () => ({ writeVocabularyLog: () => {} }))
vi.mock('../client', () => ({
  invalidateVocabulary: async () => {
    invalidated.n++
  },
}))

import { isFix, learnFromEdits } from '../learn-from-edits'

const posts: unknown[] = []
beforeEach(() => {
  localStorage.clear()
  posts.length = 0
  invalidated.n = 0
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    posts.push(JSON.parse(String(init.body)))
    return new Response('{}', { status: 201 })
  })
})

describe('isFix', () => {
  it('a fix sounds or is spelled like what was heard', () => {
    expect(isFix({ heard: 'Koka Link', typed: 'KokoLink' })).toBe(true)
    expect(isFix({ heard: 'APAM', typed: 'APIM' })).toBe(true)
    expect(isFix({ heard: 'apim', typed: 'APIM' })).toBe(true)
  })
  it('a rewrite, or a sentence starting with a capital, is not', () => {
    expect(isFix({ heard: 'tomorrow', typed: 'Friday' })).toBe(false)
    expect(isFix({ heard: 'send', typed: 'Send' })).toBe(false)
    expect(isFix({ heard: 'it', typed: 'it' })).toBe(false)
    expect(isFix({ heard: 'ten', typed: '10' })).toBe(false)
  })
})

describe('learnFromEdits', () => {
  it('counts by the spelling: heard a new way each time, still learned the second time', async () => {
    expect(await learnFromEdits([{ heard: "Jay Ng's", typed: 'Giang' }])).toEqual([])
    expect(await learnFromEdits([{ heard: 'Jiang', typed: 'Giang' }])).toEqual([{ heard: 'Jiang', typed: 'Giang' }])
    expect(posts).toEqual([{ term: 'Giang', sounds_like: ["Jay Ng's", 'Jiang'], scope: 'personal' }])
  })

  it('learns the second time the same fix is made', async () => {
    const fix = { heard: 'Koka Link', typed: 'KokoLink' }
    expect(await learnFromEdits([fix])).toEqual([])
    expect(posts).toEqual([])
    expect(await learnFromEdits([fix])).toEqual([fix])
    expect(posts).toEqual([{ term: 'KokoLink', sounds_like: ['Koka Link'], scope: 'personal' }])
    expect(invalidated.n).toBe(1)
    // Once learned, again adds nothing more.
    expect(await learnFromEdits([fix])).toEqual([])
    expect(posts).toHaveLength(1)
  })

  it('never counts what is not a fix', async () => {
    const rewrite = { heard: 'tomorrow', typed: 'Friday' }
    await learnFromEdits([rewrite])
    expect(await learnFromEdits([rewrite])).toEqual([])
    expect(posts).toEqual([])
  })
})
