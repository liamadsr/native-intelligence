/**
 * The Studio as a card the agent shows and reads (./page-server.ts): `show`
 * opens it on a video or a Studio project found by name among the
 * workspace's own (never another workspace's, never the trash), and read_card
 * reads the Studio projects with their videos at the top level and a video's
 * summary on a video, never the whole edit. Made-up names.
 */
import { describe, expect, it } from 'vitest'
import { buildCardContextEntry, parseCardContext } from '../context'
import { WS, allText, pageTools, seededWorkspace } from './page-fixtures'

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const PROJECT = uuid(1001)
const TEASER = uuid(1101)
const LOOSE = uuid(1102)

function studioWorkspace(features: Record<string, 'on' | 'off'> = {}) {
  const db = seededWorkspace(features)
  db.seed('studio_project', [
    { id: PROJECT, title: 'Fernhill spring', client: 'Fernhill Studio', workspace_id: WS, archived_at: null, updated_at: '2031-03-02' },
    { id: uuid(1002), title: 'Other workspace launch', workspace_id: 'ws-other', archived_at: null, updated_at: '2031-03-03' },
  ])
  db.seed('studio_video', [
    { id: TEASER, title: 'Spring teaser', status: 'review', studio_project_id: PROJECT, summary: { durationSeconds: 15, width: 1080, height: 1920 }, workspace_id: WS, archived_at: null, updated_at: '2031-03-02' },
    { id: LOOSE, title: 'Loose cut', status: 'draft', studio_project_id: null, summary: { durationSeconds: 8, width: 1920, height: 1080 }, workspace_id: WS, archived_at: null, updated_at: '2031-03-01' },
    { id: uuid(1103), title: 'Trashed teaser', status: 'draft', studio_project_id: PROJECT, summary: {}, workspace_id: WS, archived_at: '2031-03-01', updated_at: '2031-03-01' },
    { id: uuid(1104), title: 'Their teaser', status: 'draft', studio_project_id: null, summary: {}, workspace_id: 'ws-other', archived_at: null, updated_at: '2031-03-01' },
  ])
  return db
}

describe('the Studio card', () => {
  it('show opens it on a video found by name, among this workspace’s videos out of the trash', async () => {
    const out = await pageTools(studioWorkspace()).show({ kind: 'studio', title: 'Spring teaser', target: 'spring teaser', tab: 'edit' })
    expect(out).toMatchObject({ success: true, card: { kind: 'studio', target: { type: 'studio_video', id: TEASER, label: 'Spring teaser' }, tab: 'edit' } })
    const theirs = await pageTools(studioWorkspace()).show({ kind: 'studio', title: 'T', target: 'Their teaser' })
    expect(theirs.success).toBe(false)
    expect(allText(theirs)).not.toContain(uuid(1104))
    const trashed = await pageTools(studioWorkspace()).show({ kind: 'studio', title: 'T', target: 'Trashed teaser' })
    expect(trashed.success).toBe(false)
  })

  it('read_card at the top level: the Studio projects with their videos, and the videos in none', async () => {
    const parsed = parseCardContext([buildCardContextEntry({ n: 4, id: 's', spec: { kind: 'studio', title: 'Studio' } })])
    const read = await pageTools(studioWorkspace(), parsed).readCard({ card: 4 })
    expect(read).toMatchObject({
      success: true,
      showing: 'Studio projects',
      total: 1,
      studio_projects: [{ id: PROJECT, title: 'Fernhill spring', videos: [{ id: TEASER, title: 'Spring teaser', status: 'review', seconds: 15, width: 1080, height: 1920 }] }],
      videos_in_no_studio_project: [{ id: LOOSE, title: 'Loose cut' }],
    })
    expect(allText(read)).not.toContain('Other workspace launch')
    expect(allText(read)).not.toContain('Trashed teaser')
  })

  it('is off where Studio is off', async () => {
    const out = await pageTools(studioWorkspace({ studio: 'off' })).show({ kind: 'studio', title: 'Studio' })
    expect(out.error).toContain('Studio is off in this workspace')
  })
})
