/**
 * Judging and making sounds, the pure parts: a judgement's answer made compact (sound-contract.ts judgeResultFrom,
 * which both the worker and the app use), the forge's scores and a fit's quality, how many sounds each judgement
 * takes, and the recipe a kind or a description picks (sound-judge.ts). Made-up material only.
 */
import { describe, expect, it } from 'vitest'
import { fitQualityFrom, forgeScoreFrom, FORGE_RECIPES, judgedRef, judgeResultFrom, soundMeasuresFrom } from '../sound-contract'
import { checkJudgeCounts, pickRecipe } from '../sound-judge'

const SHA = 'a'.repeat(64)

describe('a judgement made compact', () => {
  it('keeps numbers and short words, rounds them, and drops everything else', () => {
    const out = judgeResultFrom(
      {
        summary: 'x'.repeat(2000),
        measures: { seconds: 0.25, lufs: '-14.04', truePeakDb: -1, rmsDb: 'loud', samples: [1, 2, 3] },
        tags: [{ term: 'a cork pop', category: 'foley', z: 4.104 }, { term: 'no z' }, ...Array.from({ length: 10 }, (_, i) => ({ term: `t${i}`, z: 1 }))],
        labels: [{ label: 'Plop', p: 0.4444 }],
        match: { description: 'a small bubble pop', z: 3.556, verdict: 'strong', pVsAlts: null, soundsLike: ['a cork pop'] },
        ranked: [{ name: 'Made-up pop.wav', assetId: SHA, z: 3.14159, path: '/scratch/in-01.wav' }, { name: 'pop/2', sound: 'pop/2', cosine: 0.12345 }],
        realness: [{ name: 'pop/2', sound: 'pop/2', pReal: 'n/a', verdict: 'uncertain' }],
        ab: { a: 'A.wav', b: 'B.wav', closer: 'c', zA: 4.26, zB: 4.73 },
        embedding: [0.1, 0.2],
      },
      'describe',
    )
    expect(out.summary).toHaveLength(1500)
    expect(out.measures).toEqual({ seconds: 0.25, lufs: -14, truePeakDb: -1 })
    expect(out.tags).toHaveLength(7) // the first eight, less the one with no z
    expect(out.tags![0]).toEqual({ term: 'a cork pop', category: 'foley', z: 4.1 })
    expect(out.labels).toEqual([{ label: 'Plop', p: 0.444 }])
    expect(out.match).toEqual({ description: 'a small bubble pop', z: 3.56, verdict: 'strong', soundsLike: ['a cork pop'] })
    expect(out.ranked).toEqual([{ name: 'Made-up pop.wav', assetId: SHA, z: 3.14 }, { name: 'pop/2', sound: 'pop/2', cosine: 0.123 }])
    expect(out.realness).toEqual([{ name: 'pop/2', sound: 'pop/2', pReal: null, verdict: 'uncertain' }])
    expect(out.ab).toEqual({ a: 'A.wav', b: 'B.wav', closer: null, zA: 4.26, zB: 4.73 })
    expect(JSON.stringify(out)).not.toMatch(/scratch|embedding|samples/)
  })

  it('answers an empty judgement from anything that is not one', () => {
    expect(judgeResultFrom(null, 'measure')).toEqual({ action: 'measure', summary: '' })
    expect(judgeResultFrom([1, 2], 'rank')).toEqual({ action: 'rank', summary: '' })
  })

  it('names a sound by what it is, never by a path', () => {
    expect(judgedRef({ name: 'Made-up.wav', assetId: 'not-a-sha', sound: '../x' })).toEqual({ name: 'Made-up.wav' })
    expect(judgedRef({ sound: 'whoosh_fast/crisp' })).toEqual({ name: 'whoosh_fast/crisp', sound: 'whoosh_fast/crisp' })
    expect(soundMeasuresFrom({ onsets: 2.4, clippedSamples: 0 })).toEqual({ onsets: 2, clippedSamples: 0 })
  })

  it('keeps the forge scores and the fit quality as numbers', () => {
    expect(forgeScoreFrom({ total: 2.8812, passes: false, matchZ: 3.704, pReal: 0.9621, soundsLike: ['a mouth pop', 7], words: 'total 2.88', history: [1] })).toEqual({
      total: 2.881, passes: false, matchZ: 3.7, pReal: 0.962, soundsLike: ['a mouth pop'], words: 'total 2.88',
    })
    expect(fitQualityFrom({ melDb: 1.537, envCorr: 1, seconds: [0.6, 0.6], fitKind: 'modal', model: { big: true } })).toEqual({ melDb: 1.54, envCorr: 1, seconds: [0.6, 0.6], fitKind: 'modal' })
    expect(fitQualityFrom({ seconds: [0.6] })).toEqual({})
  })
})

describe('what each judgement takes', () => {
  const ok = (action: Parameters<typeof checkJudgeCounts>[0], count: number, extra = {}) => () => checkJudgeCounts(action, count, extra)
  it('refuses with a sentence when given too few or too many sounds', () => {
    expect(ok('describe', 1)).not.toThrow()
    expect(ok('describe', 2)).toThrow(/hears one sound/)
    expect(ok('measure', 0)).toThrow(/hears one sound/)
    expect(ok('compare', 2)).toThrow(/two or more references/)
    expect(ok('compare', 3)).not.toThrow()
    expect(ok('rank', 3)).toThrow(/description or a target/)
    expect(ok('rank', 3, { description: 'a pop' })).not.toThrow()
    expect(ok('find', 0)).toThrow(/needs a description/)
    expect(ok('find', 0, { description: 'a pop' })).not.toThrow()
    expect(ok('find', 2, { description: 'a pop' })).toThrow(/inside one sound/)
    expect(ok('ab', 2)).not.toThrow()
    expect(ok('ab', 3)).toThrow(/A then B/)
    expect(ok('ab', 4)).not.toThrow()
    expect(ok('realness', 13)).toThrow(/at most 12/)
  })
})

describe('the recipe a forge uses', () => {
  it('takes a recipe or a kit role as given, else the one the description names', () => {
    expect(pickRecipe('whoosh.short', 'anything')).toBe('whoosh')
    expect(pickRecipe('hit', 'anything')).toBe('cuthit')
    expect(pickRecipe('NOTIFY', 'anything')).toBe('notify')
    expect(pickRecipe('banjo', 'a banjo')).toBeNull()
    expect(pickRecipe(undefined, 'a camera shutter for a screenshot')).toBe('shutter')
    expect(pickRecipe(undefined, 'a deep cinematic boom')).toBe('impact')
    expect(pickRecipe(undefined, 'a reverse cymbal swell into the logo')).toBe('revcymbal')
    expect(pickRecipe(undefined, 'qwerty zzz')).toBeNull()
    for (const recipe of Object.keys(FORGE_RECIPES)) expect(pickRecipe(recipe, ''), recipe).toBe(recipe)
  })
})
