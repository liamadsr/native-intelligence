import { describe, it, expect } from 'vitest'

/**
 * Tests for getSpeakerDisplayName (src/hooks/use-recording.ts) — the shared
 * speaker-label → display-name helper that live self-verification drives via
 * the `demotedSelfLabels` set.
 *
 * Finding 2: when a self grant is CONFIRMED by the server, the verified label
 * must be un-demoted so it renders as "You" again. These pin the display
 * round-trip that un-demotion depends on: a demoted local_1 shows "Local 1";
 * once removed from the set it shows "You" again.
 */
import { getSpeakerDisplayName } from '@/hooks/use-recording'

describe('getSpeakerDisplayName', () => {
  it('shows "You" for local_1 by default (no demotion set)', () => {
    expect(getSpeakerDisplayName('local_1', {})).toBe('You')
  })

  it('shows "You" for local_1 when the demotion set does not hold it', () => {
    expect(getSpeakerDisplayName('local_1', {}, new Set())).toBe('You')
  })

  it('stops showing "You" once local_1 is demoted', () => {
    // Demotion (sustained self-mismatch, or another label verified as self).
    expect(getSpeakerDisplayName('local_1', {}, new Set(['local_1']))).toBe('Local 1')
  })

  it('restores "You" when local_1 is un-demoted (server confirmed the grant)', () => {
    // The callback deletes the label from the set on granted:true — the display
    // must flip straight back to "You".
    const demoted = new Set(['local_1'])
    expect(getSpeakerDisplayName('local_1', {}, demoted)).toBe('Local 1')
    demoted.delete('local_1')
    expect(getSpeakerDisplayName('local_1', {}, demoted)).toBe('You')
  })

  it('an explicit speaker name always wins over the "You" special-case', () => {
    // On a confirmed grant for a non-default label the callback also sets
    // speakerNames[label] = 'You'; an explicit name short-circuits everything.
    expect(getSpeakerDisplayName('remote_2', { remote_2: 'You' }, new Set())).toBe('You')
  })

  it('never special-cases a non-default local label', () => {
    expect(getSpeakerDisplayName('local_2', {})).toBe('Local 2')
  })

  it('formats remote labels', () => {
    expect(getSpeakerDisplayName('remote_1', {})).toBe('Remote 1')
  })
})
