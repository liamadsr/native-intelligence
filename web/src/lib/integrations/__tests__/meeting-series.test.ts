/**
 * Series-identity derivation. The invariants that matter:
 *  - Google/Microsoft master ids win when present
 *  - Google instance ids are parseable back to the master (backfill + old callers)
 *  - EventKit's shared eventIdentifier IS the series key, but only for recurring events
 *  - Non-recurring events keep icalUid/occurrenceStart (cross-user grouping) with no seriesKey
 */
import { describe, it, expect } from 'vitest'
import {
  deriveSeriesIdentity,
  parseGoogleSeriesFromInstanceId,
} from '@/lib/integrations/meeting-series'

describe('parseGoogleSeriesFromInstanceId', () => {
  it('strips a timed-instance suffix', () => {
    expect(parseGoogleSeriesFromInstanceId('abc123def_20260811T170000Z')).toBe('abc123def')
  })

  it('strips an all-day-instance suffix', () => {
    expect(parseGoogleSeriesFromInstanceId('abc123def_20260811')).toBe('abc123def')
  })

  it('returns null for a non-instance id', () => {
    expect(parseGoogleSeriesFromInstanceId('abc123def')).toBeNull()
    expect(parseGoogleSeriesFromInstanceId('abc_extra_20260811T1700')).toBeNull()
  })
})

describe('deriveSeriesIdentity', () => {
  it('prefers the explicit provider master id', () => {
    const identity = deriveSeriesIdentity({
      id: 'master1_20260811T170000Z',
      start: '2026-08-11T17:00:00.000Z',
      seriesMasterId: 'master1',
      icalUid: 'uid-1@google.com',
      hasRecurrence: true,
    })
    expect(identity.seriesKey).toBe('master1')
    expect(identity.icalUid).toBe('uid-1@google.com')
    expect(identity.occurrenceStart).toBe('2026-08-11T17:00:00.000Z')
  })

  it('falls back to the Google instance-id prefix for recurring events without a master id', () => {
    const identity = deriveSeriesIdentity({
      id: 'master1_20260811T170000Z',
      start: '2026-08-11T17:00:00Z',
      hasRecurrence: true,
    })
    expect(identity.seriesKey).toBe('master1')
  })

  it('uses the shared EventKit id as the series key for recurring local events', () => {
    const identity = deriveSeriesIdentity({
      id: 'EK-SHARED-ID',
      start: '2026-08-11T17:00:00Z',
      hasRecurrence: true,
      source: 'local_exchange',
    })
    expect(identity.seriesKey).toBe('EK-SHARED-ID')
  })

  it('does NOT thread a non-recurring local event', () => {
    const identity = deriveSeriesIdentity({
      id: 'EK-ONE-OFF',
      start: '2026-08-11T17:00:00Z',
      hasRecurrence: false,
      source: 'local_exchange',
    })
    expect(identity.seriesKey).toBeNull()
  })

  it('keeps icalUid and occurrenceStart for non-recurring events (same-call grouping)', () => {
    const identity = deriveSeriesIdentity({
      id: 'oneoff123',
      start: '2026-08-11T17:00:00+02:00',
      icalUid: 'uid-2@outlook.com',
      hasRecurrence: false,
    })
    expect(identity.seriesKey).toBeNull()
    expect(identity.icalUid).toBe('uid-2@outlook.com')
    expect(identity.occurrenceStart).toBe('2026-08-11T15:00:00.000Z')
  })

  it('handles a missing start', () => {
    const identity = deriveSeriesIdentity({ id: 'x', seriesMasterId: 'm' })
    expect(identity.occurrenceStart).toBeNull()
    expect(identity.seriesKey).toBe('m')
  })
})
