import { afterEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({ ws: 'ws-a' as string | null }))
vi.mock('@/lib/workspace-fetch', () => ({ getClientWorkspaceId: () => hoisted.ws }))
import { LEXICON_WORDS } from '../lexicon-words'
import { SoundMatchCorrector } from '../sound-match'
import { __resetVocabularyForTests, correctFinalSegment, correctTranscriptText } from '../client'
import { dispatchDeepgramMessage, type TranscriptSegment } from '@/lib/deepgram-stream'

const lexicon = new Set(LEXICON_WORDS.split('\n').filter(Boolean))
const use = (terms: string[], workspaceId = 'ws-a') => __resetVocabularyForTests(new SoundMatchCorrector(terms.map((term) => ({ term })), lexicon), workspaceId)
const w = (word: string, start: number) => ({ word, start, end: start + 0.3, confidence: 0.9, speaker: 1 })

afterEach(() => {
  __resetVocabularyForTests(null)
  hoisted.ws = 'ws-a'
})

describe('correctFinalSegment', () => {
  it('passes everything through until the vocabulary has loaded', () => {
    const seg = { text: 'Check the Superbase logs', isFinal: true, words: [] }
    expect(correctFinalSegment(seg)).toBe(seg)
    expect(correctTranscriptText('Check the Superbase logs')).toBe('Check the Superbase logs')
  })

  it('rewrites the text and merges the words of a multi-word span', () => {
    use(['PostHog', 'Supabase'])
    const seg = {
      text: 'Open post hog and Superbase.',
      isFinal: true,
      words: [w('open', 0), w('post', 1), w('hog', 2), w('and', 3), w('superbase', 4)],
    }
    const out = correctFinalSegment(seg)
    expect(out.text).toBe('Open PostHog and Supabase.')
    expect(out.words.map((x) => [x.word, x.start, x.end])).toEqual([['open', 0, 0.3], ['posthog', 1, 2.3], ['and', 3, 3.3], ['supabase', 4, 4.3]])
  })

  it('keeps the word list when it does not line up with the text', () => {
    use(['Supabase'])
    const words = [w('superbase', 0)]
    const out = correctFinalSegment({ text: 'Superbase, right.', isFinal: true, words: [...words, w('right', 1), w('extra', 2)] })
    expect(out.text).toBe('Supabase, right.')
    expect(out.words).toHaveLength(3)
  })

  it("never corrects with another workspace's words after a switch", () => {
    use(['Supabase'], 'ws-a')
    // Stub the refetch the switch triggers.
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 500 })) as unknown as typeof fetch
    hoisted.ws = 'ws-b'
    const seg = { text: 'Check the Superbase logs', isFinal: true, words: [] }
    expect(correctFinalSegment(seg)).toBe(seg)
    expect(correctTranscriptText('Check the Superbase logs')).toBe('Check the Superbase logs')
    // The old workspace's corrector was dropped: nothing is corrected until a fresh compile loads.
    hoisted.ws = 'ws-a'
    expect(correctTranscriptText('Check the Superbase logs')).toBe('Check the Superbase logs')
  })

  it('leaves interims alone', () => {
    use(['Supabase'])
    const seg = { text: 'Superbase', isFinal: false, words: [] }
    expect(correctFinalSegment(seg)).toBe(seg)
  })
})

describe('the transcript dispatcher (both engines)', () => {
  const results = (transcript: string, isFinal: boolean) => ({
    type: 'Results',
    is_final: isFinal,
    start: 0,
    duration: 1,
    channel: { alternatives: [{ transcript, words: transcript.split(' ').map((t, i) => ({ word: t.toLowerCase(), start: i, end: i + 0.5, confidence: 1 })) }] },
  })

  it('hands downstream the corrected final, and the interim as heard', () => {
    use(['Supabase'])
    const seen: TranscriptSegment[] = []
    const finals: TranscriptSegment[] = []
    let n = 0
    const next = () => `s${n++}`
    dispatchDeepgramMessage(results('Check Superbase', false), 'mic', next, { onSegment: (s) => seen.push(s) })
    dispatchDeepgramMessage(results('Check Superbase now', true), 'mic', next, { onSegment: (s) => seen.push(s), onFinalSegment: (s) => finals.push(s) })
    expect(seen.map((s) => s.text)).toEqual(['Check Superbase', 'Check Supabase now'])
    expect(finals.map((s) => s.text)).toEqual(['Check Supabase now'])
  })
})
