/**
 * The recorder's side of the app: its work (which calls to be in) and the
 * capture feed (web/src/lib/capture-feed/contract.ts has the contract: what
 * each request carries and what each answer means). Every request carries
 * the feed's secret; nothing here retries by itself (./delivery.ts and the
 * main loop do, each as it needs).
 */

export interface Producer {
  kind: string
  id: string
}

/** The kind the recorder names itself on the feed. */
export const PRODUCER_KIND = 'livekit_recorder'

export interface Job {
  callId: string
  room: string
  round: number
  /** A token for this room alone: hidden, a recorder, subscribe only. */
  token: string
}

export interface FeedSession {
  id: string
  /** The feed's clock: every time sent is milliseconds from this. */
  startedAt: string
  round: number
  captureId: string
}

export interface RosterEvent {
  key: string
  speaker: string
  kind: 'joined' | 'left'
  atMs: number
  identity?: { memberId: string } | { guestId: string } | { name: string; email?: string }
}

export interface Segment {
  key: string
  speaker: string
  text: string
  startMs: number
  endMs: number
}

/** A request the app did not take. `retry`: send it again later (the app or the network failed); else it never will be taken. */
export class AppError extends Error {
  readonly status: number
  readonly code: string | null
  readonly retry: boolean
  constructor(message: string, status: number, code: string | null) {
    super(message)
    this.name = 'AppError'
    this.status = status
    this.code = code
    this.retry = status === 0 || status === 408 || status === 429 || status >= 500
  }
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>

export class AppClient {
  private readonly base: string
  private readonly secret: string
  private readonly producer: Producer
  private readonly fetchImpl: Fetch

  constructor(opts: { appUrl: string; secret: string; producer: Producer; fetch?: Fetch }) {
    this.base = opts.appUrl.replace(/\/+$/, '')
    this.secret = opts.secret
    this.producer = opts.producer
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init))
  }

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    let res: Response
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.secret}` },
        body: JSON.stringify({ producer: this.producer, ...body }),
        signal: AbortSignal.timeout(20_000),
      })
    } catch (err) {
      throw new AppError(`unreachable: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200), 0, null)
    }
    const text = await res.text().catch(() => '')
    if (!res.ok) {
      let code: string | null = null
      try {
        code = (JSON.parse(text) as { code?: string }).code ?? null
      } catch {
        // not JSON: the status says enough
      }
      throw new AppError(`${path} answered ${res.status}`, res.status, code)
    }
    try {
      return JSON.parse(text) as T
    } catch {
      throw new AppError(`${path} answered something that is not JSON`, 502, null)
    }
  }

  /** The calls to be in now, besides those running (at most `capacity`). */
  async work(running: readonly string[], capacity: number): Promise<{ jobs: Job[]; pollMs: number }> {
    const out = await this.post<{ jobs?: Job[]; pollMs?: number }>('/api/internal/team-call-recorder/work', { running: [...running], capacity })
    return { jobs: Array.isArray(out.jobs) ? out.jobs : [], pollMs: typeof out.pollMs === 'number' ? out.pollMs : 3000 }
  }

  async start(callId: string): Promise<{ outcome: string; session: FeedSession | null }> {
    const out = await this.post<{ outcome?: string; session?: FeedSession | null }>('/api/internal/capture-feed/start', { source: { kind: 'team_call', ref: callId } })
    return { outcome: out.outcome ?? 'unknown', session: out.session ?? null }
  }

  async heartbeat(sessions: readonly string[]): Promise<Array<{ id: string; keep: boolean; reason: string | null }>> {
    const out = await this.post<{ sessions?: Array<{ id: string; keep: boolean; reason: string | null }> }>('/api/internal/capture-feed/heartbeat', { sessions: [...sessions] })
    return Array.isArray(out.sessions) ? out.sessions : []
  }

  async roster(sessionId: string, events: readonly RosterEvent[]): Promise<Array<{ key: string; outcome: string }>> {
    const out = await this.post<{ results?: Array<{ key: string; outcome: string }> }>(`/api/internal/capture-feed/sessions/${sessionId}/roster`, { events: [...events] })
    return Array.isArray(out.results) ? out.results : []
  }

  async segments(sessionId: string, segments: readonly Segment[]): Promise<{ accepted: number; duplicate: number; dropped: number }> {
    const out = await this.post<{ accepted?: number; duplicate?: number; dropped?: number }>(`/api/internal/capture-feed/sessions/${sessionId}/segments`, { segments: [...segments] })
    return { accepted: out.accepted ?? 0, duplicate: out.duplicate ?? 0, dropped: out.dropped ?? 0 }
  }

  async end(sessionId: string, reason: string): Promise<boolean> {
    const out = await this.post<{ ended?: boolean }>(`/api/internal/capture-feed/sessions/${sessionId}/end`, { reason })
    return out.ended === true
  }
}
