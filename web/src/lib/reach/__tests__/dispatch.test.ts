import { describe, it, expect } from 'vitest'
import { quietUntil, smsConsent, smsQuietUntil } from '../dispatch'

/**
 * The pieces every way of reaching the person shares: quiet hours by their
 * zone (or every mainland US zone when none is known), and how far their
 * phone's consent reaches: everything at the away words, an approval's code
 * at the older "needs your OK" words, replies only with alert texts off.
 */

// 2026-10-24 15:00 UTC: 11:00 in New York, 00:00 in Tokyo.
const NOON_ISH = Date.UTC(2026, 9, 24, 15, 0)

describe('quietUntil', () => {
  it('is null by day, and the next 08:00 local by night', () => {
    expect(quietUntil(NOON_ISH, 'America/New_York')).toBeNull()
    // 00:00 in Tokyo: eight hours to go.
    expect(quietUntil(NOON_ISH, 'Asia/Tokyo')).toBe(NOON_ISH + 8 * 3_600_000)
    // 22:30 UTC: 9.5 hours to 08:00.
    const late = Date.UTC(2026, 9, 24, 22, 30)
    expect(quietUntil(late, 'UTC')).toBe(late + 9.5 * 3_600_000)
  })

  it('falls back to UTC for a zone it cannot read', () => {
    const late = Date.UTC(2026, 9, 24, 23, 0)
    expect(quietUntil(late, 'Not/AZone')).toBe(late + 9 * 3_600_000)
  })
})

describe('smsQuietUntil', () => {
  it('with no known zone, holds quiet hours in every mainland US zone (the latest morning wins)', () => {
    // 05:00 UTC: 01:00 in New York, 22:00 in Los Angeles; quiet until 08:00 Pacific (15:00 UTC).
    const t = Date.UTC(2026, 9, 24, 5, 0)
    expect(smsQuietUntil(t, null)).toBe(Date.UTC(2026, 9, 24, 15, 0))
    // 13:00 UTC: 09:00 New York but 06:00 Los Angeles: still quiet until 15:00 UTC.
    expect(smsQuietUntil(Date.UTC(2026, 9, 24, 13, 0), null)).toBe(Date.UTC(2026, 9, 24, 15, 0))
    expect(smsQuietUntil(Date.UTC(2026, 9, 24, 18, 0), null)).toBeNull()
  })
})

describe('smsConsent: how far the phone’s consent reaches', () => {
  const phone = (row: Record<string, unknown> | null, error: unknown = null) =>
    ({
      from: () => {
        const q: Record<string, unknown> = {}
        q.select = () => q
        q.eq = () => q
        q.not = () => q
        q.maybeSingle = async () => ({ data: row, error })
        return q
      },
    }) as never

  it('any verified phone that hasn’t said STOP gets away texts: linking is the agreement, no second switch (Liam, 2026-10-31)', async () => {
    expect(await smsConsent(phone({ opted_out_at: null }), 'u')).toBe('away')
  })

  it('nothing for a phone that said STOP, no phone, or a failed read', async () => {
    expect(await smsConsent(phone({ opted_out_at: 'x' }), 'u')).toBeNull()
    expect(await smsConsent(phone(null), 'u')).toBeNull()
    expect(await smsConsent(phone(null, { message: 'down' }), 'u')).toBeNull()
  })
})
