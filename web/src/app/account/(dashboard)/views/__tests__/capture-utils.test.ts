import { describe, it, expect } from 'vitest'
import {
  formatParticipantSummary,
  type MeetingParticipant,
} from '../capture-utils'

/**
 * Tests for formatParticipantSummary in capture-utils.ts.
 *
 * This helper formats the participants array on a CaptureListItem into a
 * human-readable string displayed in each capture row on the all-captures page.
 * If it regresses, rows will fall back to showing nothing instead of names.
 */

describe('formatParticipantSummary', () => {
  it('returns an empty string for an empty array', () => {
    expect(formatParticipantSummary([])).toBe('')
  })

  it('returns the participant name for a single participant', () => {
    const participants: MeetingParticipant[] = [{ name: 'Alice Brown' }]
    expect(formatParticipantSummary(participants)).toBe('Alice Brown')
  })

  it('joins two participant names with a comma', () => {
    const participants: MeetingParticipant[] = [
      { name: 'Alice Brown' },
      { name: 'Bob Chen' },
    ]
    expect(formatParticipantSummary(participants)).toBe('Alice Brown, Bob Chen')
  })

  it('shows first two names and "+N more" when there are more than two participants', () => {
    const participants: MeetingParticipant[] = [
      { name: 'Alice Brown' },
      { name: 'Bob Chen' },
      { name: 'Carol Day' },
    ]
    expect(formatParticipantSummary(participants)).toBe(
      'Alice Brown, Bob Chen +1 more',
    )
  })

  it('shows correct +N count for many participants', () => {
    const participants: MeetingParticipant[] = [
      { name: 'Alice' },
      { name: 'Bob' },
      { name: 'Carol' },
      { name: 'Dave' },
      { name: 'Eve' },
    ]
    expect(formatParticipantSummary(participants)).toBe('Alice, Bob +3 more')
  })

  it('falls back to the email local-part when name is absent', () => {
    const participants: MeetingParticipant[] = [
      { email: 'alice@example.com' },
    ]
    expect(formatParticipantSummary(participants)).toBe('alice')
  })

  it('prefers name over email when both are present', () => {
    const participants: MeetingParticipant[] = [
      { name: 'Alice Brown', email: 'alice@example.com' },
    ]
    expect(formatParticipantSummary(participants)).toBe('Alice Brown')
  })

  it('skips participants with no name and no email', () => {
    const participants: MeetingParticipant[] = [
      { name: 'Alice Brown' },
      { isOrganizer: true }, // no name, no email
    ]
    expect(formatParticipantSummary(participants)).toBe('Alice Brown')
  })

  it('returns empty string when all participants lack name and email', () => {
    const participants: MeetingParticipant[] = [
      { isOrganizer: true },
      { company: 'Acme' },
    ]
    expect(formatParticipantSummary(participants)).toBe('')
  })

  it('trims whitespace from names', () => {
    const participants: MeetingParticipant[] = [
      { name: '  Alice Brown  ' },
      { name: '  Bob Chen  ' },
    ]
    expect(formatParticipantSummary(participants)).toBe('Alice Brown, Bob Chen')
  })
})
