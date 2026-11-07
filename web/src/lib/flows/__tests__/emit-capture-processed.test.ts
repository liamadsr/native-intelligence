import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Tests for src/lib/flows/emit-capture-processed.ts.
 *
 * This is the single feed point for everything hanging off
 * `flow/capture.processed` (flow dispatch AND the capture-ingest
 * knowledge-graph trigger), called from both batch finalize tails
 * (live-agent route + /stage route). The contract locked in here: the emit
 * is fire-and-forget — an Inngest send failure must NEVER propagate to the
 * caller, because the capture's extraction has already succeeded and the
 * request must not fail on flow/knowledge delivery.
 */

const hoisted = vi.hoisted(() => ({
  send: vi.fn(),
  maybeSingle: vi.fn(),
}))

vi.mock('@/lib/inngest/client', () => ({
  inngest: { send: hoisted.send },
}))

// Service-role client used only for the visibility read. Every builder method
// is chainable; `maybeSingle` is the per-test seam.
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => {
    const chain = {
      from: () => chain,
      select: () => chain,
      eq: () => chain,
      maybeSingle: hoisted.maybeSingle,
    }
    return chain
  },
}))

const { emitCaptureProcessed } = await import(
  '@/lib/flows/emit-capture-processed'
)

/** The emit resolves a visibility promise before sending; let it settle. */
const flush = () => new Promise((resolve) => setImmediate(resolve))

describe('emitCaptureProcessed', () => {
  beforeEach(() => {
    hoisted.send.mockReset()
    hoisted.maybeSingle.mockReset()
    hoisted.maybeSingle.mockResolvedValue({ data: { visibility: 'workspace' } })
  })

  it('sends flow/capture.processed with snake_case payload', async () => {
    hoisted.send.mockResolvedValueOnce({ ids: ['evt-1'] })

    emitCaptureProcessed({
      workspaceId: 'ws-1',
      captureId: 'cap-1',
      processedAt: '2026-07-09T10:00:00Z',
      visibility: 'workspace',
    })
    await flush()

    expect(hoisted.send).toHaveBeenCalledOnce()
    expect(hoisted.send).toHaveBeenCalledWith({
      name: 'flow/capture.processed',
      data: {
        workspace_id: 'ws-1',
        capture_id: 'cap-1',
        processed_at: '2026-07-09T10:00:00Z',
        flow_eligible: true,
      },
    })
  })

  // ── Private captures do not fire workspace automations ──────────────────
  // The event is still SENT (capture-ingest's knowledge extraction rides it
  // and is deliberately kept for private captures — the claims are the
  // creator's own and gated at read time). Only flow_eligible flips.
  it('marks a private capture flow-ineligible without suppressing the event', async () => {
    hoisted.send.mockResolvedValueOnce({ ids: ['evt-1'] })

    emitCaptureProcessed({
      workspaceId: 'ws-1',
      captureId: 'cap-1',
      processedAt: '2026-07-09T10:00:00Z',
      visibility: 'private',
    })
    await flush()

    expect(hoisted.send).toHaveBeenCalledOnce()
    expect(hoisted.send.mock.calls[0][0].data).toMatchObject({
      capture_id: 'cap-1',
      flow_eligible: false,
    })
  })

  it('reads visibility itself when the caller does not supply it', async () => {
    hoisted.maybeSingle.mockResolvedValueOnce({ data: { visibility: 'private' } })
    hoisted.send.mockResolvedValueOnce({ ids: ['evt-1'] })

    emitCaptureProcessed({ workspaceId: 'ws-1', captureId: 'cap-1' })
    await flush()

    expect(hoisted.maybeSingle).toHaveBeenCalledOnce()
    expect(hoisted.send.mock.calls[0][0].data.flow_eligible).toBe(false)
  })

  it('fails closed when the capture row is missing', async () => {
    hoisted.maybeSingle.mockResolvedValueOnce({ data: null })
    hoisted.send.mockResolvedValueOnce({ ids: ['evt-1'] })

    emitCaptureProcessed({ workspaceId: 'ws-1', captureId: 'gone' })
    await flush()

    expect(hoisted.send.mock.calls[0][0].data.flow_eligible).toBe(false)
  })

  it('fails closed when the visibility read throws', async () => {
    hoisted.maybeSingle.mockRejectedValueOnce(new Error('db down'))
    hoisted.send.mockResolvedValueOnce({ ids: ['evt-1'] })

    emitCaptureProcessed({ workspaceId: 'ws-1', captureId: 'cap-1' })
    await flush()

    expect(hoisted.send).toHaveBeenCalledOnce()
    expect(hoisted.send.mock.calls[0][0].data.flow_eligible).toBe(false)
  })

  it('never throws (and leaves no unhandled rejection) when the send fails', async () => {
    hoisted.send.mockRejectedValueOnce(new Error('inngest down'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    // Synchronous call must not throw…
    expect(() =>
      emitCaptureProcessed({ workspaceId: 'ws-1', captureId: 'cap-1' }),
    ).not.toThrow()

    // …and the rejected promise must be swallowed by the attached catch
    // (an unhandled rejection would crash the process in strict runtimes).
    await flush()
    await flush()
    expect(errorSpy).toHaveBeenCalledWith(
      '[flows] inngest.send failed',
      expect.any(Error),
    )

    errorSpy.mockRestore()
  })
})
