import type { SupabaseClient } from '@supabase/supabase-js'
import type { FilePart } from 'ai'
import { createDataUrlFilePart } from 'eve/client'
import { getServiceClient } from '@/lib/admin'
import { guardBackgroundUsage } from './usage-guard'
import { indexDocument } from '@/lib/ai/embeddings'
import { runUtilityTask } from '@/lib/eve/utility/run-utility'
import { UTILITY_KIND_SPECS } from '@/lib/eve/utility/spec'
import { syncDocumentLinks } from '@/lib/wiki/wikilinks'
import { productDocIdOf } from '@/lib/workspace/product-doc'
import { PDFDocument } from 'pdf-lib'
import { z } from 'zod'
import { inngest } from './client'

/**
 * reference/ingest — turn a PDF spec into a navigable reference wiki.
 *
 * Claims are the wrong shape for reference material: they distill (atomic,
 * capped, paraphrased), while an API spec derives its value from structure,
 * completeness, and VERBATIM fidelity. This pipeline produces the third
 * representation: an index document plus one `spec`-type document per
 * endpoint/object/concept, with payloads copied exactly, wikilinked together,
 * and wired into the graph (`cites → attachment`, `about → project`).
 *
 * Important: attachment_chunks carry NO extracted text (the Gemini pipeline
 * embeds PDFs multimodally; chunk_text is just the file name). So this
 * function feeds the PDF BYTES directly to the model — extraction and
 * structuring in one call, tables included.
 *
 * Guardrails (learned from the pre-109 auto-wiki failure — a flood of stub
 * pages got that feature removed):
 *   - a classifier gate INSIDE the same model call: narrative sources
 *     (meeting decks, proposals, contracts) return is_reference=false at tiny
 *     output cost and produce NOTHING;
 *   - pages are only written when there is rich content to fill them;
 *   - re-ingesting the same attachment REPLACES its pages (matched via
 *     frontmatter.source_attachment_id) — never duplicates; pages that
 *     disappear from the source get archived.
 *
 * Cost: one Strong (Sonnet) read per ingested PDF (one-time, user-initiated or
 * triggered by attaching a PDF to a project). The decisions layer still
 * happens: the generated index document is sent through claim extraction.
 */

// The structuring model is the Strong tier (SURFACE_MODELS.document_ingest,
// STRONG_MODEL) — an Anthropic model by constraint, since the PDF
// bytes are sent to the model as a file part. Both model calls run on the eve
// utility agent (kinds reference_ingest_outline / reference_ingest_segment);
// their system prompts and output caps live in src/lib/eve/utility/spec.ts.
const MAX_PDF_BYTES = 20 * 1024 * 1024
const MAX_PAGES = 40

// A dense PDF page costs ~1.5–3k input tokens (image + text), so a whole
// document in one call blows the 200k context window fast — a real 4.4MB
// tech-arch PDF measured 201k tokens. Process the document in page-range
// SEGMENTS instead: classify+overview on segment 1, then one structuring
// call per segment, each its own Inngest step (bounded input, bounded
// output, fits the route's maxDuration).
export const SEGMENT_PDF_PAGES = 25
const MAX_SEGMENTS = 6
const SEGMENT_OUTPUT_PAGES = 16

const ReferencePage = z.object({
  title: z
    .string()
    .describe(
      'Short page title. For endpoints use "METHOD /path" (e.g. "GET /boutiques/{id}").',
    ),
  kind: z.enum(['endpoint', 'object', 'concept']),
  markdown: z
    .string()
    .describe('Full page body in markdown. Do NOT start with an H1 title.'),
})

const OutlineResult = z.object({
  is_reference: z
    .boolean()
    .describe('True only if the document is primarily reference material.'),
  doc_kind: z.enum(['api_spec', 'data_model', 'process', 'other']),
  title: z.string().describe('Short name of the system/spec, e.g. "Boutique Service API".'),
  overview_markdown: z
    .string()
    .default('')
    .describe('Orientation: what this is, auth, base URLs, conventions, constraints.'),
})

const SegmentResult = z.object({
  pages: z.array(ReferencePage).max(SEGMENT_OUTPUT_PAGES).default([]),
})

// CLASSIFY_PROMPT / SEGMENT_PROMPT moved verbatim to src/lib/eve/utility/prompts.ts
// (REFERENCE_INGEST_CLASSIFY_PROMPT / REFERENCE_INGEST_SEGMENT_PROMPT).

/** 1-based inclusive page ranges of at most `maxPages` each. Pure. */
export function planSegments(
  pageCount: number,
  maxPages: number = SEGMENT_PDF_PAGES,
): Array<{ from: number; to: number }> {
  const segments: Array<{ from: number; to: number }> = []
  for (let from = 1; from <= pageCount; from += maxPages) {
    segments.push({ from, to: Math.min(from + maxPages - 1, pageCount) })
  }
  return segments
}

/**
 * Merge per-segment page lists: exact-title duplicates keep the longest body
 * (the same endpoint can straddle a segment boundary), and the total is
 * capped at `cap` with the number of dropped pages reported — never a silent
 * truncation. Pure.
 */
export function mergeSegmentPages(
  segments: Array<Array<z.infer<typeof ReferencePage>>>,
  cap: number = MAX_PAGES,
): { pages: Array<z.infer<typeof ReferencePage>>; dropped: number } {
  const byTitle = new Map<string, z.infer<typeof ReferencePage>>()
  for (const segment of segments) {
    for (const page of segment) {
      const key = page.title.trim().toLowerCase()
      const existing = byTitle.get(key)
      if (!existing || page.markdown.length > existing.markdown.length) {
        byTitle.set(key, page)
      }
    }
  }
  const all = [...byTitle.values()]
  return { pages: all.slice(0, cap), dropped: Math.max(0, all.length - cap) }
}

/** Copy a 1-based inclusive page range into a standalone PDF. */
export async function extractPdfSegment(
  buffer: Buffer,
  from: number,
  to: number,
): Promise<Buffer> {
  const source = await PDFDocument.load(new Uint8Array(buffer), { ignoreEncryption: true })
  const total = source.getPageCount()
  if (from <= 1 && to >= total) return buffer
  const target = await PDFDocument.create()
  const indices = []
  for (let i = from - 1; i <= Math.min(to - 1, total - 1); i++) indices.push(i)
  const pages = await target.copyPages(source, indices)
  for (const page of pages) target.addPage(page)
  return Buffer.from(await target.save())
}

/**
 * Largest PDF segment sent INLINE (as a base64 data: URL) in the eve task
 * message. The message rides in the create POST's JSON body to the utility
 * agent, which on Vercel is a function invocation with a 4.5 MB request-body
 * limit; 3 MiB of PDF is 4 MiB of base64, leaving room for the rest of the
 * body. Anything larger goes by short-lived signed URL instead (the Gateway
 * passes URL file parts through to the provider).
 */
export const INLINE_PDF_MAX_BYTES = 3 * 1024 * 1024

/** Lifetime of a signed URL handed to the model call (covers the segment timeout). */
const SIGNED_URL_TTL_S = 15 * 60

/**
 * The file part a model call gets for one PDF segment, plus a cleanup to run
 * after the call.
 *
 * On the eve side, ANY file part in a task message makes the harness open the
 * utility agent's sandbox (every eve agent has one — Vercel Sandbox on Vercel,
 * docker/microsandbox/just-bash locally) and stage the bytes there, then
 * inline PDFs ≤ 20 MiB back into the model call. So each ingest model call
 * provisions that sandbox; the model itself still reads the PDF directly.
 *
 * LOCAL DEV WARNING: with neither microsandbox nor Docker working, `eve dev`
 * falls back to auto-installing just-bash for that sandbox — which REWRITES
 * the checkout's package.json / package-lock.json and node_modules. Run a
 * reference ingest locally only with microsandbox or Docker up (see
 * docs/DEV_SETUP.md, "Local eve sandbox").
 *
 * RETENTION: the task message is durable eve session state, so an inline
 * segment's bytes (or a large one's 15-minute signed URL) stay in the utility
 * session's event log and staged in its sandbox after the call; neither is
 * purged when the attachment is deleted.
 *
 *   - ≤ INLINE_PDF_MAX_BYTES → inline data: URL, nothing stored.
 *   - larger, and the segment IS the whole stored file → a signed URL of the
 *     attachment itself, nothing stored.
 *   - larger sliced segment → uploaded to a temporary object under a system
 *     prefix no member's storage policy matches, signed (service client), and
 *     removed by `cleanup` (best effort). The path
 *     is deterministic per run and page range and uploaded with upsert, so an
 *     Inngest retry of a step that was killed before its `finally` overwrites
 *     the earlier copy instead of leaving another one.
 */
export async function pdfSegmentFilePart(args: {
  supabase: SupabaseClient
  bytes: Buffer
  /** True when `bytes` is the stored attachment unchanged. */
  wholeFile: boolean
  storagePath: string
  attachmentId: string
  /** The Inngest run — shared by a step's retries, distinct across ingests of one attachment. */
  runId: string
  /** The segment's 1-based inclusive page range. */
  from: number
  to: number
}): Promise<{ part: FilePart; cleanup: () => Promise<void> }> {
  const noop = async () => {}
  if (args.bytes.length <= INLINE_PDF_MAX_BYTES) {
    return {
      part: createDataUrlFilePart({ bytes: new Uint8Array(args.bytes), mediaType: 'application/pdf' }),
      cleanup: noop,
    }
  }

  const bucket = args.supabase.storage.from('attachments')
  let path = args.storagePath
  let cleanup = noop
  if (!args.wholeFile) {
    path = referenceIngestTmpPath(args)
    const { error } = await bucket.upload(path, args.bytes, { contentType: 'application/pdf', upsert: true })
    if (error) throw new Error(`Failed to stage PDF segment: ${error.message}`)
    const tmp = path
    cleanup = async () => {
      await bucket.remove([tmp]).catch(() => {})
    }
  }
  const { data: signed, error: signError } = await bucket.createSignedUrl(path, SIGNED_URL_TTL_S)
  if (signError || !signed?.signedUrl) {
    await cleanup()
    throw new Error(`Failed to sign PDF segment URL: ${signError?.message || 'unknown'}`)
  }
  return { part: { type: 'file', data: signed.signedUrl, mediaType: 'application/pdf' }, cleanup }
}

/**
 * Where a large sliced segment is staged, per attachment, per Inngest run, per
 * page range. Deterministic, so retries of the same step reuse it.
 *
 * Under `_system/`, NOT the triggering user's `<userId>/` prefix. The
 * attachments bucket's owner policies key on the first folder being the
 * caller's uid (migration 128's notes), and the workspace read policy (223)
 * needs an attachments row with this exact path — this copy has none. So no
 * member reads it through RLS, whereas under `<userId>/` the user who
 * triggered the ingest could, even for an attachment they cannot see (e.g.
 * on another member's private capture). Only the service client writes,
 * signs and removes it. Keyed by attachment first so an attachment-delete
 * sweep can find every copy.
 */
export function referenceIngestTmpPath(a: {
  attachmentId: string
  runId: string
  from: number
  to: number
}): string {
  return `_system/reference-ingest-tmp/${a.attachmentId}/${a.runId}/${a.from}-${a.to}.pdf`
}

/**
 * The Inngest route's maxDuration (src/app/api/inngest/route.ts, 300s) less
 * room for what runs AFTER a model call gives up: the post-timeout cancel
 * (≤ 5s, run-utility.ts) and the temp-copy cleanup in the step's `finally`.
 */
const STEP_MODEL_DEADLINE_MS = 285_000
/** A model call never gets less than this, however slow the pre-work was. */
const MIN_MODEL_TIMEOUT_MS = 30_000

/**
 * The model-call timeout for an ingest step that started at `stepStartedAt`:
 * the kind's default, cut short by whatever the step already spent on the
 * download, slice, upload and signing, so the call (and its cancel and
 * cleanup) end inside the function's 300s instead of Vercel killing it
 * mid-call — which would skip the cleanup and leave the session running.
 */
export function stepModelTimeoutMs(kindDefaultMs: number, stepStartedAt: number, now: number = Date.now()): number {
  const left = STEP_MODEL_DEADLINE_MS - Math.max(0, now - stepStartedAt)
  return Math.min(kindDefaultMs, Math.max(MIN_MODEL_TIMEOUT_MS, left))
}

/** Kebab-case slug from a title; never empty. */
export function buildSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9\s/{}_-]/g, '')
      .replace(/[/{}_]/g, ' ')
      .trim()
      .replace(/[\s-]+/g, '-')
      .slice(0, 70)
      .replace(/^-+|-+$/g, '') || 'page'
  )
}

/**
 * Assign workspace-unique slugs: index gets the spec slug, each page gets
 * `<index>--<page>`; collisions (within the batch or against `taken`) get a
 * numeric suffix. Pure — unit-tested.
 */
export function assignSlugs(
  indexTitle: string,
  pageTitles: string[],
  taken: Set<string>,
): { indexSlug: string; pageSlugs: string[] } {
  const used = new Set(taken)
  const claim = (base: string): string => {
    let slug = base
    for (let i = 2; used.has(slug); i++) slug = `${base}-${i}`
    used.add(slug)
    return slug
  }
  const indexSlug = claim(buildSlug(indexTitle))
  const pageSlugs = pageTitles.map((t) => claim(`${indexSlug}--${buildSlug(t)}`))
  return { indexSlug, pageSlugs }
}

/**
 * Deterministic index body: the model's overview plus a generated, grouped
 * table of contents. Built app-side (not by the model) so every wikilink
 * resolves to a real slug. Pure — unit-tested.
 */
export function buildIndexContent(
  overviewMarkdown: string,
  pages: Array<{ slug: string; title: string; kind: string }>,
  sourceFileName: string,
): string {
  const GROUPS: Array<[string, string]> = [
    ['endpoint', 'Endpoints'],
    ['object', 'Objects & schemas'],
    ['concept', 'Concepts'],
  ]
  const sections: string[] = []
  for (const [kind, heading] of GROUPS) {
    const group = pages.filter((p) => p.kind === kind)
    if (!group.length) continue
    sections.push(
      `### ${heading}\n${group.map((p) => `- [[${p.slug}]] — ${p.title}`).join('\n')}`,
    )
  }
  return [
    overviewMarkdown.trim(),
    '## Pages',
    ...sections,
    `> Generated from "${sourceFileName}". Re-ingesting the attachment refreshes these pages.`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

export const referenceIngest = inngest.createFunction(
  {
    id: 'reference-ingest',
    retries: 1,
    concurrency: [{ limit: 2 }],
    triggers: [{ event: 'reference/ingest' }],
  },
  async ({ event, step, runId }) => {
    const data = event.data as {
      workspaceId: string
      userId: string
      attachmentId: string
      projectId?: string | null
    }

    // Gate before the (expensive, Sonnet-multimodal) PDF read (P1-4). In a
    // step: a replay before a later step must not re-check and abort a run
    // that has already paid for its reads.
    await step.run('guard', () => guardBackgroundUsage(data.userId))

    const supabase = getServiceClient()

    const attachment = await step.run('load-attachment', async () => {
      const { data: row } = await supabase
        .from('attachments')
        .select('id, file_name, mime_type, file_size_bytes, storage_path, workspace_id')
        .eq('id', data.attachmentId)
        .eq('workspace_id', data.workspaceId)
        .maybeSingle()
      return row ?? null
    })
    if (!attachment) return { status: 'skipped', reason: 'attachment_not_found' }
    if (attachment.mime_type !== 'application/pdf') {
      return { status: 'skipped', reason: 'not_pdf' }
    }
    if ((attachment.file_size_bytes ?? 0) > MAX_PDF_BYTES) {
      return { status: 'skipped', reason: 'too_large' }
    }

    // The buffer never crosses step boundaries (Inngest memoizes step
    // returns); each model step re-downloads from storage and slices the
    // page range it needs.
    const downloadPdf = async (): Promise<Buffer> => {
      const { data: file, error } = await supabase.storage
        .from('attachments')
        .download(attachment.storage_path as string)
      if (error || !file) {
        throw new Error(`Failed to download PDF: ${error?.message || 'unknown'}`)
      }
      return Buffer.from(await file.arrayBuffer())
    }

    const plan = await step.run('plan-segments', async () => {
      const buffer = await downloadPdf()
      const doc = await PDFDocument.load(new Uint8Array(buffer), { ignoreEncryption: true })
      const pageCount = doc.getPageCount()
      const segments = planSegments(pageCount).slice(0, MAX_SEGMENTS)
      return { pageCount, segments }
    })
    if (plan.pageCount === 0) return { status: 'skipped', reason: 'empty_pdf' }
    const truncatedPages =
      plan.pageCount - (plan.segments[plan.segments.length - 1]?.to ?? 0)

    // Classify + overview from the first segment only — enough to triage,
    // and bounded regardless of document size.
    const outline = await step.run('classify-outline', async () => {
      const stepStartedAt = Date.now()
      const buffer = await downloadPdf()
      const first = plan.segments[0]
      const bytes = await extractPdfSegment(buffer, first.from, first.to)
      const pdf = await pdfSegmentFilePart({
        supabase,
        bytes,
        wholeFile: bytes === buffer,
        storagePath: attachment.storage_path as string,
        attachmentId: data.attachmentId,
        runId,
        from: first.from,
        to: first.to,
      })
      try {
        // The workspace's 'document_ingest' model, the classify prompt, the
        // 3k output cap and Gateway telemetry (feature 'reference_ingest',
        // tagging only — this site has no logUsage) all ride the utility kind.
        const { object } = await runUtilityTask({
          kind: 'reference_ingest_outline',
          supabase,
          workspaceId: data.workspaceId,
          userId: data.userId,
          message: [
            pdf.part,
            {
              type: 'text',
              text: `File name: ${attachment.file_name}${
                plan.segments.length > 1
                  ? ` (showing pages ${first.from}–${first.to} of ${plan.pageCount})`
                  : ''
              }`,
            },
          ],
          outputSchema: OutlineResult,
          timeoutMs: stepModelTimeoutMs(UTILITY_KIND_SPECS.reference_ingest_outline.timeoutMs, stepStartedAt),
        })
        return object
      } catch (err) {
        console.error(
          `[reference-ingest] classify failed for attachment ${data.attachmentId}:`,
          err instanceof Error ? err.message : err,
        )
        throw err
      } finally {
        await pdf.cleanup()
      }
    })

    if (!outline.is_reference) {
      return { status: 'skipped', reason: 'not_reference', doc_kind: outline.doc_kind }
    }

    // One structuring call per segment, each its own step: bounded input
    // (≤ SEGMENT_PDF_PAGES pages), bounded output, independent retries.
    const segmentResults: Array<Array<z.infer<typeof ReferencePage>>> = []
    for (let i = 0; i < plan.segments.length; i++) {
      const segment = plan.segments[i]
      const result = await step.run(`structure-segment-${i + 1}`, async () => {
        const stepStartedAt = Date.now()
        const buffer = await downloadPdf()
        const bytes = await extractPdfSegment(buffer, segment.from, segment.to)
        const pdf = await pdfSegmentFilePart({
          supabase,
          bytes,
          wholeFile: bytes === buffer,
          storagePath: attachment.storage_path as string,
          attachmentId: data.attachmentId,
          runId,
          from: segment.from,
          to: segment.to,
        })
        try {
          // Same surface/feature as the classify call; 12k output cap.
          const { object } = await runUtilityTask({
            kind: 'reference_ingest_segment',
            supabase,
            workspaceId: data.workspaceId,
            userId: data.userId,
            message: [
              pdf.part,
              {
                type: 'text',
                text: `Document: ${outline.title} (${outline.doc_kind}). This excerpt is pages ${segment.from}–${segment.to} of ${plan.pageCount}.`,
              },
            ],
            outputSchema: SegmentResult,
            timeoutMs: stepModelTimeoutMs(UTILITY_KIND_SPECS.reference_ingest_segment.timeoutMs, stepStartedAt),
          })
          return object.pages
        } catch (err) {
          console.error(
            `[reference-ingest] segment ${i + 1}/${plan.segments.length} failed for attachment ${data.attachmentId}:`,
            err instanceof Error ? err.message : err,
          )
          throw err
        } finally {
          await pdf.cleanup()
        }
      })
      segmentResults.push(result)
    }

    const merged = mergeSegmentPages(segmentResults)
    const structured = {
      ...outline,
      pages: merged.pages,
    }
    if (structured.pages.length === 0) {
      return { status: 'skipped', reason: 'no_pages', doc_kind: outline.doc_kind }
    }

    const memberId = await step.run('resolve-member', async () => {
      const { data: member } = await supabase
        .from('member')
        .select('id')
        .eq('user_id', data.userId)
        .eq('workspace_id', data.workspaceId)
        .maybeSingle()
      return member?.id ?? null
    })

    const written = await step.run('write-pages', async () => {
      const now = new Date().toISOString()

      // Docs previously generated from this attachment — re-ingest replaces.
      const { data: priorRows } = await supabase
        .from('document')
        .select('id, slug, content')
        .eq('workspace_id', data.workspaceId)
        .contains('frontmatter', { generated: true, source_attachment_id: data.attachmentId })
      const prior = new Map<string, string>(
        (priorRows ?? []).map((d) => [d.slug as string, d.id as string]),
      )
      // Each prior page's body: what its links named before this write.
      const priorContent = new Map<string, string>(
        (priorRows ?? []).filter((d) => typeof d.content === 'string').map((d) => [d.slug as string, d.content as string]),
      )

      // Workspace slugs that would collide and are NOT ours to update.
      const candidateBases = [
        buildSlug(structured.title),
        ...structured.pages.map(
          (p) => `${buildSlug(structured.title)}--${buildSlug(p.title)}`,
        ),
      ]
      const { data: collisions } = await supabase
        .from('document')
        .select('slug')
        .eq('workspace_id', data.workspaceId)
        .in('slug', candidateBases)
      const taken = new Set(
        (collisions ?? [])
          .map((d) => d.slug as string)
          .filter((slug) => !prior.has(slug)),
      )

      const { indexSlug, pageSlugs } = assignSlugs(
        structured.title,
        structured.pages.map((p) => p.title),
        taken,
      )

      const upsertDoc = async (args: {
        slug: string
        title: string
        content: string
        pageKind: string
      }): Promise<string | null> => {
        const fields = {
          title: args.title,
          content: args.content,
          type: 'spec',
          tags: ['reference', structured.doc_kind],
          frontmatter: {
            generated: true,
            source_attachment_id: data.attachmentId,
            doc_kind: structured.doc_kind,
            page_kind: args.pageKind,
          },
          published_status: 'published',
          published_at: now,
          project_id: data.projectId ?? null,
          status: 'active',
          updated_at: now,
          // From an uploaded file: outside text, for good (migration 397, F3 review R2).
          outside_derived: true,
        }
        const existingId = prior.get(args.slug)
        if (existingId) {
          // A page someone has since made canon (canon D2) is never rewritten
          // by a re-ingest: canon text changes only through
          // propose_section_edit. Such a page is left as it is.
          const { error } = await supabase
            .from('document')
            .update(fields)
            .eq('id', existingId)
            .eq('workspace_id', data.workspaceId)
            .is('canon_key', null)
          return error ? null : existingId
        }
        const { data: created, error } = await supabase
          .from('document')
          .insert({
            ...fields,
            workspace_id: data.workspaceId,
            slug: args.slug,
            created_by: memberId,
          })
          .select('id')
          .single()
        return error || !created ? null : (created.id as string)
      }

      const pageRefs: Array<{ slug: string; title: string; kind: string }> =
        structured.pages.map((p, i) => ({ slug: pageSlugs[i], title: p.title, kind: p.kind }))

      // (id, content) pairs for every written doc — fed to the embed step so
      // spec pages become semantically searchable (document_chunks, migration
      // 185). Collected here because only this step knows which upserts got ids.
      const embedTargets: Array<{ id: string; content: string }> = []

      const docIds: string[] = []
      for (let i = 0; i < structured.pages.length; i++) {
        const id = await upsertDoc({
          slug: pageSlugs[i],
          title: structured.pages[i].title,
          content: structured.pages[i].markdown,
          pageKind: structured.pages[i].kind,
        })
        if (id) {
          docIds.push(id)
          embedTargets.push({ id, content: structured.pages[i].markdown })
        }
      }

      const indexContent = buildIndexContent(
        structured.overview_markdown,
        pageRefs,
        attachment.file_name as string,
      )
      const indexDocId = await upsertDoc({
        slug: indexSlug,
        title: structured.title,
        content: indexContent,
        pageKind: 'index',
      })
      if (indexDocId) {
        docIds.push(indexDocId)
        embedTargets.push({ id: indexDocId, content: indexContent })
      }

      // Pages that existed before but are gone from the source → archive.
      const keptSlugs = new Set([indexSlug, ...pageSlugs])
      const staleIds = [...prior.entries()]
        .filter(([slug]) => !keptSlugs.has(slug))
        .map(([, id]) => id)
      if (staleIds.length) {
        // A system document (migration 366: a canon_key, or the product doc)
        // is never archived: one refused row would fail the whole update, so
        // it is left out here.
        const productDocId = await productDocIdOf(supabase, data.workspaceId)
        let archive = supabase
          .from('document')
          .update({ status: 'archived', updated_at: now })
          .in('id', staleIds)
          .eq('workspace_id', data.workspaceId)
          .is('canon_key', null)
        if (productDocId) archive = archive.neq('id', productDocId)
        const { error: archiveError } = await archive
        if (archiveError) console.warn('[reference-ingest] archiving stale pages failed:', archiveError.message)
      }

      // Graph edges: every page cites its source attachment; about → project.
      const edges = docIds.flatMap((id) => {
        const rows: Array<Record<string, unknown>> = [
          {
            workspace_id: data.workspaceId,
            source_type: 'document',
            source_id: id,
            target_type: 'attachment',
            target_id: data.attachmentId,
            relation: 'cites',
            created_by: memberId,
          },
        ]
        if (data.projectId) {
          rows.push({
            workspace_id: data.workspaceId,
            source_type: 'document',
            source_id: id,
            target_type: 'project',
            target_id: data.projectId,
            relation: 'about',
            created_by: memberId,
          })
        }
        return rows
      })
      if (edges.length) {
        await supabase.from('entity_link').upsert(edges, {
          onConflict: 'workspace_id,source_type,source_id,target_type,target_id,relation',
          ignoreDuplicates: true,
        })
      }

      // Wikilinks in the index → mentions edges (slugs are final, so all resolve).
      // A re-ingest takes back only the links the old index named.
      if (indexDocId) {
        await syncDocumentLinks(
          supabase,
          data.workspaceId,
          indexDocId,
          indexContent,
          memberId,
          null,
          priorContent.get(indexSlug) ?? null,
        )
      }

      return {
        indexDocId,
        pages: structured.pages.length,
        archived: staleIds.length,
        replaced: prior.size > 0,
        embedTargets,
      }
    })

    // Embed the written pages so they're semantically searchable via
    // hybrid_search's document_vec branch (document_chunks, migration 185).
    // Its own step: bounded, independently retryable, and it re-downloads
    // nothing. indexDocument delete-then-reinserts, so a retry is idempotent and
    // re-ingest (which replaced the same doc ids above) refreshes their vectors.
    // Best-effort: an embedding failure must not fail the ingest — the pages are
    // already written and FTS-searchable.
    if (written.embedTargets.length > 0) {
      await step.run('embed-pages', async () => {
        let embedded = 0
        for (const target of written.embedTargets) {
          try {
            await indexDocument(
              supabase,
              target.id,
              data.userId,
              data.projectId ?? null,
              target.content,
              data.workspaceId,
            )
            embedded++
          } catch (err) {
            console.error(
              `[reference-ingest] embed failed for document ${target.id}:`,
              err instanceof Error ? err.message : err,
            )
          }
        }
        return { embedded }
      })
    }

    // Decisions layer: the overview carries the claim-shaped content
    // (constraints, conventions, decisions); endpoint pages would be noise.
    if (written.indexDocId) {
      await step.sendEvent('extract-claims-from-index', {
        name: 'claim/extract-from-source',
        data: {
          workspaceId: data.workspaceId,
          userId: data.userId,
          memberId,
          sourceType: 'document',
          sourceId: written.indexDocId,
          sourceLabel: structured.title,
        },
      })
    }

    return {
      status: 'completed',
      title: structured.title,
      doc_kind: structured.doc_kind,
      pageCount: plan.pageCount,
      segments: plan.segments.length,
      // Coverage caps are reported, never silent: source pages beyond
      // MAX_SEGMENTS and merged pages beyond MAX_PAGES.
      truncatedSourcePages: truncatedPages,
      droppedPages: merged.dropped,
      ...written,
    }
  },
)
