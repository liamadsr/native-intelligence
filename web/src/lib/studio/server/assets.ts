// The workspace's media library (studio_asset): one row per file, id = the sha256 of its bytes for anything
// imported, meta = the asset record an edit embeds. An edit may only embed an asset exactly as it is registered
// here (videos.ts checks), so media details can't be changed by hand in a document.
//
// Transcripts are registered the same way (studio_record, collection `transcripts`): an edit embeds a transcript
// only as registered, and registering checks it fits its audio.
import { z } from 'zod'
import { EditorAssetSchema, TranscriptSchema, type EditorAsset, type EditorTranscript } from '../engine/contracts'
import { isDuplicate, must, type StudioContext } from './context'
import { notFoundError, StudioError } from './errors'
import { COLLECTIONS, getRecords, putRecord } from './records'
import { sameJson, sha256Hex, stableStringify } from './stable'

/** The library, oldest first (as the editor lists it), up to `limit`. */
export async function listAssets(ctx: StudioContext, limit = 2000): Promise<EditorAsset[]> {
  const rows = must(
    await ctx.supabase.from('studio_asset').select('meta').eq('workspace_id', ctx.workspaceId).order('created_at', { ascending: true }).limit(limit),
    'read the media library',
  ) as { meta: EditorAsset }[] | null
  return (rows ?? []).map((row) => row.meta)
}

/** Registered assets by id (unknown ids are left out). */
export async function getAssets(ctx: StudioContext, ids: string[]): Promise<Map<string, EditorAsset>> {
  const unique = [...new Set(ids)]
  if (!unique.length) return new Map()
  const out = new Map<string, EditorAsset>()
  for (let i = 0; i < unique.length; i += 200) {
    const rows = must(
      await ctx.supabase.from('studio_asset').select('id, meta').eq('workspace_id', ctx.workspaceId).in('id', unique.slice(i, i + 200)),
      'read the media library',
    ) as { id: string; meta: EditorAsset }[] | null
    for (const row of rows ?? []) out.set(row.id, row.meta)
  }
  return out
}

/** One registered asset, or 404. */
export async function getAsset(ctx: StudioContext, id: string): Promise<EditorAsset> {
  const found = (await getAssets(ctx, [id])).get(id)
  if (!found) throw notFoundError('That media is not in the library.')
  return found
}

/** Add an asset to the library. One already registered under the id is kept as it is and returned. */
export async function registerAsset(ctx: StudioContext, value: unknown): Promise<EditorAsset> {
  const asset = EditorAssetSchema.parse(value)
  const existing = (await getAssets(ctx, [asset.id])).get(asset.id)
  if (existing) return existing
  const stored = JSON.parse(JSON.stringify(asset)) as EditorAsset
  const { error } = await ctx.supabase.from('studio_asset').insert({
    workspace_id: ctx.workspaceId,
    id: asset.id,
    name: asset.name,
    kind: asset.kind,
    sha256: asset.sha256,
    bytes: asset.bytes,
    meta: stored,
    created_by: ctx.userId,
  })
  if (error) {
    if (isDuplicate(error)) return getAsset(ctx, asset.id)
    must({ data: null, error }, 'add that media to the library')
  }
  return stored
}

// ---- transcripts --------------------------------------------------------------------------------------------

/** Registered transcripts by id. */
export async function getTranscripts(ctx: StudioContext, ids: string[]): Promise<Map<string, EditorTranscript>> {
  return getRecords<EditorTranscript>(ctx, COLLECTIONS.transcripts, ids)
}

/** A registered transcript of an asset, if any (the newest registered wins when there are several). */
export async function transcriptForAsset(ctx: StudioContext, assetId: string): Promise<EditorTranscript | null> {
  const rows = must(
    await ctx.supabase.from('studio_record').select('value, updated_at').eq('workspace_id', ctx.workspaceId).eq('collection', COLLECTIONS.transcripts).eq('value->>assetId', assetId).order('updated_at', { ascending: false }).limit(1),
    'read transcripts',
  ) as { value: EditorTranscript }[] | null
  return rows?.[0]?.value ?? null
}

/** Register a transcript: it must belong to a library asset with audio, match its bytes and fit its length. */
export async function registerTranscript(ctx: StudioContext, value: unknown): Promise<EditorTranscript> {
  const transcript = TranscriptSchema.parse(value)
  const asset = (await getAssets(ctx, [transcript.assetId])).get(transcript.assetId)
  if (!asset || !asset.hasAudio || asset.sha256 !== transcript.sourceSha256 || transcript.words.some((w) => w.endMs > (asset.durationSeconds ?? 0) * 1000 + 50))
    throw new StudioError('Transcript does not match registered audio duration')
  const old = (await getTranscripts(ctx, [transcript.id])).get(transcript.id)
  if (old) {
    if (!sameJson(old, transcript)) throw new StudioError('Transcript identity conflict')
    return old
  }
  const stored = JSON.parse(JSON.stringify(transcript)) as EditorTranscript
  await putRecord(ctx, COLLECTIONS.transcripts, stored.id, stored)
  return stored
}

const TimedInputSchema = z.object({
  text: z.string().max(200_000).optional(),
  words: z.array(z.object({ text: z.string().min(1).max(500), startMs: z.number().finite().nonnegative(), endMs: z.number().finite().nonnegative() }).strict()).min(1).max(40_000),
}).strict()

/** A transcript record for an asset from timed words; its id is fixed by the asset, the alignment and the origin. */
export function toTranscript(asset: EditorAsset, input: { words: { text: string; startMs: number; endMs: number }[]; text: string }, origin: EditorTranscript['origin'], alignmentSha256: string, label: string, voiceName?: string): EditorTranscript {
  const identity = sha256Hex(stableStringify({ asset: asset.sha256, alignmentSha256, origin }))
  return TranscriptSchema.parse({
    id: identity, assetId: asset.id, sourceSha256: asset.sha256, label, origin, text: input.text, alignmentSha256, ...(voiceName ? { voiceName } : {}),
    words: input.words.map((w, index) => ({ id: `w-${identity.slice(0, 20)}-${index}`, text: w.text, startMs: w.startMs, endMs: w.endMs })),
  })
}

/** Import word-timed JSON ({text?, words:[{text,startMs,endMs}]}) as an asset's transcript. */
export async function importTimedTranscript(ctx: StudioContext, assetId: unknown, document: unknown): Promise<EditorTranscript> {
  const asset = typeof assetId === 'string' ? (await getAssets(ctx, [assetId])).get(assetId) : undefined
  if (!asset || !asset.hasAudio) throw new StudioError('Choose a registered recording or audio file with speech')
  const input = TimedInputSchema.parse(document)
  const original = { words: input.words, text: input.text ?? input.words.map((w) => w.text).join(' ') }
  return registerTranscript(ctx, toTranscript(asset, original, 'imported', sha256Hex(stableStringify(input)), `${asset.name} imported transcript`.slice(0, 250)))
}

/** The transcript already registered for an asset (from a transcription), or null: there is no narration cache here. */
export async function attachTranscript(ctx: StudioContext, assetId: unknown): Promise<EditorTranscript | null> {
  const asset = typeof assetId === 'string' ? (await getAssets(ctx, [assetId])).get(assetId) : undefined
  if (!asset || !asset.hasAudio) throw new StudioError('Choose a registered recording or audio file with speech')
  return transcriptForAsset(ctx, asset.id)
}
