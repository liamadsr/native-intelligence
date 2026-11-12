/**
 * What the Studio's sub-nav lists and lights (studio-panel-model.ts; Liam,
 * 11-12: the Studio "needs to match the rest of our app"): Studio projects
 * as folders (the open video's open by itself), the videos in none, the open
 * video's pages under it, exactly one row lit from where the Studio is.
 * Fixtures are made up.
 */
import { describe, expect, it } from 'vitest'
import type { CampaignSummary } from '@/lib/studio/engine/api'
import {
  NO_VIDEOS_YET,
  pressMoves,
  shapeOf,
  studioPanelModel,
  type StudioPanelModel,
  type StudioPanelPlace,
} from '../studio-panel-model'

const video = (id: string, title: string, over: Partial<CampaignSummary['ads'][number]> = {}): CampaignSummary['ads'][number] => ({
  id,
  title,
  updatedAt: '2026-11-10T10:00:00.000Z',
  durationSeconds: 15,
  clipCount: 1,
  hasCamera: false,
  hasSlides: false,
  thumbnail: { assetId: 'a', seconds: 0 },
  width: 1080,
  height: 1920,
  castCount: 0,
  status: 'draft',
  ...over,
})

const project = (id: string, title: string, ads: CampaignSummary['ads']): CampaignSummary => ({
  id,
  title,
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-10T10:00:00.000Z',
  single: false,
  castCount: 0,
  ads,
})

const single = (v: CampaignSummary['ads'][number]): CampaignSummary => ({ ...project(`single-${v.id}`, v.title, [v]), single: true })

/** The server's answer: Studio projects and lone videos, newest activity first. */
const LIST: CampaignSummary[] = [
  project('p-spring', 'Fernhill spring', [
    video('v-teaser', 'Spring teaser'),
    video('v-teaser-sq', 'Spring teaser', { variantOf: 'v-teaser', width: 1080, height: 1080 }),
    video('v-recap', 'Workshop recap'),
  ]),
  single(video('v-hello', 'Hello Studio')),
  project('p-autumn', 'Autumn open day', [video('v-tour', 'Studio tour')]),
  project('p-empty', 'Winter ideas', []),
]

const place = (videoId: string | null, page: StudioPanelPlace['page'] = null, title: string | null = null): StudioPanelPlace => ({ videoId, page, title })

const labels = (m: StudioPanelModel, key: 'projects' | 'videos') =>
  m.sections.find((s) => s.key === key)!.rows.map((r) => `${'  '.repeat(r.depth)}${r.label}${r.hint ? ` (${r.hint})` : ''}`)
const litLabel = (m: StudioPanelModel) => m.sections.flatMap((s) => s.rows).find((r) => r.key === m.lit)?.label ?? null

describe('the Studio sub-nav’s rows', () => {
  it('not read yet: the two headings alone, no rows, nothing lit (nothing shows then goes)', () => {
    const m = studioPanelModel(null, place('v-teaser', 'edit'))
    expect(m.sections.map((s) => s.heading)).toEqual(['Studio projects', 'Videos'])
    expect(m.sections.every((s) => s.rows.length === 0)).toBe(true)
    expect(m.lit).toBeNull()
  })

  it('Studio projects as folders, the open video’s open with its overview, its videos and the open one’s pages; the lone videos after', () => {
    const m = studioPanelModel(LIST, place('v-teaser', 'storyboard'))
    expect(labels(m, 'projects')).toEqual([
      'Fernhill spring',
      '  Project overview',
      '  Spring teaser',
      '    Overview',
      '    Storyboard',
      '    Cast',
      '    Edit',
      '  Workshop recap',
      'Autumn open day',
      'Winter ideas',
    ])
    expect(labels(m, 'videos')).toEqual(['Hello Studio'])
    expect(m.openProjectId).toBe('p-spring')
    const rows = m.sections[0]!.rows
    expect(rows.find((r) => r.label === 'Fernhill spring')).toMatchObject({ expanded: true, current: true })
    expect(rows.find((r) => r.label === 'Autumn open day')).toMatchObject({ expanded: false })
    expect(rows.find((r) => r.key === 'video:v-teaser')).toMatchObject({ current: true })
  })

  it('exactly one row lit, from where the Studio is: a page, the project’s overview, the video while its page is not known', () => {
    expect(litLabel(studioPanelModel(LIST, place('v-teaser', 'storyboard')))).toBe('Storyboard')
    expect(studioPanelModel(LIST, place('v-teaser', 'storyboard')).lit).toBe('page:v-teaser:storyboard')
    expect(litLabel(studioPanelModel(LIST, place('v-teaser', 'project')))).toBe('Project overview')
    expect(litLabel(studioPanelModel(LIST, place('v-teaser', null)))).toBe('Spring teaser')
    // A lone video: its own row is its overview.
    expect(litLabel(studioPanelModel(LIST, place('v-hello', 'project')))).toBe('Hello Studio')
    expect(labels(studioPanelModel(LIST, place('v-hello', 'cast')), 'videos')).toEqual(['Hello Studio', '  Overview', '  Storyboard', '  Cast', '  Edit'])
    expect(studioPanelModel(LIST, place('v-hello', 'cast')).lit).toBe('page:v-hello:cast')
    // Nothing open: nothing lit, every folder closed.
    const none = studioPanelModel(LIST, null)
    expect(none.lit).toBeNull()
    expect(none.sections[0]!.rows.every((r) => r.kind === 'project')).toBe(true)
  })

  it('folders the person opens or closes: another project opens without moving anything; the open one closed lights its project', () => {
    const opened = studioPanelModel(LIST, place('v-teaser', 'edit'), new Map([['p-autumn', true]]))
    expect(labels(opened, 'projects').slice(-4)).toEqual(['Autumn open day', '  Project overview', '  Studio tour', 'Winter ideas'])
    // A project with no video yet says so when opened.
    expect(labels(studioPanelModel(LIST, null, new Map([['p-empty', true]])), 'projects').slice(-2)).toEqual(['Winter ideas', `  ${NO_VIDEOS_YET}`])
    const closed = studioPanelModel(LIST, place('v-teaser', 'edit'), new Map([['p-spring', false]]))
    expect(labels(closed, 'projects')).toEqual(['Fernhill spring', 'Autumn open day', 'Winter ideas'])
    expect(closed.lit).toBe('project:p-spring')
  })

  it('a project’s overview opens on the open video when it is in it, else on its first video', () => {
    const m = studioPanelModel(LIST, place('v-recap', 'edit'), new Map([['p-autumn', true]]))
    const overviews = m.sections[0]!.rows.filter((r) => r.kind === 'overview').map((r) => r.act)
    expect(overviews).toEqual([
      { kind: 'go', videoId: 'v-recap', page: 'project' },
      { kind: 'go', videoId: 'v-tour', page: 'project' },
    ])
  })

  it('a format version is listed only while it is the open one, after its video, with its shape', () => {
    expect(labels(studioPanelModel(LIST, place('v-recap', 'edit')), 'projects')).not.toContain('  Spring teaser (1:1)')
    const m = studioPanelModel(LIST, place('v-teaser-sq', 'edit'))
    expect(labels(m, 'projects').slice(0, 5)).toEqual(['Fernhill spring', '  Project overview', '  Spring teaser', '  Spring teaser (1:1)', '    Overview'])
    expect(m.lit).toBe('page:v-teaser-sq:edit')
    expect(shapeOf(1080, 1350)).toBe('4:5')
    expect(shapeOf(0, 1080)).toBeNull()
  })

  it('the open video’s title as the Studio has it now (a rename shows at once)', () => {
    const m = studioPanelModel(LIST, place('v-teaser', 'edit', 'Spring teaser, final'))
    expect(labels(m, 'projects')[2]).toBe('  Spring teaser, final')
  })

  it('a video made since the list was read: listed first among the videos, and the list is stale', () => {
    const m = studioPanelModel(LIST, place('v-new', 'edit', 'Untitled video'))
    expect(m.stale).toBe(true)
    expect(labels(m, 'videos').slice(0, 2)).toEqual(['Untitled video', '  Overview'])
    expect(m.lit).toBe('page:v-new:edit')
    expect(studioPanelModel(LIST, place('v-teaser', 'edit')).stale).toBe(false)
  })

  it('a workspace with no video at all: both headings for their “+”, and one line saying so', () => {
    const m = studioPanelModel([], null)
    expect(m.sections.map((s) => s.heading)).toEqual(['Studio projects', 'Videos'])
    expect(m.sections[0]!.rows).toEqual([])
    expect(m.sections[1]!.rows.map((r) => [r.kind, r.label])).toEqual([['note', NO_VIDEOS_YET]])
  })
})

describe('what a press asks', () => {
  it('moves only when the Studio is not there already', () => {
    const here = place('v-teaser', 'edit')
    expect(pressMoves({ kind: 'go', videoId: 'v-teaser', page: 'edit' }, here)).toBe(false)
    expect(pressMoves({ kind: 'go', videoId: 'v-teaser', page: null }, here)).toBe(false)
    expect(pressMoves({ kind: 'go', videoId: 'v-teaser', page: 'cast' }, here)).toBe(true)
    expect(pressMoves({ kind: 'go', videoId: 'v-recap', page: null }, here)).toBe(true)
    expect(pressMoves({ kind: 'go', videoId: 'v-teaser', page: 'project' }, here)).toBe(true)
    expect(pressMoves({ kind: 'toggle', projectId: 'p-spring' }, here)).toBe(false)
    expect(pressMoves({ kind: 'go', videoId: 'v-teaser', page: 'edit' }, null)).toBe(true)
  })
})
