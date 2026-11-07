/**
 * quote-speakers.ts — who said a proposal's trigger quote (followups issue 11):
 * the channel a label came in on, the turns a quote spans, and `possibly_you`,
 * the signal triage cards an unidentified first-person commitment on the
 * user's own microphone by instead of dismissing it "not yours".
 */
import { describe, it, expect } from 'vitest'
import { createSupabaseMock } from '@/test/supabase-mock'
import {
  alignQuote,
  channelOf,
  labelsForSpan,
  loadQuoteSpeakers,
  quoteLabels,
  quoteParts,
  quoteSpeaker,
  spokenWords,
  type CaptureVoices,
} from '../quote-speakers'

// Shaped like the Sep 28 standup: several voices on the microphone, the call on remote_*.
const TRANSCRIPT = [
  '[remote_1] Mobility still has no CRM connection access.',
  "[local_1] I submitted a ticket on Friday let me check on the ticket and see if they completed it",
  "uh I'll let you know I'll ping you the status of that",
  '[local_2] if you share a screenshot with some tags and all so that would be better for me',
  "[remote_3] I don't know why the link to the Pigma file isn't in there but I can add that",
].join('\n')

const voices = (over: Partial<CaptureVoices> = {}): CaptureVoices => ({
  recordedByCaller: true,
  recorderVoiceIdentified: false,
  identified: new Map([['remote_1', 'Austin Bauder']]),
  ...over,
})

describe('channelOf', () => {
  it('local_* is the microphone, remote_* the meeting audio, anything else none', () => {
    expect(channelOf('local_1')).toBe('microphone')
    expect(channelOf('local_12')).toBe('microphone')
    expect(channelOf('remote_3')).toBe('meeting_audio')
    expect(channelOf('Me')).toBeNull()
    expect(channelOf('local_x')).toBeNull()
    expect(channelOf('speaker_1')).toBeNull()
  })
})

describe('labelsForSpan', () => {
  it('names the turn a span sits in, a continuation line included, and every turn a span crosses', () => {
    const at = (text: string) => {
      const start = TRANSCRIPT.indexOf(text)
      return { start, end: start + text.length }
    }
    expect(labelsForSpan(TRANSCRIPT, at('ping you the status'))).toEqual(['local_1'])
    expect(labelsForSpan(TRANSCRIPT, at('Mobility still'))).toEqual(['remote_1'])
    const across = { start: TRANSCRIPT.indexOf('status of that'), end: TRANSCRIPT.indexOf('better for me') + 5 }
    expect(labelsForSpan(TRANSCRIPT, across)).toEqual(['local_1', 'local_2'])
  })
})

describe('quoteParts', () => {
  it('splits a quote its writer joined with " / ", and nothing else', () => {
    expect(quoteParts('"a thing" / "another thing"')).toEqual(['"a thing"', '"another thing"'])
    expect(quoteParts('one/two and three')).toEqual(['one/two and three'])
  })
})

describe('quoteLabels: a quote that is not verbatim', () => {
  // The Sep 28 standup, as recorded: the turn split across two mic voices,
  // cut by someone on the call, with fillers the extractor dropped.
  const RECORDED = [
    '[remote_4] for the sharing the build',
    '[local_1] yeah I I submitted a ticket on Friday let me check on the',
    '[local_4] ticket and see if they',
    "[local_4] completed it uh I'll let you know I'll ping you",
    '[remote_3] sure',
    '[local_4] the status of that',
    '[local_1] I think it was just the metrics on',
    '[local_1] um',
    '[local_1] the which sales Kpis but I guess let me talk to Arch Node to understand',
  ].join('\n')

  it('aligns past a repeat, fillers and an interjection, and names only the voices whose words line up', () => {
    const quote = "I submitted a ticket on Friday let me check on the ticket and see if they completed it uh I'll let you know I'll ping you the status of that"
    expect(quoteLabels(RECORDED, quote)).toEqual(['local_1', 'local_4'])
    expect(quoteLabels(RECORDED, 'I think it was just the metrics on the which sales Kpis but I guess let me talk to Arch Node')).toEqual(['local_1'])
  })

  it('aligns each elided piece on its own', () => {
    expect(quoteLabels(RECORDED, 'for the sharing the build… I think it was just the metrics on the which sales')).toEqual(['remote_4', 'local_1'])
  })

  it('does not place a quote when too few of its words line up, or a piece that is too short', () => {
    expect(quoteLabels(RECORDED, 'I will open a new ticket about the build for the Friday release')).toEqual([])
    const words = spokenWords(RECORDED)
    expect(words.some((w) => w.word === 'um' || w.word === 'uh')).toBe(false)
    expect(alignQuote(words, ['let', 'me', 'check', 'on'])).toBeNull()
    expect(alignQuote(words, ['let', 'me', 'check', 'on', 'the'])).not.toBeNull()
    // 5 of 8 words line up in order: under 70%.
    expect(alignQuote(words, ['let', 'me', 'check', 'on', 'the', 'weekly', 'deck', 'numbers'])).toBeNull()
    // Aligned through four substituted words, only 6 of 10 match: a substitution is not a match.
    expect(alignQuote(words, ['let', 'me', 'verify', 'on', 'a', 'report', 'and', 'check', 'if', 'they'])).toBeNull()
    expect(alignQuote(words, ['let', 'me', 'check', 'on', 'a', 'ticket', 'and', 'see', 'if', 'they'])?.length).toBe(9)
  })
})

describe('quoteSpeaker', () => {
  it('an unidentified microphone voice, on the caller’s capture with their voice unidentified, is possibly them', () => {
    const quote = "let me check on the ticket and see if they completed it uh I'll let you know I'll ping you the status"
    expect(quoteSpeaker(TRANSCRIPT, quote, voices())).toEqual({
      speakers: [{ label: 'local_1', channel: 'microphone', identified_as: null }],
      possibly_you: true,
    })
  })

  it('is not possibly them once the caller’s voice is identified, on someone else’s recording, or from the call', () => {
    const mine = 'let me check on the ticket and see if they completed it'
    expect(quoteSpeaker(TRANSCRIPT, mine, voices({ recorderVoiceIdentified: true }))?.possibly_you).toBe(false)
    expect(quoteSpeaker(TRANSCRIPT, mine, voices({ recordedByCaller: false }))?.possibly_you).toBe(false)
    const call = quoteSpeaker(TRANSCRIPT, 'Mobility still has no CRM connection access', voices())
    expect(call).toEqual({ speakers: [{ label: 'remote_1', channel: 'meeting_audio', identified_as: 'Austin Bauder' }], possibly_you: false })
    // An unidentified voice on the call is still not the caller's microphone.
    const unidentifiedCall = quoteSpeaker(TRANSCRIPT, "I don't know why the link to the Pigma file isn't in there", voices())
    expect(unidentifiedCall).toEqual({ speakers: [{ label: 'remote_3', channel: 'meeting_audio', identified_as: null }], possibly_you: false })
  })

  it('a microphone voice identified as someone is not possibly the caller', () => {
    const v = voices({ identified: new Map([['local_1', 'Rohan']]) })
    expect(quoteSpeaker(TRANSCRIPT, 'let me check on the ticket and see if they completed it', v)).toEqual({
      speakers: [{ label: 'local_1', channel: 'microphone', identified_as: 'Rohan' }],
      possibly_you: false,
    })
  })

  it('places each " / "-joined part on its own, and an elided quote by its pieces', () => {
    const joined = '"if you share a screenshot with some tags and all" / "I don\'t know why the link to the Pigma file isn\'t in there but I can add that"'
    expect(quoteSpeaker(TRANSCRIPT, joined, voices())?.speakers.map((s) => s.label)).toEqual(['local_2', 'remote_3'])
    const elided = 'I submitted a ticket on Friday... ping you the status of that'
    expect(quoteSpeaker(TRANSCRIPT, elided, voices())?.speakers.map((s) => s.label)).toEqual(['local_1'])
  })

  it('a quote not in the transcript (a paraphrase) has no speaker', () => {
    expect(quoteSpeaker(TRANSCRIPT, 'I will look into the CRM ticket and report back', voices())).toBeNull()
  })
})

describe('loadQuoteSpeakers', () => {
  const rows = [
    { id: 'p1', capture_id: 'c1', trigger_quote: 'let me check on the ticket and see if they completed it' },
    { id: 'p2', capture_id: 'c1', trigger_quote: null },
    { id: 'p3', capture_id: null, trigger_quote: 'Mobility still has no CRM connection access' },
  ]

  it('reads the transcript and the labelled participants; the caller’s own identified voice reads "the user"', async () => {
    const supabase = createSupabaseMock({
      tables: {
        captures: { data: [{ id: 'c1', user_id: 'u1', transcript: TRANSCRIPT }], error: null },
        capture_participant: {
          data: [
            { capture_id: 'c1', speaker_label: 'local_2', is_self: true, self_binding: 'voice', external_name: null, member: { display_name: 'Liam' } },
            { capture_id: 'c1', speaker_label: 'remote_1', is_self: false, self_binding: 'none', external_name: null, member: null },
          ],
          error: null,
        },
      },
    })
    const out = await loadQuoteSpeakers(supabase as never, rows, 'u1', 'u1')
    expect([...out.keys()]).toEqual(['p1'])
    // The caller's voice is identified (local_2), so local_1 is someone else in the room.
    expect(out.get('p1')).toEqual({ speakers: [{ label: 'local_1', channel: 'microphone', identified_as: null }], possibly_you: false })

    const mapped = await loadQuoteSpeakers(supabase as never, [{ id: 'p4', capture_id: 'c1', trigger_quote: 'if you share a screenshot with some tags' }], 'u1', 'u1')
    expect(mapped.get('p4')?.speakers).toEqual([{ label: 'local_2', channel: 'microphone', identified_as: 'the user' }])
  })

  it('an unbound self row (self_binding none) identifies no one, and a failed read leaves every row out', async () => {
    const supabase = createSupabaseMock({
      tables: {
        captures: { data: [{ id: 'c1', user_id: 'u1', transcript: TRANSCRIPT }], error: null },
        capture_participant: {
          data: [{ capture_id: 'c1', speaker_label: 'local_1', is_self: true, self_binding: 'none', external_name: null, member: null }],
          error: null,
        },
      },
    })
    expect((await loadQuoteSpeakers(supabase as never, rows, 'u1', 'u1')).get('p1')?.possibly_you).toBe(true)

    const failing = createSupabaseMock({
      tables: {
        captures: { data: null, error: { message: 'boom' } },
        capture_participant: { data: [], error: null },
      },
    })
    expect((await loadQuoteSpeakers(failing as never, rows, 'u1', 'u1')).size).toBe(0)
    // Participants unreadable: no voice can be known unidentified, so nothing is reported.
    const noParticipants = createSupabaseMock({
      tables: {
        captures: { data: [{ id: 'c1', user_id: 'u1', transcript: TRANSCRIPT }], error: null },
        capture_participant: { data: null, error: { message: 'boom' } },
      },
    })
    expect((await loadQuoteSpeakers(noParticipants as never, rows, 'u1', 'u1')).size).toBe(0)
  })

  it('reads transcripts through the capture visibility fence: eval captures excluded, private ones by requester', async () => {
    const calls: Array<[string, string, unknown[]]> = []
    const table = (name: string, data: unknown) => {
      const chain: Record<string, unknown> = {}
      for (const m of ['select', 'in', 'not', 'neq', 'or', 'eq']) {
        chain[m] = (...args: unknown[]) => {
          calls.push([name, m, args])
          return chain
        }
      }
      chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data, error: null }).then(resolve)
      return chain
    }
    const supabase = {
      from: (name: string) =>
        table(name, name === 'captures' ? [{ id: 'c1', user_id: 'u1', transcript: TRANSCRIPT }] : []),
    }
    await loadQuoteSpeakers(supabase as never, rows, 'u1', 'u1')
    const captureCalls = calls.filter(([name]) => name === 'captures')
    expect(captureCalls).toContainEqual(['captures', 'neq', ['is_eval', true]])
    expect(captureCalls.some(([, m, args]) => m === 'or' && String(args[0]).includes('u1'))).toBe(true)
  })

  it('on a capture someone else recorded, the microphone is theirs: nothing is possibly the caller', async () => {
    const supabase = createSupabaseMock({
      tables: {
        captures: { data: [{ id: 'c1', user_id: 'someone-else', transcript: TRANSCRIPT }], error: null },
        capture_participant: { data: [], error: null },
      },
    })
    expect((await loadQuoteSpeakers(supabase as never, rows, 'u1', 'u1')).get('p1')).toEqual({
      speakers: [{ label: 'local_1', channel: 'microphone', identified_as: null }],
      possibly_you: false,
    })
  })
})
