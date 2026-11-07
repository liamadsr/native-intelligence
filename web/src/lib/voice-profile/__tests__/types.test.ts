import { describe, it, expect } from 'vitest'
import {
  qualityLabel,
  QUALITY_LABEL_EXCELLENT,
  QUALITY_LABEL_GOOD,
  EMBEDDING_DIM,
  SELF_VERIFY_THRESHOLD,
  SELF_VERIFY_MARGIN,
  SELF_MISMATCH_THRESHOLD,
  SELF_BINDING_MIN_SERVER_MATCHES,
  ENROLLMENT_MIN_CHUNKS,
  MAX_ENROLLMENT_CHUNKS,
  ENROLLMENT_CHUNK_SECONDS,
  ENROLLMENT_MIN_CHUNK_QUALITY,
  QUALITY_WEIGHT_DURATION,
  QUALITY_WEIGHT_LEVEL,
  QUALITY_WEIGHT_SNR,
  PASSAGE_MIN_CHUNKS,
  PASSAGE_CONSISTENCY_MIN,
  PASSAGE_MAX_RETRIES,
} from '@/lib/voice-profile/types'
import { ENROLLMENT_STORY } from '@/lib/voice-profile/enrollment-story'

/**
 * Locks in the Wave-0 contract everyone else imports: the quality-label
 * boundaries, the tuning constants, and the enrollment story shape.
 */

describe('qualityLabel', () => {
  it('labels scores at/above the excellent threshold "excellent"', () => {
    expect(qualityLabel(QUALITY_LABEL_EXCELLENT)).toBe('excellent')
    expect(qualityLabel(1)).toBe('excellent')
  })

  it('labels scores in the good band "good"', () => {
    expect(qualityLabel(QUALITY_LABEL_GOOD)).toBe('good')
    // Just below excellent still reads as good.
    expect(qualityLabel(QUALITY_LABEL_EXCELLENT - 0.001)).toBe('good')
  })

  it('labels scores below the good threshold "fair"', () => {
    expect(qualityLabel(QUALITY_LABEL_GOOD - 0.001)).toBe('fair')
    expect(qualityLabel(0)).toBe('fair')
  })
})

describe('voice-profile constants', () => {
  it('pins the values downstream waves depend on', () => {
    expect(EMBEDDING_DIM).toBe(512)
    expect(SELF_VERIFY_THRESHOLD).toBe(0.8)
    expect(SELF_VERIFY_MARGIN).toBe(0.03)
    expect(SELF_MISMATCH_THRESHOLD).toBe(0.6)
    expect(SELF_BINDING_MIN_SERVER_MATCHES).toBe(2)
    expect(ENROLLMENT_MIN_CHUNKS).toBe(12)
    // Self-enrollment stores every quality-accepted chunk up to this envelope
    // (raised from 30; no per-passage downsample for a single-voice self-read).
    expect(MAX_ENROLLMENT_CHUNKS).toBe(60)
    expect(MAX_ENROLLMENT_CHUNKS).toBeGreaterThan(ENROLLMENT_MIN_CHUNKS)
    expect(ENROLLMENT_CHUNK_SECONDS).toBe(3)
    expect(ENROLLMENT_MIN_CHUNK_QUALITY).toBe(0.5)
    expect(QUALITY_WEIGHT_DURATION).toBe(0.5)
    expect(QUALITY_WEIGHT_LEVEL).toBe(0.3)
    expect(QUALITY_WEIGHT_SNR).toBe(0.2)
    // The three sub-score weights must sum to 1 so the aggregate stays in [0,1].
    expect(QUALITY_WEIGHT_DURATION + QUALITY_WEIGHT_LEVEL + QUALITY_WEIGHT_SNR).toBeCloseTo(1)
    expect(PASSAGE_MIN_CHUNKS).toBe(4)
    expect(PASSAGE_CONSISTENCY_MIN).toBe(0.7)
    expect(PASSAGE_MAX_RETRIES).toBe(3)
    expect(QUALITY_LABEL_EXCELLENT).toBe(0.85)
    expect(QUALITY_LABEL_GOOD).toBe(0.65)
  })
})

describe('ENROLLMENT_STORY', () => {
  it('has three passages with distinct ids and non-empty text', () => {
    expect(ENROLLMENT_STORY).toHaveLength(3)
    const ids = ENROLLMENT_STORY.map((p) => p.id)
    expect(new Set(ids).size).toBe(3)
    for (const passage of ENROLLMENT_STORY) {
      expect(passage.id).toBeTruthy()
      expect(passage.title).toBeTruthy()
      expect(passage.text.length).toBeGreaterThan(50)
    }
  })

  it('starts with the Snack Committee opening', () => {
    expect(ENROLLMENT_STORY[0].text).toContain('a very small octopus named Pixel')
  })
})
