/**
 * Enrollment embedder — a PRIVATE WavLM worker for the "Teach Native Intelligence your voice"
 * flow.
 *
 * The enrollment flow must NOT go through `VoiceIdService.preloadedWorker`: that
 * is a single static, shared worker with an ownership hand-off protocol
 * (initialize()/stop()), and taking it would break/race any concurrent live
 * recording. So enrollment spins up its OWN `Worker` and terminates it on
 * unmount. Model weights are IndexedDB-cached, so this second worker loads fast
 * after the first download; the `'load'` ack drives the intro step's loading
 * gate.
 *
 * Format is on us: the worker validates nothing and assumes 16 kHz mono Float32
 * [-1,1]. Callers feed already-converted Float32 chunks (the recorder hook does
 * the Int16→Float32 conversion). Every returned embedding is asserted to have
 * length EMBEDDING_DIM before use — `cosineSimilarity` silently truncates
 * mismatched dims, so a wrong-shaped embedding would score garbage.
 */

import { EMBEDDING_DIM } from './types'
import type {
  WorkerRequest,
  WorkerResponse,
} from '@/workers/voice-embedding-worker'

/** Load state of the private worker. */
export type EmbedderState = 'idle' | 'loading' | 'ready' | 'error'

/**
 * Owns one private embedding worker for the enrollment session. Construct once
 * per flow, `load()` on intro mount, `embed()` each chunk, `terminate()` on
 * unmount. Not reused across flows — a fresh instance per enrollment.
 */
export class EnrollmentEmbedder {
  private worker: Worker | null = null
  private loadPromise: Promise<void> | null = null
  private requestCounter = 0
  private pending = new Map<string, { resolve: (v: number[]) => void; reject: (e: Error) => void }>()
  private _state: EmbedderState = 'idle'
  private terminated = false

  /** Current load state (drives the intro CTA's "Getting ready…" gate). */
  get state(): EmbedderState {
    return this._state
  }

  /**
   * Spin up the worker and load the model. Resolves on the `'loaded'` ack. Safe
   * to call more than once — subsequent calls await the same load. Rejects (and
   * flips state to 'error') if the worker emits a load error, so the intro step
   * can offer a retry.
   */
  load(): Promise<void> {
    if (this.terminated) return Promise.reject(new Error('Embedder terminated'))
    if (this._state === 'ready') return Promise.resolve()
    if (this.loadPromise) return this.loadPromise

    // A retry after a failed load: the old worker (and its WASM heap) is still
    // alive, so end it before spawning the next one.
    this.worker?.terminate()
    this.worker = null

    this._state = 'loading'
    this.loadPromise = new Promise<void>((resolve, reject) => {
      let worker: Worker
      try {
        worker = new Worker(
          new URL('../../workers/voice-embedding-worker.ts', import.meta.url),
          { type: 'module' },
        )
      } catch (err) {
        this._state = 'error'
        this.loadPromise = null
        reject(err instanceof Error ? err : new Error(String(err)))
        return
      }
      this.worker = worker

      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const msg = event.data
        if (msg.type === 'loaded') {
          if (this.terminated) return
          this._state = 'ready'
          resolve()
          return
        }
        if (msg.type === 'embedding') {
          const entry = msg.id ? this.pending.get(msg.id) : undefined
          if (entry) {
            this.pending.delete(msg.id)
            entry.resolve(msg.embedding)
          }
          return
        }
        if (msg.type === 'error') {
          const message = msg.error || 'Worker error'
          // A load-time error (no id) fails load(); an embed error rejects that
          // one request without tearing down the worker.
          if (msg.id && this.pending.has(msg.id)) {
            const entry = this.pending.get(msg.id)!
            this.pending.delete(msg.id)
            entry.reject(new Error(message))
          } else if (this._state === 'loading') {
            this._state = 'error'
            this.loadPromise = null
            reject(new Error(message))
          }
        }
      }

      worker.onerror = (event: ErrorEvent) => {
        const message = event.message || 'Worker crashed'
        if (this._state === 'loading') {
          this._state = 'error'
          this.loadPromise = null
          reject(new Error(message))
        }
        // Fail every in-flight embed so callers don't hang.
        for (const [, entry] of this.pending) entry.reject(new Error(message))
        this.pending.clear()
      }

      this.postLoad(worker)
    })

    return this.loadPromise
  }

  private postLoad(worker: Worker): void {
    worker.postMessage({ type: 'load' } satisfies WorkerRequest)
  }

  /**
   * Embed one 16 kHz mono Float32 [-1,1] chunk. Resolves to a length-
   * EMBEDDING_DIM unit vector; rejects if the model isn't ready, the worker
   * errored, or the returned embedding has the wrong dimensionality.
   */
  async embed(audio: Float32Array): Promise<number[]> {
    if (this.terminated || !this.worker) throw new Error('Embedder not loaded')
    if (this._state !== 'ready') {
      // Await the load rather than failing — the recorder may embed the moment a
      // chunk lands, which can beat the ack by a frame.
      await this.load()
    }
    const worker = this.worker
    if (!worker) throw new Error('Embedder not loaded')

    const id = `embed-${++this.requestCounter}`
    const embedding = await new Promise<number[]>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      // The worker takes the Float32Array by reference; transfer its buffer to
      // avoid a copy (the caller must not reuse the buffer after this).
      worker.postMessage({ type: 'embed', id, audio } satisfies WorkerRequest, [
        audio.buffer,
      ])
    })

    if (embedding.length !== EMBEDDING_DIM) {
      throw new Error(
        `Embedding has wrong dimensionality: ${embedding.length} (expected ${EMBEDDING_DIM})`,
      )
    }
    return embedding
  }

  /** Terminate the worker and reject any in-flight requests. Idempotent. */
  terminate(): void {
    this.terminated = true
    this._state = 'idle'
    for (const [, entry] of this.pending) entry.reject(new Error('Embedder terminated'))
    this.pending.clear()
    if (this.worker) {
      this.worker.onmessage = null
      this.worker.onerror = null
      this.worker.terminate()
      this.worker = null
    }
    this.loadPromise = null
  }
}
