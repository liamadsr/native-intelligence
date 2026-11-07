import { embed as aiEmbed, embedMany } from 'ai'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logUsage, extractGatewayCost } from '@/lib/ai/auth'
import { gatewayTelemetry } from '@/lib/ai/gateway-telemetry'
import { parseOutline, splitLines } from '@/lib/documents/markdown-structure'

const EMBEDDING_MODEL_SLUG = 'openai/text-embedding-3-small'
const EMBEDDING_MODEL_NAME = 'text-embedding-3-small'
const MAX_BATCH_SIZE = 100
const MAX_CHUNK_SIZE = 500

/**
 * Chunk text into segments for embedding.
 * Splits on sentence boundaries (.!?) with a max size per chunk.
 * Mirrors the Swift EmbeddingService chunking logic.
 */
function chunkText(
  text: string,
  maxSize: number = MAX_CHUNK_SIZE,
): string[] {
  if (!text || text.trim().length === 0) return []
  if (text.length <= maxSize) return [text.trim()]

  const chunks: string[] = []
  // Split on sentence endings
  const sentences = text.split(/(?<=[.!?])\s+/)
  let currentChunk = ''

  for (const sentence of sentences) {
    if (currentChunk.length + sentence.length > maxSize && currentChunk.length > 0) {
      chunks.push(currentChunk.trim())
      currentChunk = sentence
    } else {
      currentChunk += (currentChunk ? ' ' : '') + sentence
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim())
  }

  return chunks.filter((c) => c.length > 0)
}

/**
 * Generate embedding for a single text.
 *
 * Routes through the Vercel AI Gateway. When `userId` is supplied, usage is
 * logged to `ai_usage_logs` with the Gateway-reported marketCost.
 */
export async function embed(text: string, userId?: string, feature = 'embed_single'): Promise<number[]> {
  const startTime = Date.now()

  const result = await aiEmbed({
    model: EMBEDDING_MODEL_SLUG,
    value: text,
    // Per-user Gateway attribution (Phase A). Tagging INSIDE the wrapper covers
    // every embed() call site without touching them. Feature defaults to the
    // logUsage feature below. No-op when GATEWAY_USER_TAGGING is off.
    ...gatewayTelemetry(userId, feature),
  })

  if (userId) {
    await logUsage(userId, {
      provider: 'openai',
      model: EMBEDDING_MODEL_NAME,
      feature,
      inputTokens: result.usage?.tokens ?? 0,
      outputTokens: 0,
      durationMs: Date.now() - startTime,
      costUsd: extractGatewayCost({ providerMetadata: result.providerMetadata }),
    })
  }

  return result.embedding
}

/**
 * Generate embeddings for multiple texts in batches.
 * Respects OpenAI's batch size limits.
 */
export async function batchEmbed(texts: string[], userId?: string, feature = 'embed_batch'): Promise<number[][]> {
  const allEmbeddings: number[][] = []
  const startTime = Date.now()
  let totalTokens = 0
  let totalCost = 0
  let costSeen = false

  for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
    const batch = texts.slice(i, i + MAX_BATCH_SIZE)

    const result = await embedMany({
      model: EMBEDDING_MODEL_SLUG,
      values: batch,
      // Per-user Gateway attribution (Phase A). Applied per batch so every
      // embedMany request carries the tag. No-op when the flag is off.
      ...gatewayTelemetry(userId, feature),
    })

    allEmbeddings.push(...result.embeddings)
    totalTokens += result.usage?.tokens ?? 0

    const batchCost = extractGatewayCost({ providerMetadata: result.providerMetadata })
    if (batchCost !== undefined) {
      totalCost += batchCost
      costSeen = true
    }

    // Small delay between batches to avoid rate limiting
    if (i + MAX_BATCH_SIZE < texts.length) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  if (userId) {
    await logUsage(userId, {
      provider: 'openai',
      model: EMBEDDING_MODEL_NAME,
      feature,
      inputTokens: totalTokens,
      outputTokens: 0,
      durationMs: Date.now() - startTime,
      costUsd: costSeen ? totalCost : undefined,
      metadata: { batchCount: Math.ceil(texts.length / MAX_BATCH_SIZE), textCount: texts.length },
    })
  }

  return allEmbeddings
}

/**
 * Build indexable summary text from capture fields (excludes transcript content).
 * Transcript content is indexed separately with source='transcript' for filtering.
 */
export function buildIndexableText(note: {
  title?: string
  ai_summary?: string
  summary?: string
  content?: string
}): string {
  return [note.title, note.ai_summary || note.summary, note.content]
    .filter(Boolean)
    .join('\n\n')
}

interface TaggedChunk {
  text: string
  source: 'summary' | 'transcript'
}

/**
 * Index a capture: chunk its text, generate embeddings, and swap the capture's
 * chunks in one transaction (replace_capture_chunks, migration 416).
 * Accepts either a plain text string (legacy) or structured fields with source tagging.
 *
 * Embed FIRST and swap after (as indexDocument does): a failed embed must
 * leave the old chunks in place, since a stale index is recoverable and an
 * empty one drops the capture out of search. The swap is serialized per
 * capture, so two overlapping runs can no longer both delete and then both
 * insert (which doubled the capture's chunks).
 */
export async function indexCapture(
  supabase: SupabaseClient,
  captureId: string,
  userId: string,
  projectId: string | null,
  text: string | TaggedChunk[],
  workspaceId: string | null = null,
) {
  // 1. Build tagged chunks
  let taggedChunks: TaggedChunk[]
  if (typeof text === 'string') {
    // Legacy: treat everything as summary
    taggedChunks = chunkText(text, MAX_CHUNK_SIZE).map((t) => ({ text: t, source: 'summary' as const }))
  } else {
    taggedChunks = text.flatMap((entry) =>
      chunkText(entry.text, MAX_CHUNK_SIZE).map((t) => ({ text: t, source: entry.source }))
    )
  }

  // 2. Generate embeddings (none for an emptied capture: its chunks are cleared)
  const embeddings = taggedChunks.length ? await batchEmbed(taggedChunks.map((c) => c.text), userId) : []

  // 3. Replace the old chunks with the new ones, tagged by source
  const rows = taggedChunks.map((chunk, index) => ({
    capture_id: captureId,
    user_id: userId,
    project_id: projectId,
    workspace_id: workspaceId,
    chunk_index: index,
    chunk_text: chunk.text,
    source: chunk.source,
    embedding: JSON.stringify(embeddings[index]),
  }))

  const swap = await supabase.rpc('replace_capture_chunks', {
    p_capture_id: captureId,
    p_workspace_id: workspaceId,
    p_rows: rows,
  })
  if (swap.error && isMissingFunction(swap.error)) {
    // Before migration 416: the old delete-then-insert, still after embedding.
    const { error: deleteError } = await supabase.from('capture_chunks').delete().eq('capture_id', captureId)
    if (deleteError) {
      console.error('Failed to delete old capture chunks:', deleteError)
      throw deleteError
    }
    if (rows.length) {
      const { error } = await supabase.from('capture_chunks').insert(rows)
      if (error) {
        console.error('Failed to insert capture chunks:', error)
        throw error
      }
    }
    return { chunksCreated: rows.length }
  }
  if (swap.error) {
    console.error('Failed to swap capture chunks:', swap.error)
    throw swap.error
  }

  return { chunksCreated: rows.length }
}

/**
 * Documents whose body is shorter than this are not worth embedding: an empty
 * doc or a one-line stub carries no semantic signal and would just add noise
 * (and cost) to hybrid_search's document_vec candidate list. The FTS branch
 * still indexes them (document.fts is a generated column), so they remain
 * findable by keyword — they just skip the vector half.
 */
const MIN_DOCUMENT_INDEX_CHARS = 40

/** One chunk of a document: its text and the heading path it sits under. */
export interface DocumentChunk {
  text: string
  /** "Positioning > Real alternative", or null before the first heading. */
  heading: string | null
}

/**
 * Chunk a markdown document by section: the text under each heading is
 * sentence-split into chunks of at most MAX_CHUNK_SIZE characters, and every
 * chunk carries its heading path, so a match reads as "Positioning > Real
 * alternative" and the section is part of what is embedded. Heading lines
 * themselves are not repeated as text; a section with no text of its own adds
 * nothing (its subsections carry its path). Pure.
 */
export function chunkDocument(markdown: string): DocumentChunk[] {
  const lines = splitLines(markdown)
  const toc = parseOutline(markdown)
  const headingLines = new Set(toc.map((e) => e.line))
  // Split points: the first line, and each heading.
  const starts = [1, ...toc.map((e) => e.line)].filter((v, i, a) => a.indexOf(v) === i)
  const out: DocumentChunk[] = []
  starts.forEach((from, i) => {
    const to = (starts[i + 1] ?? lines.length + 1) - 1
    const section = toc.find((e) => e.line === from) ?? null
    const body = lines
      .slice(from - 1, to)
      .filter((_, k) => !headingLines.has(from + k))
      .join('\n')
      .trim()
    if (!body) return
    const heading = section ? section.path.join(' > ') : null
    for (const text of chunkText(body, MAX_CHUNK_SIZE)) out.push({ text, heading })
  })
  return out
}

/** What a document chunk's vector is made from: its section, then its text. */
export function documentChunkEmbeddingText(chunk: DocumentChunk): string {
  return chunk.heading ? `${chunk.heading}\n\n${chunk.text}` : chunk.text
}

const chunkKey = (c: { text: string; heading: string | null }) => `${c.heading ?? ''}\u0000${c.text}`

/**
 * Index a document: chunk its markdown by section, embed what's new, and swap
 * the document's chunks in one transaction (replace_document_chunks,
 * migration 365). The OpenAI 1536-d space matches capture_chunks /
 * hybrid_search's p_embedding, so these vectors drop straight into
 * hybrid_search's document_vec CTE.
 *
 * Embed first, swap after: if embedding fails nothing is touched and the old
 * vectors stay (a stale index is recoverable, an empty one hides the
 * document). Only chunks whose text or heading changed are embedded; the
 * rest keep the vector they have (the RPC copies it). Best-effort callers
 * (the document write paths) swallow failures.
 *
 * Skips (and clears) when content is empty or trivially short, so a document
 * emptied down to a stub doesn't keep its old vectors.
 */
export async function indexDocument(
  supabase: SupabaseClient,
  documentId: string,
  userId: string,
  projectId: string | null,
  content: string | null | undefined,
  workspaceId: string | null = null,
) {
  const text = (content ?? '').trim()
  const chunks = text.length < MIN_DOCUMENT_INDEX_CHARS ? [] : chunkDocument(text)

  // What the document has now (text and heading only: no vectors read), in
  // its own workspace: chunks never cross workspaces (migration 365).
  let existingQuery = supabase.from('document_chunks').select('chunk_text, heading').eq('document_id', documentId)
  if (workspaceId) existingQuery = existingQuery.eq('workspace_id', workspaceId)
  const { data: existing } = await existingQuery
  const have = new Set(
    ((existing ?? []) as Array<{ chunk_text: string; heading: string | null }>).map((r) => chunkKey({ text: r.chunk_text, heading: r.heading ?? null })),
  )
  if (chunks.length === 0 && have.size === 0) return { chunksCreated: 0, chunksEmbedded: 0 }

  const embedRows = async (all: boolean) => {
    const toEmbed = chunks.filter((c) => all || !have.has(chunkKey(c)))
    const vectors = toEmbed.length ? await batchEmbed(toEmbed.map(documentChunkEmbeddingText), userId) : []
    const byKey = new Map(toEmbed.map((c, i) => [chunkKey(c), vectors[i]]))
    return {
      embedded: toEmbed.length,
      rows: chunks.map((c, index) => {
        const vector = byKey.get(chunkKey(c))
        return { chunk_index: index, chunk_text: c.text, heading: c.heading, embedding: vector ? JSON.stringify(vector) : null }
      }),
    }
  }

  let { rows, embedded } = await embedRows(false)
  let swap = await supabase.rpc('replace_document_chunks', {
    p_document_id: documentId,
    p_workspace_id: workspaceId,
    p_project_id: projectId,
    p_rows: rows,
  })
  if (swap.error && isMissingFunction(swap.error)) {
    // Before migration 365: the old delete-then-insert, still after embedding.
    ;({ rows, embedded } = await embedRows(true))
    await supabase.from('document_chunks').delete().eq('document_id', documentId)
    if (rows.length) {
      const { error } = await supabase.from('document_chunks').insert(
        rows.map((r) => ({ document_id: documentId, workspace_id: workspaceId, project_id: projectId, chunk_index: r.chunk_index, chunk_text: r.chunk_text, embedding: r.embedding })),
      )
      if (error) {
        console.error('Failed to insert document chunks:', error)
        throw error
      }
    }
    return { chunksCreated: rows.length, chunksEmbedded: embedded }
  }
  if (swap.error && !isRefused(swap.error) && embedded < chunks.length) {
    // A chunk it meant to reuse is gone (another re-index swapped in between):
    // embed everything and swap again, once.
    ;({ rows, embedded } = await embedRows(true))
    swap = await supabase.rpc('replace_document_chunks', {
      p_document_id: documentId,
      p_workspace_id: workspaceId,
      p_project_id: projectId,
      p_rows: rows,
    })
  }
  if (swap.error) {
    console.error('Failed to swap document chunks:', swap.error)
    throw swap.error
  }
  return { chunksCreated: chunks.length, chunksEmbedded: embedded }
}

/** The swap refused the call (the document isn't in that workspace): no retry helps. */
function isRefused(error: { code?: string }): boolean {
  return error.code === '42501'
}

/** PostgREST / Postgres: the function isn't there (a migration not yet applied). */
function isMissingFunction(error: { code?: string; message?: string }): boolean {
  return error.code === 'PGRST202' || error.code === '42883'
}
