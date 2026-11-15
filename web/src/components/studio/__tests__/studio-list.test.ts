/**
 * The Studio's list for the Studio card (studio-list.ts): which Studio project a video is in, read per workspace,
 * one read at a time, what was there kept when a read fails. Ids and names are made up.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CampaignSummary } from '@/lib/studio/engine/api'
import { __resetStudioListsForTests, projectOfVideo, readStudioList, studioList } from '../studio-list'

const LIST = [
  { id: 'camp-spring', title: 'Spring launch', single: false, ads: [{ id: 'v-teaser' }, { id: 'v-teaser-square', variantOf: 'v-teaser' }] },
  { id: 'single-v-tour', title: 'Product tour', single: true, ads: [{ id: 'v-tour' }] },
] as unknown as CampaignSummary[]

afterEach(() => {
  __resetStudioListsForTests()
  vi.unstubAllGlobals()
})

describe('the Studio’s list', () => {
  it('names the Studio project a video is in (its format versions too); none for a lone video or one not listed', () => {
    expect(projectOfVideo(LIST, 'v-teaser')?.id).toBe('camp-spring')
    expect(projectOfVideo(LIST, 'v-teaser-square')?.id).toBe('camp-spring')
    expect(projectOfVideo(LIST, 'v-tour')).toBeNull()
    expect(projectOfVideo(LIST, 'v-unknown')).toBeNull()
  })

  it('reads per workspace, one read at a time (one asked for meanwhile runs once after it), and keeps what it had when a read fails', async () => {
    let calls = 0
    let ok = true
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1
      return { ok, json: async () => ({ campaigns: LIST }) } as Response
    }))
    expect(studioList('ws-fernhill')).toBeNull()
    const first = readStudioList('ws-fernhill')
    void readStudioList('ws-fernhill')
    void readStudioList('ws-fernhill')
    await first
    await vi.waitFor(() => expect(calls).toBe(2))
    expect(studioList('ws-fernhill')).toEqual(LIST)
    expect(studioList('ws-other')).toBeNull()
    ok = false
    await readStudioList('ws-fernhill')
    expect(studioList('ws-fernhill')).toEqual(LIST)
  })
})
