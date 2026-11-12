import { describe, expect, it } from 'vitest'
import { aspectLabel, lengthLabel, studioVideoCardOf, videoCardLine, STUDIO_VIDEO_CARD_TOOLS } from '../video-card'
import { TOOL_REGISTRY_MAP } from '@/lib/ai/tool-registry'

const video = {
  id: '6f0c1d7e-2b9a-4c11-9f3e-0a1b2c3d4e5f',
  title: 'Spring launch teaser',
  status: 'draft',
  width: 1080,
  height: 1920,
  seconds: 15.2,
  studio_project: { id: 'a1b2c3d4-0000-4000-8000-000000000001', title: 'Fernhill spring' },
  thumbnail_url: '/api/account/studio/projects/6f0c1d7e-2b9a-4c11-9f3e-0a1b2c3d4e5f/thumbnail.jpg',
}

describe('studioVideoCardOf', () => {
  it('draws the video a tool made, read or edited', () => {
    expect(studioVideoCardOf('create_studio_video', { success: true, video })).toMatchObject({ verb: 'made', video: { id: video.id, title: 'Spring launch teaser', studioProject: 'Fernhill spring' } })
    expect(studioVideoCardOf('get_studio_video', { success: true, video })?.verb).toBe('read')
    expect(studioVideoCardOf('edit_studio_video', { success: true, video, results: [{}, {}, {}] })).toMatchObject({ verb: 'edited', edits: 3 })
    expect(studioVideoCardOf('export_studio_video', { success: true, video, job: { id: 'j', kind: 'export', status: 'queued' } })?.verb).toBe('exporting')
  })

  it('draws a finished export with its file, and nothing for a job still running or another kind', () => {
    const done = { success: true, video, job: { id: 'j', kind: 'export', status: 'completed', download_url: 'https://example.test/file.mp4' } }
    expect(studioVideoCardOf('wait_for_studio_job', done)).toMatchObject({ verb: 'exported', downloadUrl: 'https://example.test/file.mp4' })
    expect(studioVideoCardOf('get_studio_job', { ...done, job: { ...done.job, status: 'failed' } })?.verb).toBe('export-failed')
    expect(studioVideoCardOf('get_studio_job', { ...done, job: { ...done.job, status: 'running' } })).toBeNull()
    expect(studioVideoCardOf('get_studio_job', { ...done, job: { ...done.job, kind: 'stills' } })).toBeNull()
  })

  it('draws nothing for a refusal, a missing video or another tool', () => {
    expect(studioVideoCardOf('get_studio_video', { success: false, code: 'NOT_FOUND', error: 'No such video.' })).toBeNull()
    expect(studioVideoCardOf('get_studio_video', { success: true })).toBeNull()
    expect(studioVideoCardOf('get_studio_video', { success: true, video: { id: 'x' } })).toBeNull()
    expect(studioVideoCardOf('list_studio_projects', { success: true, video })).toBeNull()
  })

  it('names only registry tools', () => {
    for (const name of STUDIO_VIDEO_CARD_TOOLS) expect(TOOL_REGISTRY_MAP.get(name)?.category.id, name).toBe('studio')
  })
})

describe('the card line', () => {
  it('says format, length and status', () => {
    expect(videoCardLine({ width: 1920, height: 1080, seconds: 15, status: 'review' })).toBe('16:9 · 0:15 · Review')
    expect(videoCardLine({ width: 1080, height: 1350, seconds: 62, status: null })).toBe('4:5 · 1:02')
    expect(aspectLabel(1001, 1999)).toBe('1001×1999')
    expect(aspectLabel(null, 1080)).toBeNull()
    expect(lengthLabel(3725)).toBe('1:02:05')
  })
})
