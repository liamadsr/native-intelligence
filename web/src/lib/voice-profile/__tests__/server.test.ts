/**
 * buildSelfPrototypes — the user's prototypes come from every Settings passage
 * plus the newest meeting-learned sessions (followups issue 11), so a run of
 * confirmed meetings can never push the clean read-aloud passages out of the
 * MAX_PROTOTYPES cap.
 */
import { describe, it, expect } from 'vitest'
import { buildSelfPrototypes, type UserVoiceProfileRow } from '../server'
import { MAX_PROTOTYPES } from '@/lib/voice-prototypes'
import { l2Normalize } from '@/lib/voice-id-matching'
import { EMBEDDING_DIM } from '../types'

function vec(entries: Record<number, number>): number[] {
  const v = new Array(EMBEDDING_DIM).fill(0)
  for (const [k, x] of Object.entries(entries)) v[Number(k)] = x
  return l2Normalize(v)
}
const day = (d: number) => `2026-09-${String(d).padStart(2, '0')}T10:00:00Z`

describe('buildSelfPrototypes', () => {
  it('keeps every Settings passage and fills the rest with the newest meeting-learned sessions', () => {
    const settings: UserVoiceProfileRow[] = [0, 1, 2].map((i) => ({
      embedding: vec({ 0: 1 }),
      quality: 0.9,
      session_id: `settings-${i}`,
      created_at: '2026-08-05T10:00:00Z',
      source: 'settings_training',
    }))
    // Twelve meeting sessions, all newer, near-identical (so none is an outlier),
    // each marked by its own tiny component so the kept ones can be told apart.
    const learned: UserVoiceProfileRow[] = Array.from({ length: 12 }, (_, i) => ({
      embedding: vec({ 1: 1, [20 + i]: 0.01 }),
      quality: 0.7,
      session_id: `meeting-${i}`,
      created_at: day(10 + i),
      source: 'session_confirm',
    }))
    const prototypes = buildSelfPrototypes([...settings, ...learned])
    expect(prototypes).toHaveLength(MAX_PROTOTYPES)
    const settingsKept = prototypes.filter((p) => p[0] > 0.99).length
    expect(settingsKept).toBe(3)
    const learnedKept = prototypes.filter((p) => p[1] > 0.99).map((p) => p.findIndex((x, k) => k >= 20 && x > 0) - 20)
    expect(learnedKept.sort((a, b) => a - b)).toEqual([5, 6, 7, 8, 9, 10, 11])
  })

  it('rows with no source (older reads) count as Settings passages, and a profile with no learning is unchanged', () => {
    const rows: UserVoiceProfileRow[] = [0, 1, 2].map((i) => ({
      embedding: vec({ 0: 1, [5 + i]: 0.01 }),
      quality: 0.9,
      session_id: `s-${i}`,
      created_at: '2026-08-05T10:00:00Z',
    }))
    expect(buildSelfPrototypes(rows)).toHaveLength(3)
    expect(buildSelfPrototypes([])).toEqual([])
  })
})
