/**
 * Tests for the report-mode tool ceiling — the trust gradient's safe end.
 * A run_skill action with mode 'report' must not be able to reach ANY
 * mutating tool, no matter how the ceiling is assembled: computeToolCeiling
 * seeds CORE_TOOL_NAMES unconditionally (its disabledTools arg only filters
 * category-expanded names), so the mutating core trio (create_action /
 * update_action / complete_action) would leak without the result-level
 * subtraction computeReportModeCeiling performs.
 *
 * The executor itself (createRunSkillExecutor) is service-client + LLM
 * plumbing — its dispatch contract is covered by the mock-executor tests in
 * runner.test.ts.
 */
import { describe, it, expect } from 'vitest'
import {
  computeReportModeCeiling,
  computeSkillCeiling,
  substituteTitleTokens,
  decideVerdictNotification,
} from '../run-skill'
import { getMutatingToolNames, REPORT_MODE_WRITE_ALLOWLIST } from '@/lib/ai/tool-registry'
import { CORE_TOOL_NAMES } from '@/lib/ai/tool-discovery'

describe('computeReportModeCeiling', () => {
  const mutating = getMutatingToolNames()

  it('excludes EVERY mutating tool when the skill inherits all categories', () => {
    const ceiling = computeReportModeCeiling(undefined)
    const leaked = [...ceiling].filter((name) => mutating.has(name))
    expect(leaked).toEqual([])
  })

  it('excludes the mutating CORE tools that bypass computeToolCeiling disabledTools', () => {
    const ceiling = computeReportModeCeiling(undefined)
    // These are in CORE_TOOL_NAMES, so a naive computeToolCeiling(categories,
    // mutating) would still include them — the regression this guards.
    expect(CORE_TOOL_NAMES).toContain('create_action')
    expect(ceiling.has('create_action')).toBe(false)
    expect(ceiling.has('update_action')).toBe(false)
    expect(ceiling.has('complete_action')).toBe(false)
  })

  it("includes report mode's own output surface (the write allowlist)", () => {
    const ceiling = computeReportModeCeiling(undefined)
    for (const name of REPORT_MODE_WRITE_ALLOWLIST) {
      expect(ceiling.has(name), name).toBe(true)
    }
  })

  it('includes read tools (core + category reads)', () => {
    const ceiling = computeReportModeCeiling(undefined)
    for (const name of ['search', 'deep_search', 'list_actions', 'get_document', 'get_dashboard_summary', 'search_tools']) {
      expect(ceiling.has(name), name).toBe(true)
    }
  })

  it('scopes to the skill categories while still excluding their writes', () => {
    const ceiling = computeReportModeCeiling(['documents'])
    // Reads from the documents category are in.
    expect(ceiling.has('get_document')).toBe(true)
    expect(ceiling.has('list_documents')).toBe(true)
    // Allowlisted output write is in.
    expect(ceiling.has('create_document')).toBe(true)
    // Every other documents write is out.
    expect(ceiling.has('update_document')).toBe(false)
    expect(ceiling.has('edit_document_content')).toBe(false)
    expect(ceiling.has('publish_draft')).toBe(false)
    // Tools from categories the skill didn't enable stay out (core reads aside).
    expect(ceiling.has('list_emails')).toBe(false)
    // No mutating tool leaks through the narrowed ceiling either.
    const leaked = [...ceiling].filter((name) => mutating.has(name))
    expect(leaked).toEqual([])
  })

  it('empty categories behave as inherit-all, still write-free', () => {
    const all = computeReportModeCeiling(undefined)
    const empty = computeReportModeCeiling([])
    expect([...empty].sort()).toEqual([...all].sort())
  })
})

describe('substituteTitleTokens', () => {
  it('substitutes {skill} and {date}', () => {
    expect(substituteTitleTokens('{skill} — {date}', 'Morning Brief', '2026-07-01')).toBe(
      'Morning Brief — 2026-07-01',
    )
  })

  it('does not expand $-replacement patterns in the skill name', () => {
    // A sequential .replace(/\{skill\}/g, name) would expand $' / $& / $$ here.
    expect(substituteTitleTokens('{skill} — {date}', "Q&A $' digest", '2026-07-01')).toBe(
      "Q&A $' digest — 2026-07-01",
    )
    expect(substituteTitleTokens('{skill}', 'a$&b$$c', 'x')).toBe('a$&b$$c')
  })

  it('does not re-substitute a literal {date} inside the skill name (single pass)', () => {
    expect(substituteTitleTokens('{skill} — {date}', 'Literal {date} skill', '2026-07-01')).toBe(
      'Literal {date} skill — 2026-07-01',
    )
  })
})

describe('decideVerdictNotification (silence = success)', () => {
  const L = (over: Partial<{ cards_surfaced: number; cards_overflow: number; revoked_count: number; summary: string }> = {}) => ({
    cards_surfaced: 0, cards_overflow: 0, revoked_count: 0, summary: 'did stuff', ...over,
  })

  it('is SILENT when a run auto-applied/dismissed everything (0 cards, 0 revokes) — even with notification:true', () => {
    // The bug: notification:true was read as "forced", making silence unreachable.
    expect(decideVerdictNotification(L(), 'Proposal Triage', true)).toBeNull()
    expect(decideVerdictNotification(L(), 'Proposal Triage', undefined)).toBeNull()
  })

  it('notifies when there are cards to review', () => {
    const note = decideVerdictNotification(L({ cards_surfaced: 2 }), 'Proposal Triage', true)
    expect(note).not.toBeNull()
    expect(note!.title).toBe('Proposal Triage: 2 need you')
    expect(note!.body).toContain('2 to review')
  })

  it('singular title for one card', () => {
    expect(decideVerdictNotification(L({ cards_surfaced: 1 }), 'Triage', true)!.title).toBe('Triage: 1 needs you')
  })

  it('revoke-only run notifies honestly (not "0 need you")', () => {
    const note = decideVerdictNotification(L({ revoked_count: 3 }), 'Triage', true)
    expect(note).not.toBeNull()
    expect(note!.title).toBe('Triage: removed 3 auto-accepted')
  })

  it('notification:false suppresses even a card-bearing run (opt-out)', () => {
    expect(decideVerdictNotification(L({ cards_surfaced: 5 }), 'Triage', false)).toBeNull()
  })

  it('mentions overflow when some cards spilled past the cap', () => {
    const note = decideVerdictNotification(L({ cards_surfaced: 3, cards_overflow: 4 }), 'Triage', true)
    expect(note!.body).toContain('+4 more in the capture')
  })
})

