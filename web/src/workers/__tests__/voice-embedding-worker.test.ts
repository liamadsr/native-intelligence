/**
 * THE VOICE-EMBEDDING WORKER LOADS ONLY PINNED, FIRST-PARTY CODE.
 *
 * transformers.js points ONNX Runtime's wasm glue (an ES module the worker
 * imports) at jsdelivr by default, and loads model files from the repo's
 * `main`. Pinned here: the runtime comes from this origin at the bundled
 * runtime's own version (scripts/copy-ort-runtime.mjs puts the files there),
 * and both model loads name one commit.
 *
 * transformers.js is mocked: the real package loads onnxruntime-node in a
 * unit test. The worker's module body runs on import, so `self` is stubbed
 * first and the module imported fresh.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hf = vi.hoisted(() => ({
  env: { backends: { onnx: { wasm: {} as { wasmPaths?: unknown }, versions: { common: '9.9.9', web: '9.9.9-dev.1' } } } },
  processorLoad: vi.fn(async () => vi.fn()),
  modelLoad: vi.fn(async () => vi.fn()),
}))

vi.mock('@huggingface/transformers', () => ({
  env: hf.env,
  AutoProcessor: { from_pretrained: hf.processorLoad },
  AutoModel: { from_pretrained: hf.modelLoad },
}))

type FakeSelf = {
  location: { origin: string }
  postMessage: ReturnType<typeof vi.fn>
  onmessage: ((event: { data: unknown }) => Promise<void>) | null
}

let fakeSelf: FakeSelf

beforeEach(async () => {
  vi.resetModules()
  hf.env.backends.onnx.wasm = {}
  hf.processorLoad.mockClear()
  hf.modelLoad.mockClear()
  // The origin a Turbopack blob: worker reports (blob:https://dial8.ai/<uuid>).
  fakeSelf = { location: { origin: 'https://dial8.ai' }, postMessage: vi.fn(), onmessage: null }
  vi.stubGlobal('self', fakeSelf)
  await import('../voice-embedding-worker')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the voice-embedding worker', () => {
  it("loads ONNX Runtime from this origin, under the bundled runtime's version", () => {
    expect(hf.env.backends.onnx.wasm.wasmPaths).toBe('https://dial8.ai/ort/9.9.9-dev.1/')
  })

  it('loads the processor and the model at one pinned commit, never main', async () => {
    await fakeSelf.onmessage!({ data: { type: 'load' } })

    expect(fakeSelf.postMessage).toHaveBeenCalledWith({ type: 'loaded' })
    expect(hf.processorLoad).toHaveBeenCalledTimes(1)
    expect(hf.modelLoad).toHaveBeenCalledTimes(1)
    const [processorId, processorOptions] = hf.processorLoad.mock.calls[0] as unknown as [string, { revision?: string }]
    const [modelId, modelOptions] = hf.modelLoad.mock.calls[0] as unknown as [string, { revision?: string }]
    expect(processorId).toBe('Xenova/wavlm-base-plus-sv')
    expect(modelId).toBe(processorId)
    // A full commit hash: a branch or tag name could move under us.
    expect(processorOptions.revision).toMatch(/^[0-9a-f]{40}$/)
    expect(modelOptions.revision).toBe(processorOptions.revision)
  })
})
