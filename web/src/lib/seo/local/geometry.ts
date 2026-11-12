/**
 * The rank grid's geometry, pure: the points of a square grid around a
 * centre, the map zoom every point is searched at, and the coordinate strings
 * the provider takes. Client safe (the UI draws the same square).
 *
 * A grid is a centre, a radius (km from the centre to the edge) and a size
 * (points across: 3, 5 or 7). Its points are spaced evenly, so the spacing is
 * twice the radius over the gaps between points. Row 0 is the northern edge
 * and column 0 the western one; points are in row-major order.
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import {
  GRID_SIZES,
  MAX_RADIUS_KM,
  MAX_SPACING_KM,
  MIN_RADIUS_KM,
  MIN_SPACING_KM,
  type LocalGridSize,
} from './limits'

export interface LatLng {
  latitude: number
  longitude: number
}

export interface LocalGridPoint extends LatLng {
  row: number
  col: number
}

const KM_PER_LATITUDE_DEGREE = 110.574

function kmPerLongitudeDegree(latitude: number): number {
  return 111.32 * Math.max(Math.abs(Math.cos((latitude * Math.PI) / 180)), 0.01)
}

export function isGridSize(value: unknown): value is LocalGridSize {
  return (
    typeof value === 'number' &&
    (GRID_SIZES as readonly number[]).includes(value)
  )
}

/** km between neighbouring points, to three decimals. */
export function gridSpacingKm(radiusKm: number, size: number): number {
  if (size < 2) return 0
  return Number(((2 * radiusKm) / (size - 1)).toFixed(3))
}

/** Points in a grid of this size. */
export function gridPointCount(size: number): number {
  return size * size
}

/**
 * The points of the grid, north row first, west to east. Coordinates are
 * rounded to 7 decimals (about a centimetre) so equal grids give equal
 * strings.
 */
export function buildLocalGrid(
  center: LatLng,
  size: number,
  radiusKm: number,
): LocalGridPoint[] {
  const spacingKm = size < 2 ? 0 : (2 * radiusKm) / (size - 1)
  const middle = (size - 1) / 2
  const latitudeStep = spacingKm / KM_PER_LATITUDE_DEGREE
  const longitudeStep = spacingKm / kmPerLongitudeDegree(center.latitude)
  return Array.from({ length: size * size }, (_, index) => {
    const row = Math.floor(index / size)
    const col = index % size
    return {
      row,
      col,
      latitude: Number(
        (center.latitude + (middle - row) * latitudeStep).toFixed(7),
      ),
      longitude: Number(
        (center.longitude + (col - middle) * longitudeStep).toFixed(7),
      ),
    }
  })
}

/**
 * The map zoom every point of a grid is searched at, the same at every point.
 *
 * Without an explicit zoom the provider infers one per coordinate, which
 * empties some points and makes positions incomparable across the grid. A
 * fixed zoom fails the other way: a phone's viewport at zoom 14 spans only
 * about 1.5 km either side at mid latitudes, so a business one step to the
 * side falls out of view and reads as "not found". A world tile is
 * 40075·cos(lat)/2^z km wide and a portrait viewport about 1.5 tiles, so the
 * largest zoom whose viewport still spans about 1.25 times the spacing is
 * log2(24045·cos(lat)/spacing).
 */
export function localGridZoom(spacingKm: number, latitude: number): number {
  const cosine = Math.max(Math.abs(Math.cos((latitude * Math.PI) / 180)), 0.01)
  const spacing = Math.max(spacingKm, 0.01)
  return Math.min(
    18,
    Math.max(4, Math.floor(Math.log2((24045 * cosine) / spacing))),
  )
}

/** A coordinate as the provider wants it: at most 7 decimals, no trailing zeros. */
export function formatCoordinate(value: number): string {
  return Number(value.toFixed(7)).toString()
}

/** "lat,lng,13z": a Maps search's coordinate with its zoom. */
export function mapsCoordinate(point: LatLng, zoom: number): string {
  return `${formatCoordinate(point.latitude)},${formatCoordinate(point.longitude)},${zoom}z`
}

/**
 * "lat,lng,radius" with the radius in metres, as the business profile,
 * reviews, posts and questions reads want it (the provider clamps it to
 * 200 m - 199,999 m).
 */
export function businessDataCoordinate(
  point: LatLng,
  radiusKm: number,
): string {
  const metres = Math.min(199_999, Math.max(200, Math.round(radiusKm * 1000)))
  return `${formatCoordinate(point.latitude)},${formatCoordinate(point.longitude)},${metres}`
}

/** "lat,lng,radius" with the radius in whole km, as the business listings search wants it (it refuses fractions). */
export function listingsCoordinate(point: LatLng, radiusKm: number): string {
  return `${formatCoordinate(point.latitude)},${formatCoordinate(point.longitude)},${Math.max(1, Math.round(radiusKm))}`
}

export function isLatitude(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= -90 &&
    value <= 90
  )
}

export function isLongitude(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= -180 &&
    value <= 180
  )
}

/** Why this grid can't be searched, in words for the person, or null when it can. */
export function gridProblem(
  center: LatLng,
  size: unknown,
  radiusKm: unknown,
): string | null {
  if (!isLatitude(center.latitude) || !isLongitude(center.longitude))
    return 'The grid’s centre isn’t a place on the map.'
  if (!isGridSize(size))
    return `A grid is ${GRID_SIZES.map((s) => `${s}×${s}`).join(', ')}.`
  if (
    typeof radiusKm !== 'number' ||
    !Number.isFinite(radiusKm) ||
    radiusKm < MIN_RADIUS_KM ||
    radiusKm > MAX_RADIUS_KM
  ) {
    return `The radius is between ${MIN_RADIUS_KM} and ${MAX_RADIUS_KM} km.`
  }
  const spacing = (2 * radiusKm) / (size - 1)
  if (spacing < MIN_SPACING_KM)
    return 'The points of that grid are too close together. Use a larger radius or a smaller grid.'
  if (spacing > MAX_SPACING_KM)
    return 'The points of that grid are too far apart. Use a smaller radius or a larger grid.'
  for (const point of buildLocalGrid(center, size, radiusKm)) {
    if (Math.abs(point.latitude) > 85 || Math.abs(point.longitude) > 180) {
      return 'This grid reaches past the edge of the map. Use a smaller radius.'
    }
  }
  return null
}

/** How far north and east of the centre a point is, in km (negative: south, west). */
export function pointOffsetKm(
  center: LatLng,
  point: LatLng,
): { north: number; east: number } {
  const north = (point.latitude - center.latitude) * KM_PER_LATITUDE_DEGREE
  const east =
    (point.longitude - center.longitude) * kmPerLongitudeDegree(center.latitude)
  return { north: Number(north.toFixed(2)), east: Number(east.toFixed(2)) }
}
