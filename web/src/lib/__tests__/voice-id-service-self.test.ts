import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Tests for VoiceIdService's live self-verification grant machine
 * (src/lib/voice-id-service.ts) — the PROVISIONAL-grant contract (finding 1)
 * and self-contact exclusion from bestContactSim (finding 3).
 *
 * The client grant is provisional: onSelfVerified fires, but the latch only
 * becomes permanent when the caller calls confirmSelfGrant() after the server
 * confirms. On a failed/rejected POST the caller calls resetSelfGrant(), which
 * un-grants the vote state so a LATER qualifying window re-fires (with a
 * cooldown). Without this, one transient POST failure permanently loses the
 * binding — the vote machine latches `granted` and never re-fires.
 *
 * evaluateSelf is private (it normally runs off a worker match response); these
 * tests drive it directly via a cast, which is the only way to exercise the
 * grant/reset transitions without a Web Worker + audio pipeline.
 */

import { VoiceIdService } from '@/lib/voice-id-service'
import { l2Normalize } from '@/lib/voice-id-matching'
import { EMBEDDING_DIM, MAX_SELF_TOPUP_EMBEDDINGS, SELF_VERIFY_THRESHOLD } from '@/lib/voice-profile/types'

/** A unit-norm basis embedding: 1 at index k, 0 elsewhere. */
function basis(k: number): number[] {
  const v = new Array(EMBEDDING_DIM).fill(0)
  v[k] = 1
  return l2Normalize(v)
}

type Candidate = { contactId: string; contactName: string; similarity: number }

/** Reach the private evaluateSelf + private fields through a cast. */
interface Internals {
  selfPrototypes: number[][] | null
  selfContactIds: Set<string>
  evaluateSelf(speakerId: string, embedding: number[], candidates: Candidate[]): void
}

function internals(svc: VoiceIdService): Internals {
  return svc as unknown as Internals
}

/** A service with a single self prototype = basis(0). */
function serviceWithSelfProfile(): VoiceIdService {
  const svc = new VoiceIdService()
  internals(svc).selfPrototypes = [basis(0)]
  return svc
}

describe('VoiceIdService self grant — provisional latch (finding 1)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('fires onSelfVerified once after 2 qualifying votes', () => {
    const svc = serviceWithSelfProfile()
    const fired: string[] = []
    svc.onSelfVerified = (speakerId) => { fired.push(speakerId) }

    // basis(0) matches the prototype at cosine 1.0 → qualifies. Empty
    // candidates → bestContactSim 0 → plain threshold.
    internals(svc).evaluateSelf('local_1', basis(0), [])
    expect(fired.length).toBe(0) // 1 vote is not enough
    internals(svc).evaluateSelf('local_1', basis(0), [])
    expect(fired).toEqual(['local_1'])

    // A third qualifying vote does NOT re-fire (still provisionally latched).
    internals(svc).evaluateSelf('local_1', basis(0), [])
    expect(fired).toEqual(['local_1'])
  })

  it('re-fires after resetSelfGrant() (a failed POST does NOT lose the binding)', () => {
    const svc = serviceWithSelfProfile()
    const fired: string[] = []
    svc.onSelfVerified = (speakerId) => { fired.push(speakerId) }

    internals(svc).evaluateSelf('local_1', basis(0), [])
    internals(svc).evaluateSelf('local_1', basis(0), [])
    expect(fired.length).toBe(1)

    // Server POST failed → release the provisional grant.
    svc.resetSelfGrant()

    // Cooldown suppresses an immediate re-fire (would spam a failing server).
    internals(svc).evaluateSelf('local_1', basis(0), [])
    internals(svc).evaluateSelf('local_1', basis(0), [])
    expect(fired.length).toBe(1) // still 1 — cooldown not elapsed

    // After the cooldown a fresh qualifying window re-fires the grant.
    vi.advanceTimersByTime(11_000)
    internals(svc).evaluateSelf('local_1', basis(0), [])
    internals(svc).evaluateSelf('local_1', basis(0), [])
    expect(fired.length).toBe(2)
    expect(fired[1]).toBe('local_1')
  })

  it('confirmSelfGrant() makes the latch permanent (no re-fire even after resets)', () => {
    const svc = serviceWithSelfProfile()
    const fired: string[] = []
    svc.onSelfVerified = (speakerId) => { fired.push(speakerId) }

    internals(svc).evaluateSelf('local_1', basis(0), [])
    internals(svc).evaluateSelf('local_1', basis(0), [])
    expect(fired.length).toBe(1)

    // Server confirmed — permanent latch.
    svc.confirmSelfGrant()

    // Even far in the future, more qualifying votes never re-fire.
    vi.advanceTimersByTime(60_000)
    internals(svc).evaluateSelf('local_1', basis(0), [])
    internals(svc).evaluateSelf('local_1', basis(0), [])
    expect(fired.length).toBe(1)
  })
})

describe('VoiceIdService self grant — bestContactSim excludes own contacts (finding 3)', () => {
  it('grants for a user enrolled as their own contact (own contact ignored)', () => {
    const svc = serviceWithSelfProfile()
    internals(svc).selfContactIds = new Set(['self-contact'])
    const fired: string[] = []
    svc.onSelfVerified = (speakerId) => { fired.push(speakerId) }

    // The top candidate is the caller's OWN contact at high similarity — it must
    // be excluded from bestContactSim, otherwise the self-margin fails forever.
    const candidates: Candidate[] = [
      { contactId: 'self-contact', contactName: 'Me', similarity: 0.99 },
    ]
    internals(svc).evaluateSelf('local_1', basis(0), candidates)
    internals(svc).evaluateSelf('local_1', basis(0), candidates)
    expect(fired).toEqual(['local_1'])
  })

  it('does NOT grant when a DIFFERENT contact competes within the margin', () => {
    const svc = serviceWithSelfProfile()
    internals(svc).selfContactIds = new Set(['self-contact'])
    const fired: string[] = []
    svc.onSelfVerified = (speakerId) => { fired.push(speakerId) }

    // A real other contact scores near the self similarity → margin fails, no grant.
    const candidates: Candidate[] = [
      { contactId: 'other', contactName: 'Someone', similarity: SELF_VERIFY_THRESHOLD + 0.19 },
      { contactId: 'self-contact', contactName: 'Me', similarity: 0.5 },
    ]
    // selfSim is 1.0 (basis(0) vs prototype basis(0)); other at 0.99 → margin 0.01 < 0.03.
    internals(svc).evaluateSelf('local_1', basis(0), candidates)
    internals(svc).evaluateSelf('local_1', basis(0), candidates)
    expect(fired.length).toBe(0)
  })
})

/** Unit vector at cosine `c` to basis(0) (the self prototype). */
function closeTo(c: number): number[] {
  const v = new Array(EMBEDDING_DIM).fill(0)
  v[0] = c
  v[1] = Math.sqrt(1 - c * c)
  return v
}

interface ConfirmInternals {
  votingComplete: Set<string>
  resolvedSpeakers: Map<string, unknown>
  sessionEmbeddings: Map<string, number[][]>
}
const confirmInternals = (svc: VoiceIdService) => svc as unknown as ConfirmInternals

describe('VoiceIdService "Is this you?" and "This is me" (followups issue 11)', () => {
  it('suggests a voice close to the user’s but under the grant bar, once per label', () => {
    const svc = serviceWithSelfProfile()
    const suggested: Array<[string, number]> = []
    const granted: string[] = []
    svc.onSelfSuggested = (id, sim) => { suggested.push([id, sim]) }
    svc.onSelfVerified = (id) => { granted.push(id) }
    internals(svc).evaluateSelf('local_2', closeTo(0.74), [])
    internals(svc).evaluateSelf('local_2', closeTo(0.75), [])
    internals(svc).evaluateSelf('local_2', closeTo(0.76), [])
    expect(granted).toEqual([])
    expect(suggested.map(([id]) => id)).toEqual(['local_2'])
    expect(suggested[0][1]).toBeCloseTo(0.75, 5)
  })

  it('never suggests once the user’s voice is granted this session, nor a label they said is not them', () => {
    const svc = serviceWithSelfProfile()
    const suggested: string[] = []
    svc.onSelfSuggested = (id) => { suggested.push(id) }
    svc.onSelfVerified = () => {}
    internals(svc).evaluateSelf('local_1', basis(0), [])
    internals(svc).evaluateSelf('local_1', basis(0), []) // granted
    internals(svc).evaluateSelf('local_2', closeTo(0.75), [])
    internals(svc).evaluateSelf('local_2', closeTo(0.75), [])
    expect(suggested).toEqual([])

    const other = serviceWithSelfProfile()
    const more: string[] = []
    other.onSelfSuggested = (id) => { more.push(id) }
    other.dismissSelfSuggestion('local_3')
    internals(other).evaluateSelf('local_3', closeTo(0.75), [])
    internals(other).evaluateSelf('local_3', closeTo(0.75), [])
    expect(more).toEqual([])
  })

  it('confirmSelfLabel latches the binding and stops matching the label to a contact', () => {
    const svc = serviceWithSelfProfile()
    const granted: string[] = []
    const suggested: string[] = []
    svc.onSelfVerified = (id) => { granted.push(id) }
    svc.onSelfSuggested = (id) => { suggested.push(id) }
    confirmInternals(svc).resolvedSpeakers.set('local_2', { contactId: 'me', contactName: 'Me' })
    svc.confirmSelfLabel('local_2')
    expect(confirmInternals(svc).votingComplete.has('local_2')).toBe(true)
    expect(confirmInternals(svc).resolvedSpeakers.has('local_2')).toBe(false)
    // No later voice grant or suggestion fires this session.
    internals(svc).evaluateSelf('local_1', basis(0), [])
    internals(svc).evaluateSelf('local_1', basis(0), [])
    internals(svc).evaluateSelf('local_4', closeTo(0.75), [])
    internals(svc).evaluateSelf('local_4', closeTo(0.75), [])
    expect(granted).toEqual([])
    expect(suggested).toEqual([])
  })

  it('knows the user’s own contact, and samples a label’s embeddings for learning', () => {
    const svc = serviceWithSelfProfile()
    internals(svc).selfContactIds = new Set(['me'])
    expect(svc.isSelfContact('me')).toBe(true)
    expect(svc.isSelfContact('someone')).toBe(false)
    expect(svc.getSelfEmbeddings('local_2')).toEqual([])
    confirmInternals(svc).sessionEmbeddings.set('local_2', Array.from({ length: 20 }, (_, i) => basis(i)))
    const sampled = svc.getSelfEmbeddings('local_2')
    expect(sampled).toHaveLength(MAX_SELF_TOPUP_EMBEDDINGS)
    expect(sampled[0]).toEqual(basis(0))
    expect(sampled[sampled.length - 1]).toEqual(basis(19))
  })
})

interface SegmentInternals {
  worker: { postMessage: (msg: { type: string; id: string }) => void } | null
  modelLoaded: boolean
  micBuffer: { extractRange: () => Float32Array }
  pendingCallbacks: Map<string, (response: { type: string; embedding?: number[] }) => void>
}

/** A service whose worker answers every request with the next embedding. */
function serviceWithWorker(embeddings: number[][]) {
  const svc = serviceWithSelfProfile()
  const sent: Array<{ type: string; id: string }> = []
  const seg = svc as unknown as SegmentInternals
  seg.worker = { postMessage: (msg) => { sent.push(msg) } }
  seg.modelLoaded = true
  seg.micBuffer = { extractRange: () => new Float32Array(16000 * 3) }
  let i = 0
  const hear = (speaker: string) => {
    svc.onFinalSegment({ speaker, startTime: 0, endTime: 3, isFinal: true, stream: 'mic', words: [], text: 'hi' } as unknown as Parameters<VoiceIdService['onFinalSegment']>[0])
    const msg = sent[sent.length - 1]
    if (!msg || seg.pendingCallbacks.size === 0) return
    seg.pendingCallbacks.get(msg.id)?.({ type: msg.type === 'embed' ? 'embedding' : 'match-result', embedding: embeddings[i++] })
    seg.pendingCallbacks.delete(msg.id)
  }
  return { svc, sent, hear }
}

describe('VoiceIdService — a confirmed voice keeps teaching (followups issue 24)', () => {
  // The worker rests EMBED_REST_FACTOR times each embedding's own length
  // (performance.now()). The fake worker answers at once, but on a slow build
  // machine that still measured a millisecond or two, so the next hear could
  // land inside the rest and be skipped (flaky under the Vercel build). A
  // clock that stands still makes every embedding take no time and no rest.
  beforeEach(() => {
    vi.spyOn(performance, 'now').mockReturnValue(1_000)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('a voice confirmed before it had samples is still sampled, embed-only, and handed over at stop', () => {
    const { svc, sent, hear } = serviceWithWorker(Array.from({ length: 30 }, (_, k) => basis(k)))
    svc.confirmSelfLabel('local_2')
    expect(svc.getSelfEmbeddings('local_2')).toEqual([])
    expect(svc.takeSelfLearnEmbeddings(MAX_SELF_TOPUP_EMBEDDINGS)).toBeNull()

    hear('local_2')
    hear('local_2')
    expect(sent.map((m) => m.type)).toEqual(['embed', 'embed'])
    expect(svc.takeSelfLearnEmbeddings(MAX_SELF_TOPUP_EMBEDDINGS)).toEqual({ label: 'local_2', embeddings: [basis(0), basis(1)] })
    // Only what is still owed: a confirm that posted 7 takes at most 1 more.
    expect(svc.takeSelfLearnEmbeddings(1)?.embeddings).toHaveLength(1)
    expect(svc.takeSelfLearnEmbeddings(0)).toBeNull()
  })

  it('hands over only the samples since the confirm, and stops sampling at the cap', () => {
    const { svc, sent, hear } = serviceWithWorker(Array.from({ length: 40 }, (_, k) => basis(k)))
    confirmInternals(svc).sessionEmbeddings.set('local_1', [basis(100), basis(101)])
    svc.confirmSelfLabel('local_1')
    for (let k = 0; k < MAX_SELF_TOPUP_EMBEDDINGS * 3 + 5; k++) hear('local_1')
    expect(sent).toHaveLength(MAX_SELF_TOPUP_EMBEDDINGS * 3)
    const learn = svc.takeSelfLearnEmbeddings(MAX_SELF_TOPUP_EMBEDDINGS)!
    expect(learn.embeddings).toHaveLength(MAX_SELF_TOPUP_EMBEDDINGS)
    expect(learn.embeddings).not.toContainEqual(basis(100))
    expect(learn.embeddings[0]).toEqual(basis(0))
  })

  it('other finished voices stay skipped, and "not me" on the confirmed voice stops it', () => {
    const { svc, sent, hear } = serviceWithWorker(Array.from({ length: 10 }, (_, k) => basis(k)))
    confirmInternals(svc).votingComplete.add('remote_1')
    svc.confirmSelfLabel('local_2')
    hear('remote_1')
    expect(sent).toHaveLength(0)
    svc.dismissSelfSuggestion('local_2')
    hear('local_2')
    expect(sent).toHaveLength(0)
    expect(svc.takeSelfLearnEmbeddings(MAX_SELF_TOPUP_EMBEDDINGS)).toBeNull()
  })
})
