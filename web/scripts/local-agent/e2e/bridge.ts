/**
 * `tauriBridge.localAgent` for the headless relay, over the fake Rust's IPC
 * instead of Tauri's invoke. Every answer goes through the REAL parsers in
 * src/lib/tauri-bridge.ts (toLocalAgentStatus, toLocalAgentDevice,
 * toLocalAgentEnvelope), and errors become `LocalAgentResult`s the way
 * `invokeLocalAgent` makes them, so the relay sees exactly what the webview
 * would.
 */
import {
  toLocalAgentDevice,
  toLocalAgentEnvelope,
  toLocalAgentStatus,
  type LocalAgentDevice,
  type LocalAgentEventEnvelope,
  type LocalAgentResult,
  type LocalAgentRun,
  type LocalAgentStatus,
} from '@/lib/tauri-bridge'
import type { RelayBridge } from '@/lib/local-agent/relay-core'
import type { FakeRustProcess, HostCommand, Reply } from './fake-rust'

const MALFORMED = Symbol('malformed')

function unavailableStatus(reason: string): LocalAgentStatus {
  return { available: false, reason, node: null, agentDir: null, built: false, grants: [], jobs: [] }
}

/** start / resume's `{ jobId, runId }` (tauri-bridge's toLocalAgentRun is private). */
function toRun(raw: unknown, fallbackJobId?: string): LocalAgentRun | null {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const jobId = typeof r.jobId === 'string' && r.jobId ? r.jobId : (fallbackJobId ?? null)
  return jobId ? { jobId, runId: typeof r.runId === 'string' && r.runId ? r.runId : null } : null
}

export interface BridgeCall {
  at: number
  cmd: string
  ok: boolean
  error?: string
}

export function relayBridgeFor(rust: FakeRustProcess, record: (c: BridgeCall) => void = () => {}): RelayBridge {
  async function invoke<T>(cmd: string, command: HostCommand, parse: (raw: unknown) => T | typeof MALFORMED): Promise<LocalAgentResult<T>> {
    const r: Reply<unknown> = await rust.call(command)
    if (!r.ok) {
      record({ at: Date.now(), cmd, ok: false, error: r.error })
      return { ok: false, unavailable: /^unavailable\b/i.test(r.error), error: r.error || `${cmd} failed` }
    }
    const raw = r.value
    if (raw && typeof raw === 'object' && (raw as { available?: unknown }).available === false) {
      const reason = (raw as { reason?: unknown }).reason
      return { ok: false, unavailable: true, error: typeof reason === 'string' && reason ? reason : 'local agents are unavailable' }
    }
    const value = parse(raw)
    if (value === MALFORMED) {
      record({ at: Date.now(), cmd, ok: false, error: 'malformed' })
      return { ok: false, unavailable: false, error: `${cmd}: malformed answer` }
    }
    record({ at: Date.now(), cmd, ok: true })
    return { ok: true, value }
  }
  const ignore = (): void => undefined

  return {
    device: () => invoke<LocalAgentDevice>('local_agent_device', { cmd: 'device' }, (raw) => toLocalAgentDevice(raw) ?? MALFORMED),
    async status() {
      const r = await rust.call<unknown>({ cmd: 'status' })
      if (!r.ok) return unavailableStatus(r.error || 'local_agent_status failed')
      return toLocalAgentStatus(r.value) ?? unavailableStatus('local_agent_status: malformed answer')
    },
    start: (args) => {
      // tauri-bridge's payload: only what is set.
      const payload: Record<string, unknown> = { grantId: args.grantId, request: args.request }
      if (args.jobId) payload.jobId = args.jobId
      if (args.mode) payload.mode = args.mode
      if (args.modelToken) payload.modelToken = args.modelToken
      if (args.resume) payload.resume = { eveSessionId: args.resume.eveSessionId, streamIndex: args.resume.streamIndex }
      return invoke<LocalAgentRun>('local_agent_start', { cmd: 'start', args: payload as never }, (raw) =>
        raw && typeof raw === 'object' ? (toRun(raw) ?? MALFORMED) : MALFORMED,
      )
    },
    resume: (jobId, modelToken) =>
      invoke<LocalAgentRun>('local_agent_resume', { cmd: 'resume', jobId, ...(modelToken ? { modelToken } : {}) }, (raw) => toRun(raw, jobId) ?? MALFORMED),
    send: (jobId, text, policy) => invoke('local_agent_send', { cmd: 'send', jobId, text, policy }, ignore),
    stop: (jobId) => invoke('local_agent_stop', { cmd: 'stop', jobId }, ignore),
    events: (jobId, sinceSeq) =>
      invoke<LocalAgentEventEnvelope[]>('local_agent_events', { cmd: 'events', jobId, sinceSeq }, (raw) => {
        if (!Array.isArray(raw)) return MALFORMED
        return raw
          .map((row) => toLocalAgentEnvelope(row, jobId))
          .filter((row): row is LocalAgentEventEnvelope => row !== null)
          .sort((a, b) => a.seq - b.seq)
      }),
    setModelToken: (jobId, modelToken) => invoke('local_agent_set_model_token', { cmd: 'setModelToken', jobId, modelToken }, ignore),
    onEvent: (cb) =>
      rust.onEvent((payload) => {
        const envelope = toLocalAgentEnvelope(payload)
        if (envelope) cb(envelope)
      }),
  }
}
