/**
 * The worker's side of the app: the job routes and the blob routes of
 * web/src/lib/studio/server/job-contract.ts (the contract: what each request
 * carries and what each answer means). Every request to the app carries the
 * worker's secret; the links the app signs for a blob's parts get nothing but
 * their own bytes (they may point at storage, not the app).
 *
 * A request that fails on the way (no answer, 408, 429, 5xx) is sent again with
 * a growing wait, a few times; any other answer is final. The secret is never in
 * an error or a log line.
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { backoffMs, sleep } from './backoff.ts'
import type { BlobRead, BlobWrite, ClaimedJob, StudioJobKind } from '../../web/src/lib/studio/server/job-contract.ts'

/** A request the app did not take. `retry`: it may take it later (the app or the network failed). */
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

export interface RetryOptions {
  attempts: number
  baseMs: number
  maxMs: number
}

const DEFAULT_RETRY: RetryOptions = { attempts: 5, baseMs: 500, maxMs: 10_000 }

/** Run `fn` until it succeeds, an error says not to retry, or the attempts run out. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      const retry = err instanceof AppError ? err.retry : false
      if (!retry || attempt + 1 >= opts.attempts || signal?.aborted) throw err
      await sleep(backoffMs(attempt, opts), signal)
    }
  }
}

/** Where each part of a file of `bytes` starts and ends, cut every `partBytes` (an empty file is one empty part). */
export function partRanges(bytes: number, partBytes: number): { index: number; start: number; end: number }[] {
  if (!(partBytes > 0)) throw new Error('partBytes must be positive')
  const count = Math.max(1, Math.ceil(bytes / partBytes))
  return Array.from({ length: count }, (_, index) => ({ index, start: index * partBytes, end: Math.min(bytes, (index + 1) * partBytes) }))
}

export class AppClient {
  private readonly base: string
  private readonly secret: string
  private readonly workerId: string
  private readonly fetchImpl: Fetch
  private readonly retry: RetryOptions
  /** What this worker can do beyond media work, said on every claim and progress report (./providers/capabilities.ts). */
  private readonly capabilities?: () => string[]

  constructor(opts: { appUrl: string; secret: string; workerId: string; fetch?: Fetch; retry?: Partial<RetryOptions>; capabilities?: () => string[] }) {
    this.base = opts.appUrl.replace(/\/+$/, '')
    this.secret = opts.secret
    this.workerId = opts.workerId
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init))
    this.retry = { ...DEFAULT_RETRY, ...opts.retry }
    this.capabilities = opts.capabilities
  }

  /** The capabilities field of a claim or progress body (absent when this client says nothing). */
  private said(): Record<string, unknown> {
    return this.capabilities ? { capabilities: this.capabilities() } : {}
  }

  /** One POST to the app, once. */
  private async postOnce<T>(path: string, body: Record<string, unknown>): Promise<T> {
    let res: Response
    try {
      res = await this.fetchImpl(`${this.base}/api/internal/studio/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.secret}` },
        body: JSON.stringify({ workerId: this.workerId, ...body }),
        signal: AbortSignal.timeout(30_000),
      })
    } catch (err) {
      throw new AppError(`${path}: unreachable (${err instanceof Error ? err.message : String(err)})`.slice(0, 200), 0, null)
    }
    const text = await res.text().catch(() => '')
    if (!res.ok) {
      let code: string | null = null
      let detail = ''
      try {
        const parsed = JSON.parse(text) as { code?: string; error?: string }
        code = parsed.code ?? null
        detail = typeof parsed.error === 'string' ? `: ${parsed.error.slice(0, 200)}` : ''
      } catch {
        // not JSON: the status says enough
      }
      throw new AppError(`${path} answered ${res.status}${detail}`, res.status, code)
    }
    try {
      return JSON.parse(text) as T
    } catch {
      throw new AppError(`${path} answered something that is not JSON`, 502, null)
    }
  }

  private post<T>(path: string, body: Record<string, unknown>, opts: { retry?: boolean } = {}): Promise<T> {
    return opts.retry === false ? this.postOnce<T>(path, body) : withRetry(() => this.postOnce<T>(path, body), this.retry)
  }

  /** The next job of these kinds, or null. Not retried here: the loop asks again anyway. */
  async claim(kinds: readonly StudioJobKind[]): Promise<ClaimedJob | null> {
    const out = await this.post<{ job?: ClaimedJob | null }>('jobs/claim', { kinds: [...kinds], ...this.said() }, { retry: false })
    return out.job ?? null
  }

  /** How far along a job is (0 to 1), with an optional log line; the answer says whether someone asked to cancel it. */
  async progress(jobId: string, progress: number, log?: string): Promise<{ cancelRequested: boolean }> {
    const body: Record<string, unknown> = { progress: Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0)), ...this.said() }
    if (log) body.log = log.slice(0, 2000)
    const out = await this.post<{ cancelRequested?: boolean }>(`jobs/${jobId}/progress`, body)
    return { cancelRequested: out.cancelRequested === true }
  }

  async complete(jobId: string, result: unknown): Promise<void> {
    await this.post(`jobs/${jobId}/complete`, { result })
  }

  async fail(jobId: string, error: string): Promise<void> {
    await this.post(`jobs/${jobId}/fail`, { error: (error.trim() || 'Failed').slice(0, 4000) })
  }

  /**
   * Download blob `key` into `dest`: every part in order, each checked for its
   * length, the whole checked against the sha256 the app knows (or `expectSha256`).
   * Written beside `dest` first and moved there once whole, so `dest` is never half a file.
   */
  async readBlob(jobId: string, key: string, dest: string, opts: { expectSha256?: string; signal?: AbortSignal } = {}): Promise<{ bytes: number; sha256: string; contentType: string }> {
    const read = await this.post<BlobRead>('blobs/read', { jobId, key })
    const parts = [...read.parts].sort((a, b) => a.index - b.index)
    if (parts.length === 0 || parts.some((p, i) => p.index !== i)) throw new Error(`Blob ${key} has missing parts`)
    const want = opts.expectSha256 ?? read.sha256 ?? null
    if (opts.expectSha256 && read.sha256 && opts.expectSha256 !== read.sha256) throw new Error(`Blob ${key} is not the file the job names (sha256 differs)`)
    await mkdir(dirname(dest), { recursive: true })
    const partial = `${dest}.${process.pid}.${Date.now().toString(36)}.part`
    const hash = createHash('sha256')
    let total = 0
    try {
      const out = await open(partial, 'w')
      try {
        for (const part of parts) {
          // A part is fetched whole before it is written, so a retry never leaves half of one in the file.
          const buf = await withRetry(() => this.downloadPart(part.url, part.bytes, opts.signal), this.retry, opts.signal)
          hash.update(buf)
          await out.write(buf)
          total += buf.length
        }
      } finally {
        await out.close()
      }
      if (total !== read.bytes) throw new Error(`Blob ${key} is ${total} bytes, the app says ${read.bytes}`)
      const sha256 = hash.digest('hex')
      if (want && sha256 !== want) throw new Error(`Blob ${key} does not match its sha256`)
      await rename(partial, dest)
      return { bytes: total, sha256, contentType: read.contentType }
    } catch (err) {
      await rm(partial, { force: true })
      throw err
    }
  }

  private async downloadPart(url: string, bytes: number, signal?: AbortSignal): Promise<Buffer> {
    let res: Response
    try {
      res = await this.fetchImpl(new URL(url, this.base).toString(), { method: 'GET', signal: partSignal(signal) })
    } catch (err) {
      if (signal?.aborted) throw err
      throw new AppError(`part download unreachable (${err instanceof Error ? err.message : String(err)})`.slice(0, 200), 0, null)
    }
    if (!res.ok) throw new AppError(`part download answered ${res.status}`, res.status, null)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length !== bytes) throw new AppError(`part is ${buf.length} bytes, expected ${bytes}`, 502, null)
    return buf
  }

  /**
   * Upload `file` as blob `key`: the app gives a link per part, each part is PUT
   * with the headers it names, then the blob is committed. Returns its size.
   */
  async writeBlob(jobId: string, key: string, file: string, contentType: string, opts: { sha256?: string; signal?: AbortSignal } = {}): Promise<{ bytes: number }> {
    const bytes = (await stat(file)).size
    const write = await this.post<BlobWrite & { exists?: boolean }>('blobs/write', { jobId, key, bytes, contentType, ...(opts.sha256 ? { sha256: opts.sha256 } : {}) })
    // Not in the contract today: an app that already holds this content-addressed key may say so, and nothing is sent again.
    if (write.exists === true) return { bytes }
    const ranges = partRanges(bytes, write.partBytes)
    const parts = [...write.parts].sort((a, b) => a.index - b.index)
    if (parts.length !== ranges.length || parts.some((p, i) => p.index !== i || p.bytes !== ranges[i]!.end - ranges[i]!.start)) {
      throw new Error(`The app cut ${key} into parts that do not match its size (${parts.length} parts for ${bytes} bytes)`)
    }
    const fh = await open(file, 'r')
    try {
      for (const part of parts) {
        const range = ranges[part.index]!
        const buf = Buffer.alloc(range.end - range.start)
        if (buf.length > 0) await fh.read(buf, 0, buf.length, range.start)
        await withRetry(() => this.uploadPart(part.url, part.headers, buf, opts.signal), this.retry, opts.signal)
      }
    } finally {
      await fh.close()
    }
    await this.post('blobs/commit', { jobId, key })
    return { bytes }
  }

  private async uploadPart(url: string, headers: Record<string, string>, buf: Buffer, signal?: AbortSignal): Promise<void> {
    let res: Response
    try {
      res = await this.fetchImpl(new URL(url, this.base).toString(), {
        method: 'PUT',
        headers: { 'content-length': String(buf.length), ...headers },
        body: new Uint8Array(buf.buffer as ArrayBuffer, buf.byteOffset, buf.length),
        signal: partSignal(signal),
      })
    } catch (err) {
      if (signal?.aborted) throw err
      throw new AppError(`part upload unreachable (${err instanceof Error ? err.message : String(err)})`.slice(0, 200), 0, null)
    }
    await res.arrayBuffer().catch(() => undefined)
    if (!res.ok) throw new AppError(`part upload answered ${res.status}`, res.status, null)
  }
}

/** A part's transfer gives up after ten minutes, or when the job does. */
function partSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(10 * 60_000)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

/** The sha256 of a file, streamed. */
export async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}
