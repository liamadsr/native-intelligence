/**
 * A flow fire's per-action results → its ledger row: deliverables, summary, skip
 * reason and error.
 */
import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ActionResult } from '@/lib/flows/types'
import type { WorkHandle } from '../recorder'
import {
  deliverablesFromActionResults,
  firstErrorFromResults,
  outputDocumentTitles,
  reviewFor,
  settleFlowWork,
  skipReasonFromResults,
  summarizeActionResults,
} from '../flow-results'

function result(over: Partial<ActionResult> = {}): ActionResult {
  return {
    action_id: 'a1',
    condition_met: true,
    disabled: false,
    incomplete: false,
    skipped: false,
    status: 'success',
    request_summary: null,
    response_status_code: 200,
    response_body_preview: null,
    error_message: null,
    duration_ms: 10,
    ...over,
  }
}

function verdict(over: Record<string, unknown> = {}) {
  return {
    summary: 's',
    entries: [
      { proposal_id: 'p1', decision: 'accept', outcome: 'applied', reason: 'r', entity_id: 'act-1' },
      { proposal_id: 'p2', decision: 'dismiss', outcome: 'dismissed', reason: 'r' },
      { proposal_id: 'p3', decision: 'accept', outcome: 'carded', reason: 'r' },
    ],
    cards_surfaced: 1,
    cards_overflow: 0,
    revoked_count: 0,
    ...over,
  }
}

function handle() {
  const h = {
    id: 'w1',
    kind: 'flow_run',
    workspaceId: 'ws',
    memberId: 'm',
    inert: false,
    step: vi.fn(async () => {}),
    beat: vi.fn(async () => {}),
    link: vi.fn(async () => {}),
    needInput: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    finish: vi.fn(async () => {}),
    fail: vi.fn(async () => {}),
    skip: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    flush: vi.fn(async () => {}),
  }
  return h as unknown as WorkHandle & typeof h
}

/** A client whose document read answers `rows` (or `error`), recording the ids asked for. */
function docClient(rows: Array<{ id: string; title: string | null }>, error: { message: string } | null = null) {
  const asked: string[][] = []
  const client = {
    from: (table: string) => {
      expect(table).toBe('document')
      return {
        select: () => ({
          in: async (_col: string, ids: string[]) => {
            asked.push(ids)
            return { data: error ? null : rows, error }
          },
        }),
      }
    },
  }
  return { client: client as unknown as SupabaseClient, asked }
}

describe('deliverablesFromActionResults', () => {
  it('collects documents, surfaced cards (keyed on the run), filed actions and archived captures', () => {
    const out = deliverablesFromActionResults(
      [
        result({ output_document_id: 'doc-1' }),
        result({ action_id: 'a2', verdict: verdict() as never }),
        result({ action_id: 'a3', archived_capture_id: 'cap-1' }),
        result({ action_id: 'a4', skipped: true, output_document_id: 'doc-skipped' }),
      ],
      'fr-1',
    )
    expect(out).toEqual([
      { type: 'document', id: 'doc-1', label: 'Output document' },
      { type: 'attention_cards', id: 'fr-1', label: '1 card for you', count: 1 },
      { type: 'action', id: 'act-1', label: 'Filed action' },
      { type: 'capture', id: 'cap-1', label: 'Archived capture' },
    ])
  })

  it("labels a document with its title when it's known", () => {
    const out = deliverablesFromActionResults(
      [result({ output_document_id: 'doc-1' }), result({ action_id: 'a2', output_document_id: 'doc-2' })],
      'fr-1',
      { 'doc-1': 'Morning Brief — 2026-10-20' },
    )
    expect(out).toEqual([
      { type: 'document', id: 'doc-1', label: 'Morning Brief — 2026-10-20' },
      { type: 'document', id: 'doc-2', label: 'Output document' },
    ])
  })

  it('skips the cards deliverable without a run id to key it on', () => {
    const out = deliverablesFromActionResults([result({ verdict: verdict() as never })], null)
    expect(out.map((d) => d.type)).toEqual(['action'])
  })
})

describe('outputDocumentTitles', () => {
  it("reads the delivered documents' titles once each, skipping blanks and skipped actions", async () => {
    const { client, asked } = docClient([
      { id: 'doc-1', title: '  Morning Brief —\n2026-10-20 ' },
      { id: 'doc-2', title: '   ' },
    ])
    const titles = await outputDocumentTitles(client, [
      result({ output_document_id: 'doc-1' }),
      result({ action_id: 'a2', output_document_id: 'doc-1' }),
      result({ action_id: 'a3', output_document_id: 'doc-2' }),
      result({ action_id: 'a4', skipped: true, output_document_id: 'doc-skipped' }),
    ])
    expect(asked).toEqual([['doc-1', 'doc-2']])
    expect(titles).toEqual({ 'doc-1': 'Morning Brief — 2026-10-20' })
  })

  it('reads nothing without a document, and gives up quietly on an error', async () => {
    const none = docClient([])
    expect(await outputDocumentTitles(none.client, [result()])).toEqual({})
    expect(none.asked).toEqual([])
    const failed = docClient([], { message: 'boom' })
    expect(await outputDocumentTitles(failed.client, [result({ output_document_id: 'doc-1' })])).toEqual({})
  })
})

describe('summarizeActionResults', () => {
  it('summarizes a verdict run from its ledger', () => {
    expect(summarizeActionResults([result({ verdict: verdict() as never })])).toBe('filed 1 · dismissed 1 · 1 for you')
    expect(summarizeActionResults([result({ verdict: verdict({ verdict_missing: true }) as never })])).toBe(
      'ran out of steps — no verdict',
    )
  })

  it('summarizes deliveries, then falls back to a fired count', () => {
    expect(
      summarizeActionResults([result({ output_document_id: 'd' }), result({ dispatched: true, agent_run_id: 'ar' })]),
    ).toBe('Delivered 1 document · 1 agent run started')
    expect(summarizeActionResults([result(), result()])).toBe('2 actions fired')
    expect(summarizeActionResults([result({ skipped: true })])).toBeNull()
  })
})

describe('skipReasonFromResults / firstErrorFromResults', () => {
  it('surfaces the dormancy preview, else the structural reason', () => {
    expect(skipReasonFromResults([result({ skipped: true, response_body_preview: 'workspace inactive for 14d — skipped (no cost)' })])).toBe(
      'workspace inactive for 14d — skipped (no cost)',
    )
    expect(skipReasonFromResults([result({ skipped: true, disabled: true })])).toBe('Action disabled')
    expect(skipReasonFromResults([result({ skipped: true, incomplete: true })])).toBe('Action needs setup')
    expect(skipReasonFromResults([result({ skipped: true })])).toBe('Conditions not met')
    expect(skipReasonFromResults([])).toBe('Nothing to do')
  })

  it('reads the first failed action error, with a fallback', () => {
    expect(firstErrorFromResults([result({ status: 'failed', error_message: 'timed out' })])).toBe('timed out')
    expect(firstErrorFromResults([result({ status: 'failed', error_message: '' })])).toBe('The run failed')
  })
})

describe('reviewFor', () => {
  it('a prose run that wrote a document is something to check; a verdict run is not', () => {
    const doc = [{ type: 'document' as const, id: 'doc-1', label: 'Output document' }]
    expect(reviewFor([result({ output_document_id: 'doc-1' })], doc)).toEqual({ kind: 'review', verb: 'check' })
    expect(reviewFor([result({ verdict: verdict() as never }), result({ output_document_id: 'doc-1' })], doc)).toBeNull()
    expect(reviewFor([result()], [])).toBeNull()
  })
})

describe('settleFlowWork', () => {
  it('a prose document → needs_review (check), never a silent drop', async () => {
    const h = handle()
    await settleFlowWork(h, {
      status: 'success',
      actionResults: [result({ output_document_id: 'doc-1' })],
      flowRunId: 'fr',
    })
    expect(h.finish).toHaveBeenCalledWith({
      summary: 'Delivered 1 document',
      deliverables: [{ type: 'document', id: 'doc-1', label: 'Output document' }],
      review: { kind: 'review', verb: 'check' },
    })
  })

  it("a document is labelled with its title (Liam, 10-20: not 'Output document')", async () => {
    const h = handle()
    const { client } = docClient([{ id: 'doc-1', title: 'Morning Brief — 2026-10-20' }])
    await settleFlowWork(h, {
      status: 'success',
      actionResults: [result({ output_document_id: 'doc-1' })],
      flowRunId: 'fr',
      supabase: client,
    })
    expect(h.finish).toHaveBeenCalledWith({
      summary: 'Delivered 1 document',
      deliverables: [{ type: 'document', id: 'doc-1', label: 'Morning Brief — 2026-10-20' }],
      review: { kind: 'review', verb: 'check' },
    })
  })

  it('nothing fired → skipped with the reason', async () => {
    const h = handle()
    await settleFlowWork(h, { status: 'success', actionResults: [result({ skipped: true, disabled: true })], flowRunId: 'fr' })
    expect(h.skip).toHaveBeenCalledWith('Action disabled')
    expect(h.finish).not.toHaveBeenCalled()
  })

  it('a failed action → failed with its error and the summary', async () => {
    const h = handle()
    await settleFlowWork(h, {
      status: 'failed',
      actionResults: [result({ status: 'failed', error_message: 'AI usage limit reached' })],
      flowRunId: 'fr',
    })
    expect(h.fail).toHaveBeenCalledWith('AI usage limit reached', { summary: '1 action fired' })
  })

  it('success → done with summary and deliverables', async () => {
    const h = handle()
    await settleFlowWork(h, {
      status: 'success',
      actionResults: [result({ verdict: verdict() as never })],
      flowRunId: 'fr-1',
    })
    expect(h.finish).toHaveBeenCalledWith({
      summary: 'filed 1 · dismissed 1 · 1 for you',
      deliverables: [
        { type: 'attention_cards', id: 'fr-1', label: '1 card for you', count: 1 },
        { type: 'action', id: 'act-1', label: 'Filed action' },
      ],
    })
  })
})
