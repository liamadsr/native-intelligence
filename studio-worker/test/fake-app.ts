/**
 * A fake app for the tests: the Studio worker's routes of
 * web/src/lib/studio/server/job-contract.ts, in memory, every body checked with
 * the contract's own schemas, and a fake storage beside it that serves the part
 * links (signed with a token of its own, never the worker's secret). Blobs are
 * kept on disk in a folder of their own, as numbered parts.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  BlobCommitBody,
  BlobReadBody,
  BlobWriteBody,
  ClaimBody,
  CompleteBody,
  FailBody,
  ProgressBody,
  blobParts,
  LocalBlobCommitBody,
  LocalBlobReadBody,
  LocalBlobWriteBody,
  LocalCompleteBody,
  LocalFailBody,
  LocalProgressBody,
  LocalTakeBody,
} from '../src/engine.ts'
import type { StudioJobKind } from '../../web/src/lib/studio/server/job-contract.ts'

export interface FakeJob {
  id: string
  kind: StudioJobKind | 'local-export'
  workspaceId: string
  videoId: string | null
  input: unknown
  attempts: number
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  progress: number[]
  logs: string[]
  result?: unknown
  error?: string
  cancelRequested: boolean
  workerId?: string
}

interface BlobMeta {
  bytes: number
  contentType: string
  sha256: string
  partBytes: number
}

export class FakeApp {
  readonly secret: string
  readonly dir: string
  readonly partBytes: number
  readonly jobs: FakeJob[] = []
  readonly blobs = new Map<string, BlobMeta>()
  /** Every request the worker made to the app's routes (path and status), for checks. */
  readonly calls: { path: string; status: number }[] = []
  /** Headers seen on the storage links (to check the secret never goes there). */
  readonly storageAuth: (string | undefined)[] = []
  private readonly pending = new Map<string, BlobMeta & { sha256?: string; jobId: string }>()
  private readonly token = randomBytes(12).toString('hex')
  private server: Server | null = null
  url = ''
  /** When set, the next N requests to the app's routes answer 503 (the app restarting). */
  failNext = 0
  /**
   * The local-export tokens, as the app's signed ones work: each names its job and the attempt it holds (0: minted by
   * the editor, it can only take), and works until it runs out, whichever newer one exists.
   */
  private readonly localTokens = new Map<string, { jobId: string; attempt: number }>()
  /** Every token a local runner presented, in order (to check it always used the newest). */
  readonly localTokensSeen: string[] = []

  constructor(opts: { secret: string; dir: string; partBytes: number }) {
    this.secret = opts.secret
    this.dir = opts.dir
    this.partBytes = opts.partBytes
  }

  async start(): Promise<string> {
    await mkdir(this.dir, { recursive: true })
    this.server = createServer((req, res) => void this.handle(req, res).catch((err) => this.send(res, 500, { error: String(err) })))
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
    const addr = this.server.address()
    if (!addr || typeof addr === 'string') throw new Error('no address')
    this.url = `http://127.0.0.1:${addr.port}`
    return this.url
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()))
  }

  /** A token for a queued local-export job, as the editor gets it (the app's local-token.ts). */
  mintLocal(job: FakeJob, attempt = 0): string {
    const token = `ls1.${randomBytes(16).toString('hex')}`
    this.localTokens.set(token, { jobId: job.id, attempt })
    return token
  }

  /** Tokens run out (the app's last 10 minutes): every token of this job, now. */
  expireLocal(job: FakeJob): void {
    for (const [t, v] of this.localTokens) if (v.jobId === job.id) this.localTokens.delete(t)
  }

  queue(kind: StudioJobKind | 'local-export', input: unknown, opts: { videoId?: string } = {}): FakeJob {
    const job: FakeJob = { id: randomUUID(), kind, workspaceId: randomUUID(), videoId: opts.videoId ?? null, input, attempts: 0, status: 'queued', progress: [], logs: [], cancelRequested: false }
    this.jobs.push(job)
    return job
  }

  /** Store a local file as a blob (what a browser upload does). */
  async putBlob(key: string, file: string, contentType = 'application/octet-stream'): Promise<BlobMeta> {
    const buf = await readFile(file)
    const meta: BlobMeta = { bytes: buf.length, contentType, sha256: createHash('sha256').update(buf).digest('hex'), partBytes: this.partBytes }
    for (const part of blobParts(buf.length, this.partBytes)) {
      const start = part.index * this.partBytes
      await mkdir(this.partDir(key), { recursive: true })
      await writeFile(join(this.partDir(key), String(part.index)), buf.subarray(start, start + part.bytes))
    }
    this.blobs.set(key, meta)
    return meta
  }

  /** A blob joined into one file. */
  async blobFile(key: string, out: string): Promise<string> {
    const meta = this.blobs.get(key)
    if (!meta) throw new Error(`no blob ${key}`)
    const chunks = await Promise.all(blobParts(meta.bytes, meta.partBytes).map((p) => readFile(join(this.partDir(key), String(p.index)))))
    await writeFile(out, Buffer.concat(chunks))
    return out
  }

  async waitFor(job: FakeJob, timeoutMs: number): Promise<FakeJob> {
    const until = Date.now() + timeoutMs
    while (job.status === 'queued' || job.status === 'running') {
      if (Date.now() > until) throw new Error(`job ${job.kind} ${job.id} still ${job.status} after ${timeoutMs} ms`)
      await new Promise((r) => setTimeout(r, 200))
    }
    return job
  }

  private partDir(key: string) {
    return join(this.dir, 'blobs', encodeURIComponent(key))
  }

  private send(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  private async body(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    return Buffer.concat(chunks)
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.url)
    if (url.pathname.startsWith('/fake-storage/')) return this.storage(req, res, url)
    if (url.pathname.startsWith('/api/local-agent/studio-export/')) return this.local(req, res, url)
    const path = url.pathname.replace(/^\/api\/internal\/studio\//, '')
    const reply = (status: number, body: unknown) => {
      this.calls.push({ path, status })
      this.send(res, status, body)
    }
    if (req.method !== 'POST' || !url.pathname.startsWith('/api/internal/studio/')) return reply(404, { error: 'Not found' })
    if (req.headers.authorization !== `Bearer ${this.secret}`) return reply(401, { error: 'Unauthorized', code: 'UNAUTHORIZED' })
    if (this.failNext > 0) {
      this.failNext--
      return reply(503, { error: 'Restarting' })
    }
    const raw = JSON.parse((await this.body(req)).toString('utf8') || '{}')
    const job = (id: string) => this.jobs.find((j) => j.id === id)

    if (path === 'jobs/claim') {
      const b = ClaimBody.parse(raw)
      const next = this.jobs.find((j) => j.status === 'queued' && j.kind !== 'local-export' && b.kinds.includes(j.kind))
      if (!next) return reply(200, { job: null })
      next.status = 'running'
      next.attempts++
      next.workerId = b.workerId
      const { id, kind, workspaceId, videoId, input, attempts } = next
      return reply(200, { job: { id, kind, workspaceId, videoId, input, attempts } })
    }
    const m = /^jobs\/([^/]+)\/(progress|complete|fail)$/.exec(path)
    if (m) {
      const j = job(m[1]!)
      if (!j) return reply(404, { error: 'No such job' })
      if (m[2] === 'progress') {
        const b = ProgressBody.parse(raw)
        j.progress.push(b.progress)
        if (b.log) j.logs.push(...b.log.split('\n'))
        return reply(200, { cancelRequested: j.cancelRequested })
      }
      if (m[2] === 'complete') {
        const b = CompleteBody.parse(raw)
        j.status = 'completed'
        j.result = b.result
        return reply(200, { ok: true })
      }
      const b = FailBody.parse(raw)
      j.status = j.cancelRequested ? 'cancelled' : 'failed'
      j.error = b.error
      return reply(200, { ok: true })
    }
    if (path === 'blobs/read') {
      const b = BlobReadBody.parse(raw)
      if (!job(b.jobId)) return reply(403, { error: 'Not your job' })
      const meta = this.blobs.get(b.key)
      if (!meta) return reply(404, { error: 'No such blob', code: 'BLOB_NOT_FOUND' })
      return reply(200, {
        key: b.key,
        bytes: meta.bytes,
        contentType: meta.contentType,
        sha256: meta.sha256,
        parts: blobParts(meta.bytes, meta.partBytes).map((p) => ({ ...p, url: `${this.url}/fake-storage/${encodeURIComponent(b.key)}/${p.index}?token=${this.token}` })),
      })
    }
    if (path === 'blobs/write') {
      const b = BlobWriteBody.parse(raw)
      if (!job(b.jobId)) return reply(403, { error: 'Not your job' })
      this.pending.set(b.key, { bytes: b.bytes, contentType: b.contentType, sha256: b.sha256 ?? '', partBytes: this.partBytes, jobId: b.jobId })
      return reply(200, {
        key: b.key,
        partBytes: this.partBytes,
        parts: blobParts(b.bytes, this.partBytes).map((p) => ({
          ...p,
          url: `${this.url}/fake-storage/${encodeURIComponent(b.key)}/${p.index}?token=${this.token}`,
          headers: { 'content-type': 'application/octet-stream', 'x-upsert': 'true' },
        })),
      })
    }
    if (path === 'blobs/commit') {
      const b = BlobCommitBody.parse(raw)
      const p = this.pending.get(b.key)
      if (!p || p.jobId !== b.jobId) return reply(409, { error: 'Nothing written under that key' })
      const hash = createHash('sha256')
      for (const part of blobParts(p.bytes, this.partBytes)) {
        const file = join(this.partDir(b.key), String(part.index))
        const s = await stat(file).catch(() => null)
        if (!s || s.size !== part.bytes) return reply(409, { error: `Part ${part.index} missing or the wrong size` })
        hash.update(await readFile(file))
      }
      const sha256 = hash.digest('hex')
      if (p.sha256 && p.sha256 !== sha256) return reply(409, { error: 'Bytes differ from the stated sha256' })
      this.blobs.set(b.key, { bytes: p.bytes, contentType: p.contentType, sha256, partBytes: this.partBytes })
      this.pending.delete(b.key)
      return reply(200, { ok: true })
    }
    return reply(404, { error: 'Not found' })
  }

  /** The local-export routes (job-contract.ts, "the person's own computer"), with the contract's strict bodies. */
  private async local(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const op = url.pathname.replace(/^\/api\/local-agent\/studio-export\//, '')
    const reply = (status: number, body: unknown) => { this.calls.push({ path: `local/${op}`, status }); this.send(res, status, body) }
    if (req.method !== 'POST') return reply(405, { error: 'Method' })
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? ''
    this.localTokensSeen.push(token)
    const held = this.localTokens.get(token)
    const j = this.jobs.find((x) => x.id === held?.jobId)
    if (!j || !held || j.kind !== 'local-export') return reply(401, { error: 'Unauthorized', code: 'UNAUTHORIZED' })
    const raw = JSON.parse((await this.body(req)).toString('utf8') || '{}')
    const fresh = () => ({ token: this.mintLocal(j, j.attempts), expiresAt: new Date(Date.now() + 600_000).toISOString() })
    // The editor's token only takes; a taken one only works its own attempt.
    if ((op === 'take') !== (held.attempt === 0) || (held.attempt > 0 && held.attempt !== j.attempts)) return reply(409, { error: 'Not held', code: 'NOT_HELD' })
    const own = `exports/${j.id}/${j.attempts}/video.mp4`
    if (op === 'take') {
      LocalTakeBody.parse(raw)
      if (j.status !== 'queued') return reply(409, { error: 'Not queued', code: 'NOT_QUEUED' })
      j.status = 'running'
      j.attempts++
      const { id, kind, workspaceId, videoId, input, attempts } = j
      return reply(200, { job: { id, kind, workspaceId, videoId, input, attempts }, ...fresh() })
    }
    if (j.status !== 'running') return reply(409, { error: 'Not held', code: 'NOT_HELD' })
    if (op === 'progress') {
      const b = LocalProgressBody.parse(raw)
      j.progress.push(b.progress)
      if (b.log) j.logs.push(...b.log.split('\n'))
      return reply(200, { cancelRequested: j.cancelRequested, ...fresh() })
    }
    if (op === 'complete') {
      const b = LocalCompleteBody.parse(raw)
      if (b.result.key !== own || !this.blobs.has(own)) return reply(422, { error: 'The file is not right', code: 'RESULT_REFUSED' })
      j.status = 'completed'
      j.result = b.result
      return reply(200, { ok: true })
    }
    if (op === 'fail') {
      const b = LocalFailBody.parse(raw)
      j.status = j.cancelRequested ? 'cancelled' : 'failed'
      j.error = b.error
      return reply(200, { ok: true })
    }
    if (op === 'blobs/read') {
      const b = LocalBlobReadBody.parse(raw)
      const named = (j.input as { project: { assets: { file: string }[] }; fonts?: { file: string }[] })
      if (![...named.project.assets.map((a) => a.file), ...(named.fonts ?? []).map((f) => f.file)].includes(b.key)) return reply(409, { error: 'Not yours', code: 'NOT_YOURS' })
      const meta = this.blobs.get(b.key)
      if (!meta) return reply(404, { error: 'No such blob', code: 'BLOB_NOT_FOUND' })
      return reply(200, { key: b.key, bytes: meta.bytes, contentType: meta.contentType, sha256: meta.sha256,
        parts: blobParts(meta.bytes, meta.partBytes).map((p) => ({ ...p, url: `${this.url}/fake-storage/${encodeURIComponent(b.key)}/${p.index}?token=${this.token}` })) })
    }
    if (op === 'blobs/write') {
      const b = LocalBlobWriteBody.parse(raw)
      if (b.key !== own) return reply(409, { error: 'Not yours', code: 'NOT_YOURS' })
      this.pending.set(b.key, { bytes: b.bytes, contentType: b.contentType, sha256: '', partBytes: this.partBytes, jobId: j.id })
      return reply(200, { key: b.key, partBytes: this.partBytes, parts: blobParts(b.bytes, this.partBytes).map((p) => ({ ...p,
        url: `${this.url}/fake-storage/${encodeURIComponent(b.key)}/${p.index}?token=${this.token}`, headers: { 'content-type': 'application/octet-stream' } })) })
    }
    if (op === 'blobs/commit') {
      const b = LocalBlobCommitBody.parse(raw)
      const p = this.pending.get(b.key)
      if (!p || p.jobId !== j.id) return reply(409, { error: 'Nothing written under that key' })
      const first = await readFile(join(this.partDir(b.key), '0')).catch(() => Buffer.alloc(0))
      if (first.toString('latin1', 4, 8) !== 'ftyp') return reply(422, { error: 'Not an MP4', code: 'NOT_MP4' })
      const hash = createHash('sha256')
      for (const part of blobParts(p.bytes, this.partBytes)) hash.update(await readFile(join(this.partDir(b.key), String(part.index))))
      this.blobs.set(b.key, { bytes: p.bytes, contentType: p.contentType, sha256: hash.digest('hex'), partBytes: this.partBytes })
      this.pending.delete(b.key)
      return reply(200, { ok: true })
    }
    return reply(404, { error: 'Not found' })
  }

  private async storage(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    this.storageAuth.push(req.headers.authorization)
    if (url.searchParams.get('token') !== this.token) return this.send(res, 403, { error: 'Bad signature' })
    const [, , key, index] = url.pathname.split('/')
    const file = join(this.dir, 'blobs', key!, index!)
    if (req.method === 'GET') {
      const buf = await readFile(file).catch(() => null)
      if (!buf) return this.send(res, 404, { error: 'No such part' })
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(buf.length) })
      res.end(buf)
      return
    }
    if (req.method === 'PUT') {
      const buf = await this.body(req)
      await mkdir(join(this.dir, 'blobs', key!), { recursive: true })
      await writeFile(file, buf)
      return this.send(res, 200, { ok: true })
    }
    this.send(res, 405, { error: 'Method' })
  }
}
