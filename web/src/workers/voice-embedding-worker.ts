/**
 * Web Worker for speaker embedding generation using Transformers.js.
 *
 * Uses the WavLM model (Xenova/wavlm-base-plus-sv) to produce 512-dim
 * speaker embeddings from 16kHz mono PCM audio. The model is loaded once
 * and cached in the browser (IndexedDB) after the first download (~100MB).
 *
 * The enrollment gallery is sent ONCE via 'set-gallery' (prototypes are
 * several vectors per contact — re-serializing them on every segment would
 * dominate the message cost). Each 'match' request then carries only the
 * audio and the contacts to exclude, and returns the top-ranked candidates
 * (best + runner-up) so the main thread can apply margin-based rejection.
 *
 * All heavy computation runs off the main thread.
 */

import { AutoProcessor, AutoModel, env, type Tensor } from '@huggingface/transformers'
import {
  l2Normalize,
  rankCandidates,
  type GalleryContact,
  type RankedCandidate,
} from '@/lib/voice-id-matching'

// ── Types ────────────────────────────────────────────────────

export interface WorkerLoadRequest {
  type: 'load'
}

export interface WorkerSetGalleryRequest {
  type: 'set-gallery'
  gallery: GalleryContact[]
}

export interface WorkerEmbedRequest {
  type: 'embed'
  id: string
  audio: Float32Array
}

export interface WorkerMatchRequest {
  type: 'match'
  id: string
  audio: Float32Array
  /** Contacts to skip (already assigned to another speaker, or dismissed). */
  excludeContactIds?: string[]
}

export type WorkerRequest =
  | WorkerLoadRequest
  | WorkerSetGalleryRequest
  | WorkerEmbedRequest
  | WorkerMatchRequest

export interface WorkerLoadedResponse {
  type: 'loaded'
}

export interface WorkerEmbeddingResponse {
  type: 'embedding'
  id: string
  embedding: number[]
}

export interface WorkerMatchResponse {
  type: 'match-result'
  id: string
  /** Ranked candidates, best first (empty when no gallery). */
  candidates: RankedCandidate[]
  embedding: number[]
}

export interface WorkerErrorResponse {
  type: 'error'
  id?: string
  error: string
}

export type WorkerResponse =
  | WorkerLoadedResponse
  | WorkerEmbeddingResponse
  | WorkerMatchResponse
  | WorkerErrorResponse

// ── Model state ──────────────────────────────────────────────

const MODEL_ID = 'Xenova/wavlm-base-plus-sv'

/**
 * The model repo's commit (2024-10-08), not `main`: a push to the repo can't
 * change the weights this worker runs. Bump it deliberately.
 */
const MODEL_REVISION = 'e61029603001bd11295c36d878698708bf59190f'

// ONNX Runtime's wasm glue (.mjs, run as a module) and binary come from this
// origin, not transformers.js's default (jsdelivr). scripts/copy-ort-runtime.mjs
// copies them from the installed onnxruntime-web into public/ort/<version>/;
// the version in the path is the bundled runtime's own, so a copy from another
// version 404s rather than loading. Absolute, because Turbopack starts workers
// from a blob: URL, which a root-relative path can't resolve against.
const onnx = env.backends.onnx
onnx.wasm!.wasmPaths = `${self.location.origin}/ort/${onnx.versions!.web}/`

/** How many ranked candidates to return per match (best + runners-up). */
const MAX_CANDIDATES = 3

let processor: Awaited<ReturnType<typeof AutoProcessor.from_pretrained>> | null = null
let model: Awaited<ReturnType<typeof AutoModel.from_pretrained>> | null = null
let gallery: GalleryContact[] = []

// ── Helpers ──────────────────────────────────────────────────

async function loadModel(): Promise<void> {
  if (processor && model) return

  processor = await AutoProcessor.from_pretrained(MODEL_ID, { revision: MODEL_REVISION })
  model = await AutoModel.from_pretrained(MODEL_ID, { revision: MODEL_REVISION })
}

async function generateEmbedding(audio: Float32Array): Promise<number[]> {
  if (!processor || !model) throw new Error('Model not loaded')

  const inputs = await processor(audio)
  const output = await model(inputs) as { embeddings: Tensor }
  const embeddingData = output.embeddings.data as Float32Array

  // Unit-norm at the source: everything downstream (prototype means,
  // cosine scoring, stored enrollments) assumes unit vectors.
  return l2Normalize(Array.from(embeddingData))
}

// ── Message handler ──────────────────────────────────────────

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data

  try {
    switch (msg.type) {
      case 'load': {
        await loadModel()
        self.postMessage({ type: 'loaded' } satisfies WorkerLoadedResponse)
        break
      }

      case 'set-gallery': {
        gallery = msg.gallery.map((c) => ({
          contactId: c.contactId,
          contactName: c.contactName,
          prototypes: c.prototypes.map(l2Normalize),
        }))
        break
      }

      case 'embed': {
        const embedding = await generateEmbedding(msg.audio)
        self.postMessage({
          type: 'embedding',
          id: msg.id,
          embedding,
        } satisfies WorkerEmbeddingResponse)
        break
      }

      case 'match': {
        const embedding = await generateEmbedding(msg.audio)
        const exclude = msg.excludeContactIds?.length
          ? new Set(msg.excludeContactIds)
          : undefined
        const candidates = rankCandidates(embedding, gallery, exclude).slice(0, MAX_CANDIDATES)
        self.postMessage({
          type: 'match-result',
          id: msg.id,
          candidates,
          embedding,
        } satisfies WorkerMatchResponse)
        break
      }
    }
  } catch (err) {
    self.postMessage({
      type: 'error',
      id: 'id' in msg ? (msg as { id: string }).id : undefined,
      error: err instanceof Error ? err.message : String(err),
    } satisfies WorkerErrorResponse)
  }
}
