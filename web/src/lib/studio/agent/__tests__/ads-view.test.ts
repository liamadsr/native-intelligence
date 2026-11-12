import { describe, expect, it } from 'vitest'
import { adsView, jobView } from '../job-tools'

describe('adsView', () => {
  it('a static batch: counts, the flagged ads and the notes, never the report', () => {
    const view = adsView('ads-static', {
      batchId: 'spring',
      ads: [
        { id: 'A1', flags: [], images: [{}, {}, {}, {}] },
        { id: 'A2', flags: ['contrast'], images: [{}, {}] },
      ],
      files: { reportMd: 'ads/j/report.md' },
      notes: ['A2 was made without people data.'],
    })
    expect(view).toEqual({ batch_id: 'spring', ads: 2, images: 6, flagged: ['A2'], notes: ['A2 was made without people data.'] })
  })

  it('a motion ad names the editable video it became', () => {
    expect(adsView('ads-motion', { briefId: 'm1', title: 'Launch', errors: 0, videoId: 'v-1', notes: [] })).toEqual({
      brief_id: 'm1',
      title: 'Launch',
      made_video_id: 'v-1',
      check_errors: 0,
      notes: [],
    })
  })

  it('a reel names its render', () => {
    expect(adsView('ads-reel', { reelId: 'r1', title: 'Reel', seconds: 9.5, render: { id: 'asset-1' }, notes: [] })).toEqual({
      reel_id: 'r1',
      title: 'Reel',
      seconds: 9.5,
      asset_id: 'asset-1',
      notes: [],
    })
  })

  it('jobView carries it for a finished ads job only', () => {
    const base = { id: 'j', progress: 1, error: null, video_id: null, input: {}, workspace_id: 'w' }
    const done = jobView({ ...base, kind: 'ads-reel', status: 'completed', result: { reelId: 'r1', title: 'Reel', seconds: 4, render: { id: 'a' }, notes: [] } } as never)
    expect(done).toMatchObject({ kind: 'ads-reel', reel_id: 'r1', asset_id: 'a' })
    const running = jobView({ ...base, kind: 'ads-reel', status: 'running', result: null } as never)
    expect(running).not.toHaveProperty('reel_id')
  })
})
