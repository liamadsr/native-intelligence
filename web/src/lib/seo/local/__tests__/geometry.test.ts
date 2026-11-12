/**
 * The rank grid's geometry (pure): the points of a grid from its centre,
 * radius and size, the zoom every point is searched at, the coordinate
 * strings the provider takes, and which grids are refused.
 */
import { describe, expect, it } from 'vitest'
import {
  buildLocalGrid,
  businessDataCoordinate,
  gridPointCount,
  gridProblem,
  gridSpacingKm,
  listingsCoordinate,
  localGridZoom,
  mapsCoordinate,
  pointOffsetKm,
} from '../geometry'

describe('buildLocalGrid', () => {
  it('lays a 3x3 out north row first, west to east, the centre in the middle', () => {
    // Radius 2 km on a 3x3: one point every 2 km.
    const points = buildLocalGrid({ latitude: 40, longitude: -74 }, 3, 2)
    expect(points).toHaveLength(9)
    expect(points.map((p) => [p.row, p.col])).toEqual([
      [0, 0],
      [0, 1],
      [0, 2],
      [1, 0],
      [1, 1],
      [1, 2],
      [2, 0],
      [2, 1],
      [2, 2],
    ])
    expect(points[0]).toEqual({
      row: 0,
      col: 0,
      latitude: 40.0180874,
      longitude: -74.0234532,
    })
    expect(points[4]).toEqual({ row: 1, col: 1, latitude: 40, longitude: -74 })
    expect(points[8]).toEqual({
      row: 2,
      col: 2,
      latitude: 39.9819126,
      longitude: -73.9765468,
    })
  })

  it('spreads a 7x7 evenly to the radius on every side', () => {
    const points = buildLocalGrid({ latitude: 45.52, longitude: -122.68 }, 7, 3)
    expect(points).toHaveLength(49)
    expect(gridSpacingKm(3, 7)).toBe(1)
    const centre = { latitude: 45.52, longitude: -122.68 }
    expect(pointOffsetKm(centre, points[0])).toEqual({ north: 3, east: -3 })
    expect(pointOffsetKm(centre, points[48])).toEqual({ north: -3, east: 3 })
    expect(pointOffsetKm(centre, points[24])).toEqual({ north: 0, east: 0 })
  })

  it('counts points', () => {
    expect([3, 5, 7].map(gridPointCount)).toEqual([9, 25, 49])
  })
})

describe('localGridZoom', () => {
  it('widens the view as the points spread out, within 4 to 18', () => {
    expect(localGridZoom(2, 40)).toBe(13)
    expect(localGridZoom(0.5, 40)).toBe(15)
    expect(localGridZoom(10, 40)).toBe(10)
    expect(localGridZoom(0.001, 0)).toBe(18)
    expect(localGridZoom(100_000, 0)).toBe(4)
  })
})

describe('coordinate strings', () => {
  it('formats a Maps point with its zoom, a business read with metres, a listings search with whole km', () => {
    expect(
      mapsCoordinate({ latitude: 33.123456789, longitude: -84.987654321 }, 13),
    ).toBe('33.1234568,-84.9876543,13z')
    expect(
      businessDataCoordinate(
        { latitude: 33.123456789, longitude: -84.987654321 },
        5,
      ),
    ).toBe('33.1234568,-84.9876543,5000')
    // The provider clamps the radius to 200 m - 199,999 m.
    expect(businessDataCoordinate({ latitude: 1, longitude: 2 }, 0.05)).toBe(
      '1,2,200',
    )
    expect(businessDataCoordinate({ latitude: 1, longitude: 2 }, 500)).toBe(
      '1,2,199999',
    )
    // The listings search refuses fractional radii.
    expect(listingsCoordinate({ latitude: 1, longitude: 2 }, 2.6)).toBe('1,2,3')
    expect(listingsCoordinate({ latitude: 1, longitude: 2 }, 0.2)).toBe('1,2,1')
  })
})

describe('gridProblem', () => {
  const centre = { latitude: 40, longitude: -74 }
  it('accepts a sensible grid', () => {
    expect(gridProblem(centre, 5, 3)).toBeNull()
    expect(gridProblem(centre, 7, 20)).toBeNull()
  })
  it('refuses sizes, radii and spacings out of range, and grids off the map', () => {
    expect(gridProblem(centre, 4, 3)).toMatch(/3×3/)
    expect(gridProblem(centre, 5, 0.1)).toMatch(/radius/)
    expect(gridProblem(centre, 5, 21)).toMatch(/radius/)
    // 0.5 km on a 7x7 is a point every 167 m: fine. On 3x3, 20 km is a point every 20 km: too far.
    expect(gridProblem(centre, 3, 20)).toMatch(/too far apart/)
    expect(gridProblem({ latitude: 84.95, longitude: 0 }, 7, 15)).toMatch(
      /edge of the map/,
    )
    expect(gridProblem({ latitude: 95, longitude: 0 }, 5, 3)).toMatch(/centre/)
  })
})
