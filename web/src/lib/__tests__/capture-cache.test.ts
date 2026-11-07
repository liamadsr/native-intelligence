import { describe, it, expect, beforeEach } from 'vitest'
import {
  captureDetailCache,
  CAPTURE_CACHE_MAX,
  seedCaptureCache,
  writeCaptureCache,
  type CaptureDetail,
} from '@/lib/capture-cache'

/**
 * Tests for src/lib/capture-cache.ts.
 *
 * This is the module-level LRU that survives unmount/remount so capture
 * detail panels render instantly on tab switches. If we break it, the UX
 * regresses: users see loading spinners instead of cached data. The
 * eviction cap also matters — unbounded growth on a long session would
 * leak memory.
 */

function makeDetail(id: string): CaptureDetail {
  return {
    id,
    title: `Capture ${id}`,
    user_id: 'u1',
    visibility: 'workspace',
    content: null,
    summary: null,
    transcript: null,
    user_notes: null,
    audio_url: null,
    duration_seconds: null,
    source_url: null,
    calendar_event_id: null,
    meeting_url: null,
    location: null,
    organizer_email: null,
    participants: null,
    project_id: null,
    project_name: null,
    tags: null,
    labels: [],
    metadata: null,
    ai_processed: false,
    ai_summary: null,
    note_attributions: null,
    decision_count: 0,
    suggested_decision_count: 0,
    status: 'completed',
    is_pinned: false,
    started_at: null,
    ended_at: null,
    recorded_at: null,
    package_ids: [],
    created_at: '2026-04-15T00:00:00Z',
    updated_at: '2026-04-15T00:00:00Z',
  }
}

beforeEach(() => {
  captureDetailCache.clear()
})

describe('writeCaptureCache', () => {
  it('stores a capture by id', () => {
    writeCaptureCache('c1', makeDetail('c1'))
    expect(captureDetailCache.get('c1')?.title).toBe('Capture c1')
  })

  it('overwrites existing entries with the same id', () => {
    writeCaptureCache('c1', makeDetail('c1'))
    const updated = { ...makeDetail('c1'), title: 'Updated' }
    writeCaptureCache('c1', updated)
    expect(captureDetailCache.get('c1')?.title).toBe('Updated')
    expect(captureDetailCache.size).toBe(1)
  })

  it('evicts the oldest entry when size exceeds CAPTURE_CACHE_MAX', () => {
    // Fill to the cap
    for (let i = 0; i < CAPTURE_CACHE_MAX; i++) {
      writeCaptureCache(`c${i}`, makeDetail(`c${i}`))
    }
    expect(captureDetailCache.size).toBe(CAPTURE_CACHE_MAX)

    // Adding one more should evict c0 (the oldest)
    writeCaptureCache('c-new', makeDetail('c-new'))
    expect(captureDetailCache.size).toBe(CAPTURE_CACHE_MAX)
    expect(captureDetailCache.has('c0')).toBe(false)
    expect(captureDetailCache.has('c-new')).toBe(true)
  })

  it('can be used with CAPTURE_CACHE_MAX set to 20 entries', () => {
    // Documentation test: lock in the size constant.
    expect(CAPTURE_CACHE_MAX).toBe(20)
  })
})

describe('seedCaptureCache', () => {
  it('populates only the fields present in the POST response and defaults the rest', () => {
    seedCaptureCache({
      id: 'c1',
      title: 'New capture',
      created_at: '2026-04-15T10:00:00Z',
      status: 'active',
      is_pinned: false,
    })

    const cached = captureDetailCache.get('c1')
    expect(cached).toBeDefined()
    expect(cached?.title).toBe('New capture')
    expect(cached?.status).toBe('active')

    // Fields not in POST response should be filled with defaults
    expect(cached?.transcript).toBeNull()
    expect(cached?.ai_processed).toBe(false)
    expect(cached?.decision_count).toBe(0)
    expect(cached?.suggested_decision_count).toBe(0)
    expect(cached?.tags).toBeNull()
  })

  it('defaults visibility to workspace when the POST response omits it', () => {
    // The create route predates the column on older deploys; seeding 'private'
    // by accident would draw a lock badge on a capture everyone can see.
    seedCaptureCache({
      id: 'c1',
      title: 'x',
      created_at: '2026-04-15T10:00:00Z',
      status: 'active',
      is_pinned: false,
    })
    expect(captureDetailCache.get('c1')?.visibility).toBe('workspace')
    expect(captureDetailCache.get('c1')?.user_id).toBeNull()
  })

  it('carries visibility and creator through when the POST response has them', () => {
    seedCaptureCache({
      id: 'c2',
      title: 'x',
      created_at: '2026-04-15T10:00:00Z',
      status: 'active',
      is_pinned: false,
      user_id: 'u-9',
      visibility: 'private',
    })
    expect(captureDetailCache.get('c2')?.visibility).toBe('private')
    expect(captureDetailCache.get('c2')?.user_id).toBe('u-9')
  })

  it('uses created_at for updated_at when POST only provides created_at', () => {
    seedCaptureCache({
      id: 'c1',
      title: 'x',
      created_at: '2026-04-15T10:00:00Z',
      status: 'active',
      is_pinned: false,
    })
    const cached = captureDetailCache.get('c1')
    expect(cached?.updated_at).toBe('2026-04-15T10:00:00Z')
  })

  it('defaults recorded_at to now when not provided', () => {
    const before = Date.now()
    seedCaptureCache({
      id: 'c1',
      title: 'x',
      created_at: '2026-04-15T10:00:00Z',
      status: 'active',
      is_pinned: false,
    })
    const cached = captureDetailCache.get('c1')
    expect(cached?.recorded_at).toBeTruthy()
    const recordedTs = new Date(cached!.recorded_at!).getTime()
    // Should be close to "now" (within a few seconds)
    expect(recordedTs).toBeGreaterThanOrEqual(before)
    expect(recordedTs).toBeLessThanOrEqual(Date.now() + 100)
  })

  it('respects the LRU cap when seeding past the limit', () => {
    for (let i = 0; i < CAPTURE_CACHE_MAX + 3; i++) {
      seedCaptureCache({
        id: `c${i}`,
        title: `c${i}`,
        created_at: '2026-04-15T10:00:00Z',
        status: 'active',
        is_pinned: false,
      })
    }
    expect(captureDetailCache.size).toBe(CAPTURE_CACHE_MAX)
    expect(captureDetailCache.has('c0')).toBe(false)
    expect(captureDetailCache.has('c2')).toBe(false)
    expect(captureDetailCache.has(`c${CAPTURE_CACHE_MAX + 2}`)).toBe(true)
  })
})
