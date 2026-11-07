/**
 * Where the sun is: elevation above the horizon and compass azimuth, for an
 * instant and a place. The NOAA solar calculator's formulas (the same ones
 * SunCalc-style libraries use), no dependency. Accurate to a fraction of a
 * degree, which is far more than a background needs.
 *
 * Pure and timezone-free: a Date is an instant, so the browser's clock is all
 * the time there is to know.
 */

const RAD = Math.PI / 180
const DEG = 180 / Math.PI

export interface SolarPosition {
  /** Degrees above the horizon (negative below). Geometric, without refraction. */
  elevation: number
  /** Compass bearing in degrees, clockwise from north (90 east, 180 south, 270 west). */
  azimuth: number
}

export function solarPosition(date: Date, latitude: number, longitude: number): SolarPosition {
  const ms = date.getTime()
  const julianDay = ms / 86_400_000 + 2_440_587.5
  const t = (julianDay - 2_451_545) / 36_525

  const meanLong = mod(280.46646 + t * (36_000.76983 + t * 0.0003032), 360)
  const meanAnomaly = 357.52911 + t * (35_999.05029 - 0.0001537 * t)
  const eccentricity = 0.016708634 - t * (0.000042037 + 0.0000001267 * t)
  const m = meanAnomaly * RAD
  const center =
    Math.sin(m) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * m) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * m) * 0.000289
  const trueLong = meanLong + center
  const omega = (125.04 - 1934.136 * t) * RAD
  const apparentLong = (trueLong - 0.00569 - 0.00478 * Math.sin(omega)) * RAD
  const meanObliquity = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60
  const obliquity = (meanObliquity + 0.00256 * Math.cos(omega)) * RAD
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(apparentLong))

  const y = Math.tan(obliquity / 2) ** 2
  const l0 = meanLong * RAD
  const equationOfTime =
    4 *
    DEG *
    (y * Math.sin(2 * l0) -
      2 * eccentricity * Math.sin(m) +
      4 * eccentricity * y * Math.sin(m) * Math.cos(2 * l0) -
      0.5 * y * y * Math.sin(4 * l0) -
      1.25 * eccentricity * eccentricity * Math.sin(2 * m))

  const minutesUtc = mod(ms, 86_400_000) / 60_000
  const trueSolarTime = mod(minutesUtc + equationOfTime + 4 * longitude, 1440)
  let hourAngle = trueSolarTime / 4 - 180
  if (hourAngle < -180) hourAngle += 360
  const h = hourAngle * RAD
  const lat = latitude * RAD

  const cosZenith = clamp(
    Math.sin(lat) * Math.sin(declination) + Math.cos(lat) * Math.cos(declination) * Math.cos(h),
    -1,
    1,
  )
  const elevation = 90 - Math.acos(cosZenith) * DEG
  const azimuth = mod(
    Math.atan2(Math.sin(h), Math.cos(h) * Math.sin(lat) - Math.tan(declination) * Math.cos(lat)) * DEG + 180,
    360,
  )
  return { elevation, azimuth }
}

/** The sun's centre at the horizon as people see it: geometric -0.833° (refraction and its radius). */
export const SUNRISE_ELEVATION = -0.833
const CROSSING_STEP_MS = 10 * 60_000
const CROSSING_LIMIT_MS = 26 * 3_600_000

/**
 * The next sunrise ('rise') or sunset ('set') after `from` at a place, to
 * within a few seconds, or null when there is none in the next 26 hours (the
 * polar day or night). A ten-minute scan for the crossing, then a bisection:
 * at most ~170 positions, only when someone asks.
 */
export function nextSunCrossing(from: Date, latitude: number, longitude: number, kind: 'rise' | 'set'): Date | null {
  const above = (ms: number) => solarPosition(new Date(ms), latitude, longitude).elevation - SUNRISE_ELEVATION
  const start = from.getTime()
  let t0 = start
  let e0 = above(t0)
  for (let t1 = start + CROSSING_STEP_MS; t1 <= start + CROSSING_LIMIT_MS; t1 += CROSSING_STEP_MS) {
    const e1 = above(t1)
    if (kind === 'rise' ? e0 < 0 && e1 >= 0 : e0 >= 0 && e1 < 0) {
      let lo = t0
      let hi = t1
      for (let i = 0; i < 12; i++) {
        const mid = (lo + hi) / 2
        const em = above(mid)
        if (kind === 'rise' ? em < 0 : em >= 0) lo = mid
        else hi = mid
      }
      return new Date(Math.round(hi))
    }
    t0 = t1
    e0 = e1
  }
  return null
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}
