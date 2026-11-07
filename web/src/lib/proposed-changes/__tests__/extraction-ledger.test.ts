import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * The extraction ledger (One Accept Authority, W-3): the extraction apply path
 * accumulates verdict-shaped entries and flushes ONE extraction_pass row. Tests
 * cover the accumulation shape (applied vs staged), the empty-pass no-op, and the
 * best-effort flush (never throws, swallows insert errors).
 *
 * SERVICE-CLIENT WIRING (adversarial-review finding 1): extraction_pass has RLS
 * with NO insert policy — a request-scoped `authenticated` client would be
 * silently denied and the ledger would never persist for real captures. The flush
 * must therefore go through getServiceClient(). Unit tests can't exercise real
 * RLS, so these assert the WIRING structurally: every insert goes through the
 * mocked service client, and flush takes no request client at all.
 */

const hoisted = vi.hoisted(() => ({
  /** The extraction_pass insert — chain-shaped: insert → select('id') → single. */
  insert: vi.fn(),
  passSelect: vi.fn(),
  /** What that chain settles to: the new pass row's id, or an error. */
  passSingle: vi.fn(),
  /** The work ledger's insert (tracked_job) — chain-shaped: insert → select → maybeSingle. */
  workInsert: vi.fn(),
  from: vi.fn(),
  getServiceClient: vi.fn(),
}))

vi.mock('@/lib/supabase/service', () => ({
  getServiceClient: hoisted.getServiceClient,
}))
// Row 4: the pass is attributed to the workspace's Extraction system teammate.
vi.mock('@/lib/work/system-teammates', () => ({
  systemTeammateId: async (_client: unknown, workspaceId: string, key: string) => `tm-${key}-${workspaceId}`,
}))

import { ExtractionLedgerRecorder, summarizeExtraction } from '../extraction-ledger'

beforeEach(() => {
  // The pass row's id comes back from the insert so the work item can name the
  // pass it records (the Activity panel reads the pass's entries through it).
  hoisted.passSingle.mockReset().mockResolvedValue({ data: { id: 'pass-1' }, error: null })
  hoisted.passSelect.mockReset().mockReturnValue({ single: () => hoisted.passSingle() })
  hoisted.insert.mockReset().mockReturnValue({ select: hoisted.passSelect })
  hoisted.workInsert.mockReset().mockImplementation((row: Record<string, unknown>) => ({
    select: () => ({ maybeSingle: async () => ({ data: { id: 'job-1', ...row }, error: null }) }),
  }))
  hoisted.from.mockReset().mockImplementation((table: string) =>
    table === 'tracked_job' ? { insert: hoisted.workInsert } : { insert: hoisted.insert },
  )
  hoisted.getServiceClient.mockReset().mockReturnValue({ from: hoisted.from })
})

describe('ExtractionLedgerRecorder', () => {
  it('accumulates applied + staged entries with verdict-shaped outcomes', () => {
    const rec = new ExtractionLedgerRecorder()
    rec.applied('p1', 'act-1', 'auto-applied create:action')
    rec.applied('p2', 'act-2', 'auto-applied create:action')
    rec.staged('p3', 'gate staged — pending review')

    const ledger = rec.build()
    expect(ledger.applied_count).toBe(2)
    expect(ledger.staged_count).toBe(1)
    expect(ledger.entries).toHaveLength(3)

    const applied = ledger.entries.filter((e) => e.outcome === 'applied')
    expect(applied.map((e) => e.proposal_id)).toEqual(['p1', 'p2'])
    expect(applied[0].entity_id).toBe('act-1')
    expect(applied[0].decision).toBe('accept')

    const staged = ledger.entries.filter((e) => e.outcome === 'carded')
    expect(staged).toHaveLength(1)
    expect(staged[0].proposal_id).toBe('p3')
    // A staged entry carries no entity_id (nothing was created).
    expect(staged[0].entity_id).toBeUndefined()
  })

  it('reports empty when nothing was recorded', () => {
    const rec = new ExtractionLedgerRecorder()
    expect(rec.isEmpty()).toBe(true)
    rec.staged('p1', 'reason')
    expect(rec.isEmpty()).toBe(false)
  })

  it('flush is a NO-OP (no service client, no insert) when the pass recorded nothing', async () => {
    const rec = new ExtractionLedgerRecorder()
    await rec.flush({ workspaceId: 'ws-1', captureId: 'cap-1', mode: 'batch' })
    expect(hoisted.getServiceClient).not.toHaveBeenCalled()
    expect(hoisted.insert).not.toHaveBeenCalled()
  })

  it('flush inserts one extraction_pass row THROUGH THE SERVICE CLIENT (RLS is select-only)', async () => {
    const rec = new ExtractionLedgerRecorder()
    rec.applied('p1', 'act-1', 'auto-applied create:action')
    rec.staged('p2', 'gate staged — pending review')

    await rec.flush({ workspaceId: 'ws-9', captureId: 'cap-9', mode: 'live' })

    // The structural wiring assertion: the write went through getServiceClient()
    // — a request-scoped client would be RLS-denied for real (JWT) captures.
    expect(hoisted.getServiceClient).toHaveBeenCalledTimes(1)
    expect(hoisted.from).toHaveBeenCalledWith('extraction_pass')
    expect(hoisted.insert).toHaveBeenCalledTimes(1)
    // The insert reads the new row's id back — the work item names the pass.
    expect(hoisted.passSelect).toHaveBeenCalledWith('id')
    const row = hoisted.insert.mock.calls[0][0]
    // workspace_id/capture_id come from the caller's authenticated request
    // context (the routes resolve + fence them server-side before flushing).
    expect(row.workspace_id).toBe('ws-9')
    expect(row.capture_id).toBe('cap-9')
    expect(row.mode).toBe('live')
    expect(row.ledger.applied_count).toBe(1)
    expect(row.ledger.staged_count).toBe(1)
    expect(row.ledger.entries).toHaveLength(2)
  })

  it('flush records the pass in the work ledger only when the caller names an owner', async () => {
    const rec = new ExtractionLedgerRecorder()
    rec.applied('p1', 'act-1', 'auto-applied create:action')
    rec.applied('p2', 'act-2', 'auto-applied create:action')
    rec.staged('p3', 'gate staged — pending review')

    await rec.flush({ workspaceId: 'ws-9', captureId: 'cap-9', mode: 'batch' })
    expect(hoisted.workInsert).not.toHaveBeenCalled()

    await rec.flush({
      workspaceId: 'ws-9',
      captureId: 'cap-9',
      mode: 'live',
      work: { memberId: 'm-9', captureTitle: 'Pricing sync with Dana' },
    })
    expect(hoisted.workInsert).toHaveBeenCalledTimes(1)
    // One-shot: the row is born settled, owned by the extracting member, and
    // deep-links the capture as its deliverable.
    expect(hoisted.workInsert.mock.calls[0][0]).toMatchObject({
      workspace_id: 'ws-9',
      member_id: 'm-9',
      kind: 'extraction',
      actor: 'loop',
      status: 'done',
      title: 'Extracting from Pricing sync with Dana',
      result_summary: 'Filed 2, staged 1 for review',
      progress: { applied: 2, staged: 1 },
      deliverables: [{ type: 'capture', id: 'cap-9', label: 'Pricing sync with Dana' }],
      // Who ran it: the workspace's Captures face (Extraction until migration 318), and its area.
      ai_team_member_id: 'tm-captures-ws-9',
      area: 'captures',
    })
    // …and names the extraction_pass row it records, so the panel can read that
    // pass's entries back instead of re-matching it by capture and time.
    expect(hoisted.workInsert.mock.calls[0][0].source).toEqual({
      capture_id: 'cap-9',
      mode: 'live',
      extraction_pass_id: 'pass-1',
    })
    // The extraction_pass row still went through the service client each time.
    expect(hoisted.insert).toHaveBeenCalledTimes(2)
  })

  it('summarizeExtraction reads as one settle line', () => {
    expect(summarizeExtraction(3, 2)).toBe('Filed 3, staged 2 for review')
    expect(summarizeExtraction(3, 0)).toBe('Filed 3')
    expect(summarizeExtraction(0, 2)).toBe('Staged 2 for review')
    expect(summarizeExtraction(0, 0)).toBe('Nothing to file')
  })

  it('flush NEVER throws — a Supabase insert error is swallowed (board writes already committed)', async () => {
    hoisted.passSingle.mockResolvedValue({ data: null, error: { message: 'boom' } })
    const rec = new ExtractionLedgerRecorder()
    rec.applied('p1', 'act-1', 'r')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(
      rec.flush({ workspaceId: 'ws-1', captureId: 'cap-1', mode: 'batch', work: { memberId: 'm-1', captureTitle: 'Standup' } }),
    ).resolves.toBeUndefined()
    // The distinctive breadcrumb, so a silent-persist failure is greppable.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[extraction-ledger] flush failed'),
    )
    // The work item is still recorded — it just cannot name the pass, and the
    // read side falls back to matching it by capture and time.
    expect(hoisted.workInsert).toHaveBeenCalledTimes(1)
    expect(hoisted.workInsert.mock.calls[0][0].source).toEqual({ capture_id: 'cap-1', mode: 'batch' })
    warn.mockRestore()
  })

  it('flush NEVER throws — a rejected insert promise is caught', async () => {
    hoisted.passSingle.mockRejectedValue(new Error('network'))
    const rec = new ExtractionLedgerRecorder()
    rec.applied('p1', 'act-1', 'r')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(
      rec.flush({ workspaceId: 'ws-1', captureId: 'cap-1', mode: 'batch', work: { memberId: 'm-1', captureTitle: 'Standup' } }),
    ).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[extraction-ledger] flush failed'),
      expect.anything(),
    )
    // A throw means the client itself is unusable — the flush gives up rather
    // than trying to write the work row through it.
    expect(hoisted.workInsert).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('flush NEVER throws — even getServiceClient itself throwing is caught', async () => {
    hoisted.getServiceClient.mockImplementation(() => {
      throw new Error('missing env')
    })
    const rec = new ExtractionLedgerRecorder()
    rec.applied('p1', 'act-1', 'r')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(
      rec.flush({ workspaceId: 'ws-1', captureId: 'cap-1', mode: 'batch' }),
    ).resolves.toBeUndefined()
    warn.mockRestore()
  })
})
