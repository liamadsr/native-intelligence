import { inngest } from './client'
import { getServiceClient } from '@/lib/admin'
import { guardBackgroundUsageOnPlan } from './usage-guard'
import { embedImage, embedPdf, embedText } from '@/lib/ai/gemini-embeddings'
import {
  chunkText,
  extractAttachmentText,
  TEXT_EXTRACTABLE_EXTENSIONS,
} from '@/lib/attachments/extract-text'

const MULTIMODAL_MIME_TYPES: Record<string, 'image' | 'pdf'> = {
  'image/png': 'image',
  'image/jpeg': 'image',
  'application/pdf': 'pdf',
}

/**
 * Attachment indexing.
 *
 * Three paths (slice 0 of context packages widened this from images+PDFs):
 *   - image  → one Gemini multimodal vector (chunk_text stays the filename —
 *              no OCR yet).
 *   - pdf    → one multimodal vector for the whole document, PLUS text-layer
 *              chunks when the PDF has one. Previously chunk_text was
 *              literally the filename, which starved ingest_source and made
 *              PDFs unreadable to everything downstream.
 *   - text   → docx / pptx / md / txt / json / yaml / csv: extracted text,
 *              chunked, each chunk embedded with Gemini TEXT embeddings in
 *              the SAME 3072-d space as the multimodal vectors, so the
 *              existing attachment search RPC needs no change.
 *
 * All download/extract/embed/insert work happens inside a single step per
 * attachment — step outputs carry only counts (Inngest's 4MB step-payload
 * limit rules out passing embeddings between steps).
 */
export const attachmentIndex = inngest.createFunction(
  {
    id: 'attachment-index',
    retries: 3,
    concurrency: [{ limit: 3, key: 'event.data.attachmentId' }],
    triggers: [{ event: 'attachment/index' }],
  },
  async ({ event, step }) => {
    const { attachmentId, userId, workspaceId, projectId } = event.data as {
      attachmentId: string
      userId: string
      workspaceId: string
      projectId: string | null
    }

    // Gate before Gemini embedding (P1-4). Opted in to the ChatGPT free tier:
    // a free user's attachment is indexed too, so the agent and search can see
    // it. The embeddings are Dial8's (cents per attachment at most), as every
    // capture's and document's are (docs/plans/chatgpt-free-tier.md).
    await guardBackgroundUsageOnPlan(userId)

    const supabase = getServiceClient()

    // 1. Mark as processing
    await step.run('set-processing', async () => {
      await supabase
        .from('attachments')
        .update({ embedding_status: 'processing', embedding_error: null })
        .eq('id', attachmentId)
    })

    try {
      // 2. Check eligibility
      const attachment = await step.run('check-eligibility', async () => {
        const { data, error } = await supabase
          .from('attachments')
          .select('id, file_name, mime_type, file_extension, file_size_bytes, storage_path')
          .eq('id', attachmentId)
          .single()

        if (error || !data) {
          throw new Error(`Attachment not found: ${attachmentId}`)
        }

        return data
      })

      const ext = attachment.file_extension?.toLowerCase() || ''
      const mimeType = attachment.mime_type || ''
      const multimodal = MULTIMODAL_MIME_TYPES[mimeType]
      const textExtractable = TEXT_EXTRACTABLE_EXTENSIONS.has(ext)

      if (!multimodal && !textExtractable) {
        await step.run('mark-unsupported', async () => {
          await supabase
            .from('attachments')
            .update({ embedding_status: 'unsupported' })
            .eq('id', attachmentId)
        })
        return { status: 'unsupported', attachmentId }
      }

      // 3. Download, extract, embed, and store in one step (see header).
      // Tradeoff, on purpose: a transient failure late in the step (a 429 on
      // the last embedText call, an insert error) re-runs the step's earlier
      // embeddings on retry, and geminiEmbed logs usage per call. Splitting
      // the step would mean passing embeddings between steps, which the 4MB
      // step-payload limit rules out; embedding cost per attachment is cents.
      const stepResult = await step.run('embed-and-store', async () => {
        const { data, error } = await supabase.storage
          .from('attachments')
          .download(attachment.storage_path)

        if (error || !data) {
          throw new Error(`Failed to download file: ${error?.message || 'unknown error'}`)
        }

        const fileBuffer = Buffer.from(await data.arrayBuffer())

        type ChunkRow = {
          chunk_index: number
          chunk_text: string
          chunk_type: string
          embedding: string
        }
        const rows: ChunkRow[] = []

        if (multimodal === 'image') {
          const embedding = await embedImage(fileBuffer, mimeType, userId)
          rows.push({
            chunk_index: 0,
            chunk_text: attachment.file_name,
            chunk_type: 'image',
            embedding: JSON.stringify(embedding),
          })
        } else {
          // pdf and text-extractable formats share the text path; PDFs
          // additionally keep a whole-document multimodal vector when they
          // fit Gemini's inline limit. A scanned PDF (no text layer)
          // degrades to exactly the old behavior: one multimodal chunk,
          // filename as text. An oversized PDF keeps its text chunks — the
          // multimodal vector is the optional part, never the text.
          let text: string | null = null
          try {
            text = await extractAttachmentText(fileBuffer, ext)
          } catch {
            text = null // extraction is best-effort; the vector still lands
          }

          if (multimodal === 'pdf') {
            try {
              const embedding = await embedPdf(fileBuffer, userId)
              rows.push({
                chunk_index: 0,
                // The extracted text lives in the 'text' chunks below —
                // repeating its head here would double it for every reader
                // that concatenates chunk_text (ingest_source).
                chunk_text: attachment.file_name,
                chunk_type: 'full',
                embedding: JSON.stringify(embedding),
              })
            } catch (embedErr) {
              // >10MB PDFs exceed the inline-embedding cap; without a text
              // layer either, there is nothing to index.
              if (!text) throw embedErr
            }
          }

          if (!multimodal && !text) {
            // Legitimate upload with nothing to index (a header-only CSV, a
            // two-line note): terminal 'unsupported', not a retriable error.
            return { unsupported: true as const, chunks: 0 }
          }

          if (text) {
            for (const chunk of chunkText(text)) {
              const embedding = await embedText(chunk, userId)
              rows.push({
                chunk_index: rows.length,
                chunk_text: chunk,
                chunk_type: 'text',
                embedding: JSON.stringify(embedding),
              })
            }
          }
        }

        // Delete existing first for idempotent re-indexing.
        await supabase.from('attachment_chunks').delete().eq('attachment_id', attachmentId)

        const { error: insertErr } = await supabase.from('attachment_chunks').insert(
          rows.map((r) => ({
            attachment_id: attachmentId,
            user_id: userId,
            workspace_id: workspaceId || null,
            project_id: projectId || null,
            ...r,
          })),
        )
        if (insertErr) {
          throw new Error(`Failed to insert attachment chunks: ${insertErr.message}`)
        }
        return { unsupported: false as const, chunks: rows.length }
      })

      if (stepResult.unsupported) {
        await step.run('mark-unsupported-empty', async () => {
          await supabase
            .from('attachments')
            .update({ embedding_status: 'unsupported' })
            .eq('id', attachmentId)
        })
        return { status: 'unsupported', attachmentId }
      }
      const chunksCreated = stepResult.chunks

      // 4. Mark complete
      await step.run('mark-complete', async () => {
        await supabase
          .from('attachments')
          .update({
            embedding_status: 'completed',
            embedding_error: null,
            embedding_completed_at: new Date().toISOString(),
          })
          .eq('id', attachmentId)
      })

      // 5. Reference ingestion: a PDF attached to a project is a candidate
      // for the structured reference wiki (API specs, data models). The
      // classifier inside reference-ingest is the noise gate — narrative PDFs
      // produce nothing. See src/lib/inngest/reference-ingest.ts.
      if (multimodal === 'pdf' && projectId && workspaceId) {
        await step.sendEvent('send-reference-ingest', {
          name: 'reference/ingest',
          data: { workspaceId, userId, attachmentId, projectId },
        })
      }

      return { status: 'completed', attachmentId, chunksCreated }
    } catch (err) {
      // Mark as failed so the UI can show the error and user can retry
      await supabase
        .from('attachments')
        .update({
          embedding_status: 'failed',
          embedding_error: err instanceof Error ? err.message : 'Unknown error',
        })
        .eq('id', attachmentId)
      throw err // re-throw so Inngest records the failure
    }
  },
)
