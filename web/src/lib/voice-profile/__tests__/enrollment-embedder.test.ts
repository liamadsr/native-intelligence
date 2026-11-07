// @vitest-environment jsdom
/**
 * EnrollmentEmbedder — the private-worker wrapper. The load-bearing contracts
 * are: (1) load() resolves on the worker's 'loaded' ack and rejects on a
 * load-time error; (2) embed() rejects when the returned embedding is NOT
 * length EMBEDDING_DIM (a wrong-shaped embedding silently scores garbage
 * downstream); (3) terminate() rejects in-flight requests and is idempotent.
 *
 * The real worker constructs `new Worker(new URL(...))`, which can't run in
 * jsdom — we stub the global Worker with a controllable fake that echoes the
 * messages the test wants.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EMBEDDING_DIM } from '../types'

/** A fake module Worker whose responses the test scripts per message. */
class FakeWorker {
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  posted: unknown[] = []
  static instances: FakeWorker[] = []
  /** Test hook: how to respond to each posted message. */
  static responder: (msg: { type: string; id?: string }, self: FakeWorker) => void = () => {}

  constructor() {
    FakeWorker.instances.push(this)
  }
  postMessage(msg: { type: string; id?: string }) {
    this.posted.push(msg)
    FakeWorker.responder(msg, this)
  }
  emit(data: unknown) {
    this.onmessage?.({ data } as MessageEvent)
  }
  terminated = false
  terminate() {
    this.terminated = true
  }
}

beforeEach(() => {
  FakeWorker.instances = []
  FakeWorker.responder = () => {}
  vi.stubGlobal('Worker', FakeWorker as unknown as typeof Worker)
  // The embedder builds a URL from import.meta.url — jsdom has URL, so fine.
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function importEmbedder() {
  const mod = await import('../enrollment-embedder')
  return mod.EnrollmentEmbedder
}

describe('EnrollmentEmbedder.load', () => {
  it('resolves on the loaded ack and flips state to ready', async () => {
    FakeWorker.responder = (msg, self) => {
      if (msg.type === 'load') queueMicrotask(() => self.emit({ type: 'loaded' }))
    }
    const EnrollmentEmbedder = await importEmbedder()
    const e = new EnrollmentEmbedder()
    expect(e.state).toBe('idle')
    const p = e.load()
    expect(e.state).toBe('loading')
    await p
    expect(e.state).toBe('ready')
  })

  it('rejects and flips to error on a load-time worker error', async () => {
    FakeWorker.responder = (msg, self) => {
      if (msg.type === 'load') queueMicrotask(() => self.emit({ type: 'error', error: 'boom' }))
    }
    const EnrollmentEmbedder = await importEmbedder()
    const e = new EnrollmentEmbedder()
    await expect(e.load()).rejects.toThrow('boom')
    expect(e.state).toBe('error')
  })
})

describe('EnrollmentEmbedder.load retry', () => {
  it('terminates the failed worker before spawning the next one', async () => {
    let attempt = 0
    FakeWorker.responder = (msg, self) => {
      if (msg.type !== 'load') return
      attempt += 1
      const reply = attempt === 1 ? { type: 'error', error: 'offline' } : { type: 'loaded' }
      queueMicrotask(() => self.emit(reply))
    }
    const EnrollmentEmbedder = await importEmbedder()
    const e = new EnrollmentEmbedder()
    await expect(e.load()).rejects.toThrow('offline')
    await e.load()
    expect(FakeWorker.instances).toHaveLength(2)
    expect(FakeWorker.instances[0].terminated).toBe(true)
    expect(FakeWorker.instances[1].terminated).toBe(false)
  })
})

describe('EnrollmentEmbedder.embed', () => {
  async function loaded() {
    FakeWorker.responder = (msg, self) => {
      if (msg.type === 'load') queueMicrotask(() => self.emit({ type: 'loaded' }))
    }
    const EnrollmentEmbedder = await importEmbedder()
    const e = new EnrollmentEmbedder()
    await e.load()
    return e
  }

  it('resolves a correctly-sized embedding', async () => {
    const e = await loaded()
    FakeWorker.responder = (msg, self) => {
      if (msg.type === 'embed') {
        queueMicrotask(() =>
          self.emit({ type: 'embedding', id: msg.id, embedding: new Array(EMBEDDING_DIM).fill(0.1) }),
        )
      }
    }
    const out = await e.embed(new Float32Array(48000))
    expect(out).toHaveLength(EMBEDDING_DIM)
  })

  it('REJECTS an embedding of the wrong dimensionality', async () => {
    const e = await loaded()
    FakeWorker.responder = (msg, self) => {
      if (msg.type === 'embed') {
        queueMicrotask(() =>
          self.emit({ type: 'embedding', id: msg.id, embedding: new Array(256).fill(0.1) }),
        )
      }
    }
    await expect(e.embed(new Float32Array(48000))).rejects.toThrow(/dimensionality/i)
  })

  it('rejects an embed error from the worker without tearing down', async () => {
    const e = await loaded()
    FakeWorker.responder = (msg, self) => {
      if (msg.type === 'embed') {
        queueMicrotask(() => self.emit({ type: 'error', id: msg.id, error: 'embed failed' }))
      }
    }
    await expect(e.embed(new Float32Array(48000))).rejects.toThrow('embed failed')
    expect(e.state).toBe('ready')
  })
})

describe('EnrollmentEmbedder.terminate', () => {
  it('rejects in-flight embeds and is idempotent', async () => {
    FakeWorker.responder = (msg, self) => {
      if (msg.type === 'load') queueMicrotask(() => self.emit({ type: 'loaded' }))
      // Never respond to embed → it stays in-flight until terminate.
    }
    const EnrollmentEmbedder = await importEmbedder()
    const e = new EnrollmentEmbedder()
    await e.load()
    const inflight = e.embed(new Float32Array(48000))
    e.terminate()
    await expect(inflight).rejects.toThrow(/terminated/i)
    expect(() => e.terminate()).not.toThrow()
  })
})
