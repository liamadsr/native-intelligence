// Small per-workspace records that are one JSON value each (studio_record): appearance presets, registered
// transcripts, slide decks, pending uploads. A record is (collection, key) -> value.
import { randomUUID } from 'node:crypto'
import { CursorSchema, PresentationSchema, type EditorPreset } from '../engine/contracts'
import { must, type StudioContext } from './context'
import { StudioError } from './errors'

/** The collections this folder uses. */
export const COLLECTIONS = { presets: 'presets', transcripts: 'transcripts', slides: 'slides' } as const

/** One record's value, or null. */
export async function getRecord<T = unknown>(ctx: StudioContext, collection: string, key: string): Promise<T | null> {
  const row = must(
    await ctx.supabase.from('studio_record').select('value').eq('workspace_id', ctx.workspaceId).eq('collection', collection).eq('key', key).maybeSingle(),
    'read that record',
  ) as { value: T } | null
  return row ? row.value : null
}

/** Several records of one collection by key (missing keys are left out). */
export async function getRecords<T = unknown>(ctx: StudioContext, collection: string, keys: string[]): Promise<Map<string, T>> {
  if (!keys.length) return new Map()
  const rows = must(
    await ctx.supabase.from('studio_record').select('key, value').eq('workspace_id', ctx.workspaceId).eq('collection', collection).in('key', [...new Set(keys)]),
    'read those records',
  ) as { key: string; value: T }[] | null
  return new Map((rows ?? []).map((row) => [row.key, row.value]))
}

/** Every record of a collection, oldest first. */
export async function listRecords<T = unknown>(ctx: StudioContext, collection: string, limit = 1000): Promise<{ key: string; value: T; updatedAt: string }[]> {
  const rows = must(
    await ctx.supabase.from('studio_record').select('key, value, updated_at').eq('workspace_id', ctx.workspaceId).eq('collection', collection).order('updated_at', { ascending: true }).limit(limit),
    'read those records',
  ) as { key: string; value: T; updated_at: string }[] | null
  return (rows ?? []).map((row) => ({ key: row.key, value: row.value, updatedAt: row.updated_at }))
}

/** Write a record (replacing what was there). */
export async function putRecord(ctx: StudioContext, collection: string, key: string, value: unknown): Promise<void> {
  must(
    await ctx.supabase.from('studio_record').upsert({ workspace_id: ctx.workspaceId, collection, key, value, updated_at: new Date().toISOString() }, { onConflict: 'workspace_id,collection,key' }),
    'save that record',
  )
}

/** Remove a record (missing is fine). */
export async function deleteRecord(ctx: StudioContext, collection: string, key: string): Promise<void> {
  must(await ctx.supabase.from('studio_record').delete().eq('workspace_id', ctx.workspaceId).eq('collection', collection).eq('key', key), 'remove that record')
}

/** The workspace's saved appearance presets, oldest first. */
export async function listPresets(ctx: StudioContext): Promise<EditorPreset[]> {
  return (await listRecords<EditorPreset>(ctx, COLLECTIONS.presets)).map((row) => row.value)
}

/** Save the current look (background, screen, cursor) as a named preset. */
export async function savePreset(ctx: StudioContext, value: { name?: unknown; presentation?: unknown; cursor?: unknown }): Promise<EditorPreset> {
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 100) throw new StudioError('Preset needs a name')
  const preset: EditorPreset = { id: randomUUID(), name: value.name.trim(), presentation: PresentationSchema.parse(value.presentation), cursor: CursorSchema.parse(value.cursor) }
  await putRecord(ctx, COLLECTIONS.presets, preset.id, preset)
  return preset
}
