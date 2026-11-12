/**
 * What the agent reads of a video through the Studio tools (../studio.ts):
 * get_studio_video's overview shows a text layer's size and position, its ids
 * argument answers named things in full, get_studio_catalog lists the defaults
 * an overview leaves out, and get_studio_storyboard names the style pack. On the
 * Studio server's in-memory tables. Made-up people and words.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const state = vi.hoisted(() => ({ db: null as unknown, storage: null as unknown }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => state.db }))
vi.mock('@/lib/studio/server/storage', async (load) => ({ ...(await load<object>()), supabaseStorage: () => state.storage }))

import { AVA, WS, fakeDb, fakeStorage } from '@/lib/studio/server/__tests__/fake'
import { createStudioTools } from '../studio'

type Row = Record<string, unknown>
const call = (name: string, input: unknown) =>
  (createStudioTools(AVA, WS)[name as 'get_studio_video'] as unknown as { execute: (i: unknown, o: unknown) => Promise<Record<string, unknown>> }).execute(input, { toolCallId: 't', messages: [] })

let tables_: Record<string, Row[]>
beforeEach(() => {
  const tables: Record<string, Row[]> = { member: [{ id: 'm-ava', workspace_id: WS, user_id: AVA, role: 'owner' }] }
  tables_ = tables
  state.db = fakeDb(tables).client as SupabaseClient
  state.storage = fakeStorage()
})

/** A blank made-up video with one headline on it, and the digest after. */
async function videoWithHeadline() {
  const made = await call('create_studio_video', { title: 'Spring teaser', seconds: 6, fps: 30, width: 640, height: 360 })
  const id = (made.video as { id: string }).id
  const edited = await call('edit_studio_video', {
    video_id: id,
    edits: [
      { op: 'add_text', args: { text: 'Your inbox, finally quiet', at: 0.5, duration: 4, look: 'title', position: { x: 0.5, y: 0.3 }, name: 'Headline' } },
      { op: 'set_style_pack', args: { pack: 'clean-product' } },
    ],
  })
  expect(edited).toMatchObject({ success: true })
  return id
}

describe('reading a video before editing it', () => {
  it('get_studio_video shows a text layer\'s size and place; ids reads it in full', async () => {
    const id = await videoWithHeadline()
    const overview = await call('get_studio_video', { video_id: id })
    const layers = (overview.edit as { layers: Row[] }).layers
    expect(layers).toEqual([
      expect.objectContaining({ id: 'text-1', kind: 'text', name: 'Headline', x: 0.5, y: 0.3, look: 'title', style: { font: 'display', size: 0.09, weight: 'black', shadow: true } }),
    ])
    expect(overview.edit).toMatchObject({ format: 'original', captions: { enabled: false }, audio: [] })

    const full = await call('get_studio_video', { video_id: id, ids: ['text-1', 'captions', 'gone'] })
    expect(full).not.toHaveProperty('edit')
    expect(full).toMatchObject({
      success: true,
      video: { id, digest: expect.stringMatching(/^[a-f0-9]{64}$/) },
      not_found: ['gone'],
      items: [
        expect.objectContaining({ type: 'layer', id: 'text-1', rotate: 0, opacity: 1, style: expect.objectContaining({ size: 0.09, align: 'center', tracking: 'auto' }) }),
        expect.objectContaining({ type: 'captions', enabled: false, fontSize: 42 }),
      ],
    })
  })

  it('a layer\'s words come fenced as data, and written back as read they change nothing and never hold the marker', async () => {
    const id = await videoWithHeadline()
    const full = await call('get_studio_video', { video_id: id, ids: ['text-1'] })
    const layer = (full.items as Row[])[0]!
    expect(layer.text).toMatch(/^\[UNTRUSTED TRANSCRIPT CONTENT[^\n]*\nYour inbox, finally quiet\n\[END UNTRUSTED CONTENT\]$/)
    const digest = (full.video as { digest: string }).digest
    // The agent copies the value back unchanged: the words are kept, the marker is not.
    const back = await call('edit_studio_video', { video_id: id, expected_digest: digest, edits: [{ op: 'update_layer', args: { id: 'text-1', text: layer.text } }] })
    expect(back).toMatchObject({ success: true })
    const doc = JSON.stringify((tables_.studio_video![0] as { doc: unknown }).doc)
    expect(doc).toContain('"text":"Your inbox, finally quiet"')
    expect(doc).not.toContain('UNTRUSTED')
    // A marker anywhere else in a value is refused, and nothing is saved.
    const refused = await call('edit_studio_video', { video_id: id, edits: [{ op: 'update_layer', args: { id: 'text-1', text: `Hello ${layer.text}` } }] })
    expect(refused).toMatchObject({ success: false })
    expect(String(refused.error)).toMatch(/untrusted-content marker/)
    expect(await call('write_studio_script', { video_id: id, text: `[5s] Hook: ${layer.text}` })).toMatchObject({ success: false, code: 'INVALID' })
    // A media file's name is fenced in the media list too.
    const media = await call('list_studio_assets', {})
    expect((media.assets as Row[]).length).toBeGreaterThan(0)
    for (const a of media.assets as Row[]) expect(a.name).toMatch(/^\[UNTRUSTED FILE CONTENT/)
  })

  it('get_studio_catalog lists the defaults an overview leaves out and each look\'s style; get_studio_storyboard names the style pack', async () => {
    const catalog = await call('get_studio_catalog', {})
    expect(catalog).toMatchObject({
      success: true,
      defaults: { layer: { every: { rotate: 0, opacity: 1 }, kinds: { text: { style: { size: 0.06 } } } }, captions: { fontSize: 42 } },
      text_looks: { title: { size: 0.09 } },
    })
    const update = (catalog.commands as { name: string; description: string }[]).find((c) => c.name === 'update_layer')
    expect(update?.description).toContain('fraction of the frame height')

    const id = await videoWithHeadline()
    expect(await call('get_studio_storyboard', { video_id: id })).toMatchObject({ success: true, storyboard: { beats: [], stylePack: 'clean-product' } })
  })
})
