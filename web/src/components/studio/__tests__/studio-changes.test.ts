/**
 * Which of the Studio's calls change its list of videos and Studio projects
 * (studio-changes.ts): those the Studio's sub-nav reads its list again for,
 * and only those (never a save of an edit). Ids are made up.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { __resetStudioChangesForTests, changesStudioList, noteStudioCall, studioRevision, subscribeStudioChanges } from '../studio-changes'

const API = '/api/account/studio'

afterEach(() => __resetStudioChangesForTests())

describe('a change of the Studio’s list', () => {
  it('a Studio project made, renamed, filed into, a video in it, ungrouped', () => {
    expect(changesStudioList('POST', `${API}/campaigns`)).toBe(true)
    expect(changesStudioList('POST', `${API}/campaigns/p-1`)).toBe(true)
    expect(changesStudioList('PATCH', `${API}/campaigns/p-1`)).toBe(true)
    expect(changesStudioList('POST', `${API}/campaigns/p-1/ads`)).toBe(true)
    expect(changesStudioList('POST', `${API}/campaigns/single-v-1/new-ad`)).toBe(true)
    expect(changesStudioList('POST', `${API}/campaigns/p-1/dissolve`)).toBe(true)
  })

  it('a video made, archived, renamed, duplicated, its status, taken out, a new format', () => {
    expect(changesStudioList('POST', `${API}/projects/blank`)).toBe(true)
    expect(changesStudioList('DELETE', `${API}/projects/v-1`)).toBe(true)
    expect(changesStudioList('PATCH', `${API}/projects/v-1`)).toBe(true)
    for (const what of ['duplicate', 'rename', 'status', 'unfile', 'formats']) {
      expect(changesStudioList('POST', `${API}/projects/v-1/${what}`)).toBe(true)
    }
  })

  it('not a read, a save of the edit, the work inside one video, nor a brand kit or ad batch', () => {
    expect(changesStudioList('GET', `${API}/campaigns`)).toBe(false)
    expect(changesStudioList('PUT', `${API}/projects/v-1`)).toBe(false)
    expect(changesStudioList('POST', `${API}/projects/v-1/ops`)).toBe(false)
    expect(changesStudioList('POST', `${API}/projects/v-1/versions/3/restore`)).toBe(false)
    expect(changesStudioList('POST', `${API}/uploads`)).toBe(false)
    expect(changesStudioList('PUT', `${API}/campaigns/p-1/brand-kit`)).toBe(false)
    expect(changesStudioList('POST', `${API}/campaigns/p-1/static-ads`)).toBe(false)
  })

  it('heard by its listeners, a new number each time', () => {
    let heard = 0
    const stop = subscribeStudioChanges(() => heard++)
    noteStudioCall('PUT', `${API}/projects/v-1`)
    expect([heard, studioRevision()]).toEqual([0, 0])
    noteStudioCall('POST', `${API}/projects/v-1/rename`)
    expect([heard, studioRevision()]).toEqual([1, 1])
    stop()
    noteStudioCall('DELETE', `${API}/projects/v-1`)
    expect([heard, studioRevision()]).toEqual([1, 2])
  })
})
