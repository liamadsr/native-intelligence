/**
 * Gemini Embedding 2 — multimodal embedding service.
 *
 * Routes through the Vercel AI Gateway via the AI SDK's Google provider,
 * giving us the same cost tracking (providerMetadata.gateway.marketCost)
 * and observability as all other AI calls in the app.
 *
 * Used for embedding PDFs and images (PNG/JPEG) multimodally, and — since
 * slice 0 of context packages — extracted ATTACHMENT text via embedText, so
 * text chunks land in the same 3072-d space the attachment search RPC
 * queries. Document/claim text embeddings elsewhere stay on OpenAI
 * text-embedding-3-small for cost reasons ($0.02/M vs $0.20/M); attachment
 * text pays Gemini rates to share the attachment vector space.
 */

import { embed as aiEmbed } from 'ai'
import { google } from '@ai-sdk/google'
import { logUsage, extractGatewayCost } from '@/lib/ai/auth'
import { gatewayTelemetry } from '@/lib/ai/gateway-telemetry'

const GEMINI_EMBEDDING_MODEL = 'gemini-embedding-2-preview'
const GEMINI_EMBEDDING_MODEL_DISPLAY = 'gemini-embedding-2'

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB

/**
 * Core function: embed a value with optional multimodal content via the Gateway.
 */
async function geminiEmbed(
  textValue: string,
  taskType: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY',
  inlineContent?: { mimeType: string; data: string }[],
  userId?: string,
  feature?: string,
): Promise<number[]> {
  const startTime = Date.now()

  const model = google.embedding(GEMINI_EMBEDDING_MODEL)

  // Compose two sibling providerOptions keys: the existing `google` embedding
  // options and (Phase A) the `gateway` per-user attribution key. gatewayTelemetry
  // returns `{ providerOptions: { gateway } }` when the flag is on and `{}` when
  // off, so we pull `.providerOptions?.gateway` out and spread it beside `google`.
  const gatewayOpts = gatewayTelemetry(userId, feature || 'embed_attachment').providerOptions?.gateway
  const providerOptions = {
    google: {
      taskType,
      ...(inlineContent?.length
        ? {
            content: [
              inlineContent.map((item) => ({
                inlineData: { mimeType: item.mimeType, data: item.data },
              })),
            ],
          }
        : {}),
    },
    ...(gatewayOpts ? { gateway: gatewayOpts } : {}),
  }

  const result = await aiEmbed({
    model,
    value: textValue,
    providerOptions,
  })

  if (userId) {
    await logUsage(userId, {
      provider: 'google',
      model: GEMINI_EMBEDDING_MODEL_DISPLAY,
      feature: feature || 'embed_attachment',
      inputTokens: Number(result.usage?.tokens) || 0,
      outputTokens: 0,
      durationMs: Date.now() - startTime,
      costUsd: extractGatewayCost({ providerMetadata: result.providerMetadata }),
    })
  }

  return result.embedding
}

/**
 * Embed a single image (PNG or JPEG).
 */
export async function embedImage(
  imageBytes: Buffer,
  mimeType: string,
  userId?: string,
): Promise<number[]> {
  if (imageBytes.length > MAX_FILE_SIZE) {
    throw new Error(`Image too large for embedding (${imageBytes.length} bytes, max ${MAX_FILE_SIZE})`)
  }

  return geminiEmbed(
    'image',
    'RETRIEVAL_DOCUMENT',
    [{ mimeType, data: imageBytes.toString('base64') }],
    userId,
    'embed_attachment_image',
  )
}

/**
 * Embed a PDF document.
 */
export async function embedPdf(
  pdfBytes: Buffer,
  userId?: string,
): Promise<number[]> {
  if (pdfBytes.length > MAX_FILE_SIZE) {
    throw new Error(`PDF too large for embedding (${pdfBytes.length} bytes, max ${MAX_FILE_SIZE})`)
  }

  return geminiEmbed(
    'document',
    'RETRIEVAL_DOCUMENT',
    [{ mimeType: 'application/pdf', data: pdfBytes.toString('base64') }],
    userId,
    'embed_attachment_pdf',
  )
}

/**
 * Embed extracted attachment text (a chunk of a docx/pptx/pdf-text-layer/
 * plain-text file) at 3072 dimensions — the SAME space as the multimodal
 * vectors, so the existing attachment search RPC matches text chunks and
 * image/pdf chunks interchangeably.
 */
export async function embedText(
  text: string,
  userId?: string,
): Promise<number[]> {
  return geminiEmbed(
    text,
    'RETRIEVAL_DOCUMENT',
    undefined,
    userId,
    'embed_attachment_text',
  )
}

/**
 * Embed a text query using Gemini at 3072 dimensions.
 * Used for searching attachment embeddings — the query must be embedded
 * with the same model as the stored vectors.
 */
export async function embedQuery(
  text: string,
  userId?: string,
): Promise<number[]> {
  return geminiEmbed(
    text,
    'RETRIEVAL_QUERY',
    undefined,
    userId,
    'embed_attachment_query',
  )
}

/**
 * File extensions eligible for Gemini MULTIMODAL embedding. This is NOT the
 * attachment-indexing gate — that is INDEXABLE_ATTACHMENT_EXTENSIONS in
 * @/lib/attachments/extract-text, which adds the text-extractable formats.
 */
export const EMBEDDABLE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'pdf'])
