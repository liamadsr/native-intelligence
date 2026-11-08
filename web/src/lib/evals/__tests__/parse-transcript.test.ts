/**
 * Pasting a real transcript into a case.
 *
 * THE THREE FORMATS ARE THE POINT. A person copying a transcript does not know
 * which of our own shapes they hold — the HUD's `You: text`, the stored
 * `[local_1] text`, or the eval authoring `[speaker]: text` — so all three have
 * to land, in one paste if that is how they arrive.
 *
 * THE SECOND THING WORTH A TEST is the timing, because `freezeChunks` reads
 * nothing but `t_ms`: the synthesized offsets are what decide the case's flush
 * boundaries, and a same-speaker gap that accidentally cleared the gate's 3s
 * silence rule would chop a monologue into one window per line.
 */
import { describe, it, expect } from 'vitest'
import {
  BACKWARDS_BUMP_MS,
  MIN_LINE_MS,
  MS_PER_WORD,
  SAME_SPEAKER_GAP_MS,
  TURN_GAP_MS,
  assignLabels,
  defaultSelfSpeaker,
  parseTranscriptText,
  toParticipants,
  toScript,
} from '../parse-transcript'
import { freezeChunks } from '../freeze-chunks'

describe('parseTranscriptText — the three formats', () => {
  it('reads the HUD Copy shape (display names, `Speaker: text`)', () => {
    const parsed = parseTranscriptText(
      ['You: Quick one before we wrap.', 'Remote 1: Sure, what is up?'].join('\n'),
    )
    expect(parsed.problems).toEqual([])
    expect(parsed.speakers).toEqual(['You', 'Remote 1'])
    expect(parsed.lines).toEqual([
      { speaker: 'You', text: 'Quick one before we wrap.', t_ms: null },
      { speaker: 'Remote 1', text: 'Sure, what is up?', t_ms: null },
    ])
  })

  it('reads the stored shape (raw labels, `[local_1] text`)', () => {
    const parsed = parseTranscriptText(
      ['[local_1] Thanks for making time.', '[remote_1] Of course.'].join('\n'),
    )
    expect(parsed.speakers).toEqual(['local_1', 'remote_1'])
    expect(parsed.lines[0].text).toBe('Thanks for making time.')
  })

  it('reads the eval authoring shape (`[speaker]: text`)', () => {
    const parsed = parseTranscriptText('[Dana]: What does this cost?')
    expect(parsed.lines).toEqual([
      { speaker: 'Dana', text: 'What does this cost?', t_ms: null },
    ])
  })

  it('reads all three mixed into one paste', () => {
    const parsed = parseTranscriptText(
      [
        'You: Let us start with the roadmap.',
        '[remote_1] Sure, what is the priority?',
        '[Dana]: I have a question on pricing.',
      ].join('\n'),
    )
    expect(parsed.problems).toEqual([])
    expect(parsed.speakers).toEqual(['You', 'remote_1', 'Dana'])
    expect(parsed.lines.map((l) => l.text)).toEqual([
      'Let us start with the roadmap.',
      'Sure, what is the priority?',
      'I have a question on pricing.',
    ])
  })
})

describe('parseTranscriptText — line handling', () => {
  it('folds a prefix-less line into the previous utterance with a SPACE', () => {
    // Not a newline: the editor renders one auto-growing textarea per
    // utterance, so an embedded newline is invisible there and then shows up
    // inside the replayed chunk text.
    const parsed = parseTranscriptText(
      ['[local_1] We should ship this week', 'and tell the customer on Friday.'].join('\n'),
    )
    expect(parsed.lines).toHaveLength(1)
    expect(parsed.lines[0].text).toBe('We should ship this week and tell the customer on Friday.')
  })

  it('skips blank lines without treating them as continuations', () => {
    const parsed = parseTranscriptText('You: One.\n\n\nDana: Two.\n')
    expect(parsed.lines).toHaveLength(2)
    expect(parsed.lines[1].text).toBe('Two.')
  })

  it('keeps a colon inside the spoken text — the speaker is up to the FIRST one', () => {
    const parsed = parseTranscriptText("You: Here is the thing: we need it by Friday.")
    expect(parsed.lines[0].speaker).toBe('You')
    expect(parsed.lines[0].text).toBe('Here is the thing: we need it by Friday.')
  })

  it('reports a leading prefix-less line as a problem rather than throwing', () => {
    const parsed = parseTranscriptText('just some notes I typed\nYou: Hello.')
    expect(parsed.lines).toHaveLength(1)
    expect(parsed.problems).toHaveLength(1)
    expect(parsed.problems[0]).toContain('no speaker')
  })

  it('returns nothing, and a problem, for empty input', () => {
    const parsed = parseTranscriptText('   \n\n  ')
    expect(parsed.lines).toEqual([])
    expect(parsed.speakers).toEqual([])
    expect(parsed.problems).toHaveLength(1)
  })
})

describe('parseTranscriptText — timestamps', () => {
  it('accepts all four shapes and keeps the offset', () => {
    const parsed = parseTranscriptText(
      [
        '[00:05] You: Bracketed.',
        '(0:10) You: Parenthesised.',
        '0:15 You: Bare.',
        '01:00:20 You: Hours.',
      ].join('\n'),
    )
    expect(parsed.lines.map((l) => l.t_ms)).toEqual([5000, 10_000, 15_000, 3_620_000])
    expect(parsed.lines.map((l) => l.text)).toEqual([
      'Bracketed.',
      'Parenthesised.',
      'Bare.',
      'Hours.',
    ])
  })

  it('strips a timestamp ahead of a bracketed label too', () => {
    const parsed = parseTranscriptText('[0:04] [remote_1] What does this cost?')
    expect(parsed.lines[0]).toEqual({
      speaker: 'remote_1',
      text: 'What does this cost?',
      t_ms: 4000,
    })
  })

  it('leaves a mid-sentence clock time alone', () => {
    const parsed = parseTranscriptText('You: Let us meet at 12:30 tomorrow.')
    expect(parsed.lines[0].t_ms).toBeNull()
    expect(parsed.lines[0].text).toBe('Let us meet at 12:30 tomorrow.')
  })

  /**
   * A timestamp on its OWN line, which is how most exports outside Native Intelligence wrap
   * a transcript. A bracketed timestamp carries no trailing space, so the
   * timestamp pattern has to claim it before the bracketed-label pattern does
   * — otherwise it mints a participant called "00:12" and an empty-text
   * segment, and the empty text then 400s the whole Save.
   */
  it('does not mint a speaker from a timestamp alone on its line', () => {
    const parsed = parseTranscriptText(
      ['[00:12]', 'You: hi', '[00:20]', 'Dana: yeah'].join('\n'),
    )
    expect(parsed.speakers).toEqual(['You', 'Dana'])
    expect(parsed.lines).toEqual([
      { speaker: 'You', text: 'hi', t_ms: null },
      { speaker: 'Dana', text: 'yeah', t_ms: null },
    ])
    expect(toScript(parsed, 'You').every((s) => s.text.length > 0)).toBe(true)
    expect(toParticipants(parsed, 'You').map((p) => p.display)).toEqual([
      'You',
      'Dana',
    ])
  })

  it('reads a bracketed timestamp with no space after it', () => {
    const parsed = parseTranscriptText('[00:12]You: hi')
    expect(parsed.lines[0]).toEqual({ speaker: 'You', text: 'hi', t_ms: 12_000 })
  })

  it('reads a parenthesised timestamp alone on its line', () => {
    const parsed = parseTranscriptText(['(1:05)', 'Dana: yeah'].join('\n'))
    expect(parsed.speakers).toEqual(['Dana'])
  })

  /**
   * A bracket containing only whitespace is not a label. Taking it yields a
   * participant with an empty display, which the route's participant schema
   * rejects outright — so the whole paste is lost to one stripped label.
   */
  it('does not mint a blank speaker from an empty bracket label', () => {
    const parsed = parseTranscriptText(
      ['Dana: ok then', '[ ] text here'].join('\n'),
    )
    expect(parsed.speakers).toEqual(['Dana'])
    expect(parsed.lines).toEqual([
      { speaker: 'Dana', text: 'ok then text here', t_ms: null },
    ])
    expect(toParticipants(parsed, null).every((p) => p.display.length > 0)).toBe(
      true,
    )
  })

  it('does not mint a blank speaker from `[ ]: text` either', () => {
    const parsed = parseTranscriptText(['Dana: ok', '[  ]: more'].join('\n'))
    expect(parsed.speakers).toEqual(['Dana'])
  })
})

describe('toScript — timing', () => {
  it('uses the paste’s own clock when EVERY line carries one, rebased to zero', () => {
    const parsed = parseTranscriptText(
      ['[0:10] You: One.', '[0:14] Dana: Two.', '[0:30] You: Three.'].join('\n'),
    )
    const script = toScript(parsed, 'You')
    expect(script.map((s) => s.t_ms)).toEqual([0, 4000, 20_000])
  })

  it('bumps a BACKWARDS timestamp past its predecessor', () => {
    // `freezeChunks` sorts by `t_ms`, so a line that goes backwards would
    // silently reorder the meeting rather than merely sitting out of order.
    const parsed = parseTranscriptText(
      ['[0:10] You: One.', '[0:05] Dana: Two.', '[0:12] You: Three.'].join('\n'),
    )
    const script = toScript(parsed, 'You')
    expect(script[1].t_ms).toBe(script[0].t_ms + BACKWARDS_BUMP_MS)
    expect(script[2].t_ms).toBe(2000)
  })

  it('treats a PARTIALLY timed paste as untimed', () => {
    const parsed = parseTranscriptText(['[0:10] You: One.', 'Dana: Two.'].join('\n'))
    const script = toScript(parsed, 'You')
    expect(script[0].t_ms).toBe(0)
    // Synthesized, not 0 → 0: one word floors at MIN_LINE_MS, then a turn gap.
    expect(script[1].t_ms).toBe(MIN_LINE_MS + TURN_GAP_MS)
  })

  it('synthesizes a TURN gap on a speaker change and a shorter one within a turn', () => {
    const parsed = parseTranscriptText(
      [
        'You: one two three four',
        'You: five six',
        'Dana: seven',
      ].join('\n'),
    )
    const script = toScript(parsed, 'You')
    expect(script[0].t_ms).toBe(0)
    // Same speaker next → the short gap, so a monologue stays in one window.
    expect(script[1].t_ms).toBe(4 * MS_PER_WORD + SAME_SPEAKER_GAP_MS)
    // Speaker changes → the turn gap, which clears the gate's silence rule.
    expect(script[2].t_ms).toBe(script[1].t_ms + Math.max(MIN_LINE_MS, 2 * MS_PER_WORD) + TURN_GAP_MS)
  })

  it('leaves a SHORT exchange as one window, as the real gate would', () => {
    // The size floor (`GATE_MIN_FLUSH_CHARS`, 1200) outranks the silence rule,
    // and that is correct: a three-line exchange was one flush on the real
    // call too. A paste that produced three crumb windows would be grading a
    // meeting that never happened.
    const parsed = parseTranscriptText(
      [
        'You: Quick one before we wrap. Can you send the security questionnaire this week?',
        'Dana: Yes. I will have it to you by Thursday.',
        'You: Perfect, thanks.',
      ].join('\n'),
    )
    const chunks = freezeChunks(toScript(parsed, 'You'))
    expect(chunks).toHaveLength(1)
    expect(chunks[0].segment_indices).toEqual([0, 1, 2])
  })

  it('lands every boundary on a TURN CHANGE once the floor is cleared', () => {
    // What the gap constants actually buy. Each turn is long enough on its own
    // to clear 1200 chars, so the silence rule gets to fire — and it fires at
    // the speaker change, never mid-utterance.
    const long = (who: string, n: number) =>
      `${who}: ${'we should talk about the migration timeline in some detail '.repeat(n)}`
    const parsed = parseTranscriptText(
      [long('You', 30), long('Dana', 30), long('You', 30)].join('\n'),
    )
    const chunks = freezeChunks(toScript(parsed, 'You'))
    expect(chunks.map((c) => c.segment_indices)).toEqual([[0], [1], [2]])
  })

  it('starts at an offset when appending', () => {
    const parsed = parseTranscriptText('You: One.\nDana: Two.')
    const script = toScript(parsed, 'You', { startMs: 50_000 })
    expect(script[0].t_ms).toBe(50_000)
    expect(script[1].t_ms).toBeGreaterThan(50_000)
  })
})

describe('toScript — speaker labels', () => {
  it('maps the chosen self to local_1 on the mic and the rest to remote_N in order', () => {
    // The isolation contract: eval captures are `desktop_dual`, and exactly one
    // `local_*` on the mic stream is what `selfSpeakerLabel` binds to the owner.
    const parsed = parseTranscriptText(
      ['Dana: First to speak.', 'You: Second.', 'Priya: Third.', 'Dana: Again.'].join('\n'),
    )
    const script = toScript(parsed, 'You')
    expect(script.map((s) => s.speaker)).toEqual(['remote_1', 'local_1', 'remote_2', 'remote_1'])
    expect(script.map((s) => s.stream)).toEqual(['system', 'mic', 'system', 'system'])
  })

  it('puts EVERYONE on the system stream when the self is Nobody', () => {
    const parsed = parseTranscriptText('You: One.\nDana: Two.')
    const script = toScript(parsed, null)
    expect(script.map((s) => s.speaker)).toEqual(['remote_1', 'remote_2'])
    expect(script.every((s) => s.stream === 'system')).toBe(true)
  })

  it('skips labels already taken, so an append never reuses one', () => {
    const labels = assignLabels(['Dana', 'Priya'], null, new Set(['remote_1']))
    expect(labels).toEqual({ Dana: 'remote_2', Priya: 'remote_3' })
  })

  it('returns an empty script for an empty parse', () => {
    expect(toScript(parseTranscriptText(''), null)).toEqual([])
  })
})

describe('toParticipants', () => {
  it('keeps the pasted display names against their assigned labels', () => {
    const parsed = parseTranscriptText('You: One.\nDana Reyes: Two.')
    expect(toParticipants(parsed, 'You')).toEqual([
      { speaker_label: 'local_1', display: 'You', is_self: true },
      { speaker_label: 'remote_1', display: 'Dana Reyes', is_self: false },
    ])
  })
})

describe('defaultSelfSpeaker', () => {
  it('prefers the HUD’s own word for the local mic', () => {
    expect(defaultSelfSpeaker(['Dana', 'You'])).toBe('You')
  })

  it('falls back to a raw local_* label, then to the first speaker', () => {
    expect(defaultSelfSpeaker(['remote_1', 'local_1'])).toBe('local_1')
    expect(defaultSelfSpeaker(['Dana', 'Priya'])).toBe('Dana')
    expect(defaultSelfSpeaker([])).toBeNull()
  })
})
