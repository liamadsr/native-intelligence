import { describe, it, expect } from 'vitest'
import { renderSuggestionUpdates } from '../turn-context'

const at = (iso: string) => Date.parse(iso)
const row = (over: Record<string, unknown>) => ({
  display_text: 'Close GEN-1',
  status: 'pending',
  resolved_at: null,
  expire_reason: null,
  extra: null,
  ...over,
}) as never

describe('renderSuggestionUpdates', () => {
  it('lists what was settled since the last message, with pending left', () => {
    const out = renderSuggestionUpdates(
      [
        row({ status: 'applied', resolved_at: '2026-10-08T12:05:00Z', display_text: 'Move GEN-297 to Todo' }),
        row({ status: 'dismissed', resolved_at: '2026-10-08T12:06:00Z', display_text: 'Close GEN-31', extra: { dismiss_reason: 'still needed' } }),
        row({ status: 'expired', expire_reason: 'already_true', resolved_at: '2026-10-08T12:07:00Z', display_text: 'Close GEN-9' }),
        row({ status: 'applied', resolved_at: '2026-10-08T11:00:00Z', display_text: 'Old one' }),
        row({}),
      ],
      at('2026-10-08T12:00:00Z'),
    )!
    expect(out).toContain('- applied: Move GEN-297 to Todo')
    expect(out).toContain('- dismissed ("still needed"): Close GEN-31')
    expect(out).toContain('- already done another way: Close GEN-9')
    expect(out).not.toContain('Old one')
    expect(out).toContain('1 still pending.')
  })

  it('says nothing when nothing changed and nothing is pending', () => {
    expect(renderSuggestionUpdates([row({ status: 'applied', resolved_at: '2026-10-08T11:00:00Z' })], at('2026-10-08T12:00:00Z'))).toBeNull()
  })
})
