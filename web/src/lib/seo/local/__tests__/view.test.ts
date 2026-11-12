/**
 * The grid result the UI draws and the numbers it shows: the summary (share
 * of points in the top 3, average position where found), a keyword's square
 * of cells, the colour bands, and the competitors seen most.
 */
import { describe, expect, it } from 'vitest'
import { buildLocalGrid } from '../geometry'
import {
  buildGridRows,
  cellBand,
  competitorsSeen,
  summarizeCells,
  type LocalPointCompetitor,
  type LocalScanPointRow,
} from '../view'

const c = (
  position: number,
  title: string,
  cid: string | null,
  is_target = false,
): LocalPointCompetitor => ({
  position,
  title,
  cid,
  place_id: null,
  rating: 4.5,
  review_count: 100,
  is_target,
})

describe('summarizeCells', () => {
  it('counts collected points, the top 3 share of those, and the average where found', () => {
    const summary = summarizeCells([
      { status: 'found', position: 1 },
      { status: 'found', position: 2 },
      { status: 'found', position: 9 },
      { status: 'not_found', position: null },
      { status: 'not_collected', position: null },
      { status: 'pending', position: null },
    ])
    expect(summary).toEqual({
      points_total: 6,
      points_collected: 4,
      points_found: 3,
      top3: 2,
      top10: 3,
      top3_percent: 50,
      average_position: 4,
    })
  })

  it('says nothing about shares or averages before anything came back', () => {
    expect(
      summarizeCells([{ status: 'pending', position: null }]),
    ).toMatchObject({ top3_percent: null, average_position: null })
    expect(
      summarizeCells([{ status: 'not_found', position: null }]),
    ).toMatchObject({ top3_percent: 0, average_position: null })
  })

  it('rounds the average to one decimal', () => {
    expect(
      summarizeCells([
        { status: 'found', position: 1 },
        { status: 'found', position: 2 },
        { status: 'found', position: 2 },
      ]).average_position,
    ).toBe(1.7)
  })
})

describe('buildGridRows', () => {
  const planned = buildLocalGrid({ latitude: 40, longitude: -74 }, 3, 2)
  const point = (
    row: number,
    col: number,
    status: LocalScanPointRow['status'],
    position: number | null,
    competitors: LocalPointCompetitor[] = [],
  ): LocalScanPointRow => ({
    keyword: 'dentist',
    row,
    col,
    latitude: 0,
    longitude: 0,
    status,
    position,
    results_count: status === 'collected' ? competitors.length : null,
    competitors,
  })

  it('gives every planned point a cell, in a square, with who was first there', () => {
    const rows = buildGridRows(
      3,
      planned,
      [
        point(0, 0, 'collected', 2, [
          c(1, 'Northside Dental', '999'),
          c(2, 'Fernhill Dental', '123', true),
        ]),
        point(1, 1, 'collected', null, [c(1, 'Northside Dental', '999')]),
        point(2, 2, 'not_collected', null),
      ],
      false,
    )
    expect(rows).toHaveLength(3)
    expect(rows.every((row) => row.length === 3)).toBe(true)
    expect(rows[0][0]).toMatchObject({
      status: 'found',
      position: 2,
      results_count: 2,
      top_result: { title: 'Northside Dental', cid: '999' },
    })
    expect(rows[1][1]).toMatchObject({
      status: 'not_found',
      position: null,
      results_count: 1,
    })
    expect(rows[2][2]).toMatchObject({
      status: 'not_collected',
      results_count: null,
      top_result: null,
    })
    // No row stored: not collected once the scan ended, with the planned coordinate.
    expect(rows[0][1]).toMatchObject({
      status: 'not_collected',
      latitude: planned[1].latitude,
      longitude: planned[1].longitude,
    })
  })

  it('shows missing points as pending while the scan runs', () => {
    const rows = buildGridRows(3, planned, [], true)
    expect(rows.flat().every((cell) => cell.status === 'pending')).toBe(true)
  })
})

describe('cellBand', () => {
  it('bands positions for the square’s colours', () => {
    expect(cellBand({ status: 'found', position: 3 })).toBe('top3')
    expect(cellBand({ status: 'found', position: 4 })).toBe('top10')
    expect(cellBand({ status: 'found', position: 11 })).toBe('top20')
    expect(cellBand({ status: 'not_found', position: null })).toBe('not_found')
    expect(cellBand({ status: 'not_collected', position: null })).toBe(
      'not_collected',
    )
    expect(cellBand({ status: 'pending', position: null })).toBe('pending')
  })
})

describe('competitorsSeen', () => {
  it('ranks other businesses by first places, then top-3 places, leaving the tracked one out', () => {
    const base = {
      keyword: 'dentist',
      row: 0,
      col: 0,
      latitude: 0,
      longitude: 0,
      status: 'collected' as const,
      position: null,
      results_count: 3,
    }
    const seen = competitorsSeen(
      [
        {
          ...base,
          competitors: [
            c(1, 'Northside Dental', '999'),
            c(2, 'Fernhill Dental', '123', true),
            c(3, 'Oak Street Smiles', '555'),
          ],
        },
        {
          ...base,
          col: 1,
          competitors: [
            c(1, 'Northside Dental', '999'),
            c(2, 'Oak Street Smiles', '555'),
          ],
        },
        {
          ...base,
          col: 2,
          competitors: [
            c(1, 'Oak Street Smiles', '555'),
            c(4, 'Northside Dental', '999'),
          ],
        },
        // Not collected points don't count.
        {
          ...base,
          row: 1,
          status: 'not_collected',
          competitors: [c(1, 'Ghost Dental', '000')],
        },
      ],
      10,
    )
    expect(seen.map((entry) => entry.title)).toEqual([
      'Northside Dental',
      'Oak Street Smiles',
    ])
    expect(seen[0]).toMatchObject({
      points_first: 2,
      points_top3: 2,
      best_position: 1,
      average_position: 2,
    })
    expect(seen[1]).toMatchObject({
      points_first: 1,
      points_top3: 3,
      average_position: 2,
    })
  })
})
