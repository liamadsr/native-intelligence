import { describe, expect, it } from 'vitest'
import { CLEAR_SKY, CIRRUS_LABEL_MIN, SKY_CONDITION_LABELS, coverLabel, denseCover, readSymbol, skyWeatherFromMetNorway } from '../weather'

function met(details: Record<string, number>, symbol?: string, amount?: number, period: 'next_1_hours' | 'next_6_hours' = 'next_1_hours') {
  return {
    properties: {
      timeseries: [
        {
          time: '2026-10-09T12:00:00Z',
          data: {
            instant: { details },
            ...(symbol
              ? { [period]: { summary: { symbol_code: symbol }, details: amount === undefined ? {} : { precipitation_amount: amount } } }
              : {}),
          },
        },
      ],
    },
  }
}

describe('readSymbol', () => {
  it('reads clear and cloudy skies', () => {
    expect(readSymbol('clearsky_day')).toMatchObject({ precip: 'none', storm: false, fog: false })
    expect(readSymbol('clearsky_night')!.cloudCover).toBeLessThan(0.1)
    expect(readSymbol('cloudy')!.cloudCover).toBeGreaterThan(0.9)
    expect(readSymbol('partlycloudy_polartwilight')!.cloudCover).toBe(0.5)
  })

  it('reads rain, snow and sleet with their intensity', () => {
    expect(readSymbol('lightrain')).toMatchObject({ precip: 'rain', precipIntensity: 0.35 })
    expect(readSymbol('heavyrainshowers_day')).toMatchObject({ precip: 'rain', precipIntensity: 1 })
    expect(readSymbol('snow')).toMatchObject({ precip: 'snow', precipIntensity: 0.65 })
    expect(readSymbol('sleetshowers_night')).toMatchObject({ precip: 'sleet' })
  })

  it('reads thunder as a storm, MET typos included', () => {
    expect(readSymbol('rainandthunder')).toMatchObject({ precip: 'rain', storm: true })
    expect(readSymbol('lightssnowshowersandthunder_day')).toMatchObject({ precip: 'snow', storm: true, precipIntensity: 0.35 })
  })

  it('reads fog', () => {
    expect(readSymbol('fog')).toMatchObject({ fog: true, precip: 'none' })
  })

  it('labels each condition', () => {
    expect(readSymbol('fair_night')!.label).toBe('Mostly clear')
    expect(readSymbol('partlycloudy_day')!.label).toBe('Partly cloudy')
    expect(readSymbol('cloudy')!.label).toBe('Cloudy')
    expect(readSymbol('lightrain')!.label).toBe('Light rain')
    expect(readSymbol('rainshowers_day')!.label).toBe('Rain showers')
    expect(readSymbol('heavysnow')!.label).toBe('Heavy snow')
    expect(readSymbol('sleet')!.label).toBe('Sleet')
    expect(readSymbol('fog')!.label).toBe('Fog')
    expect(readSymbol('heavyrainandthunder')!.label).toBe('Thunderstorm')
  })

  it('has nothing to say without a code', () => {
    expect(readSymbol(undefined)).toBeNull()
    expect(readSymbol('')).toBeNull()
  })
})

describe('skyWeatherFromMetNorway', () => {
  it('maps a clear, breezy hour', () => {
    const w = skyWeatherFromMetNorway(met({ cloud_area_fraction: 3, wind_speed: 6.2, wind_from_direction: 270, fog_area_fraction: 0, air_temperature: 18.24 }, 'clearsky_day', 0))
    expect(w).toEqual({
      cloudCover: 0.03, cirrus: 0, windSpeedMs: 6.2, windFromDeg: 270, precip: 'none', precipIntensity: 0, fog: false, storm: false,
      temperatureC: 18.2, condition: 'Clear',
    })
  })

  it('maps rain, scaling intensity by the hourly amount and filling the sky', () => {
    const w = skyWeatherFromMetNorway(met({ cloud_area_fraction: 40, wind_speed: 3, wind_from_direction: 180 }, 'rain', 2.5))!
    expect(w.precip).toBe('rain')
    expect(w.precipIntensity).toBeCloseTo(0.75)
    expect(w.cloudCover).toBeGreaterThanOrEqual(0.75)
  })

  it('maps snow from a six-hour period as an hourly rate', () => {
    const w = skyWeatherFromMetNorway(met({ cloud_area_fraction: 100, wind_speed: 1, wind_from_direction: 0 }, 'heavysnow', 12, 'next_6_hours'))!
    expect(w.precip).toBe('snow')
    expect(w.precipIntensity).toBeCloseTo(0.25 + 2 / 5)
  })

  it('maps sleet', () => {
    expect(skyWeatherFromMetNorway(met({ cloud_area_fraction: 90 }, 'lightsleet'))!.precip).toBe('sleet')
  })

  it('maps a thunderstorm to a storm under a full sky', () => {
    const w = skyWeatherFromMetNorway(met({ cloud_area_fraction: 50, wind_speed: 12 }, 'heavyrainandthunder', 8))!
    expect(w.storm).toBe(true)
    expect(w.cloudCover).toBeGreaterThanOrEqual(0.9)
    expect(w.precipIntensity).toBe(1)
  })

  it('maps fog from the fog fraction or the symbol', () => {
    expect(skyWeatherFromMetNorway(met({ cloud_area_fraction: 100, fog_area_fraction: 60 }, 'cloudy'))!.fog).toBe(true)
    expect(skyWeatherFromMetNorway(met({ cloud_area_fraction: 100 }, 'fog'))!.fog).toBe(true)
    expect(skyWeatherFromMetNorway(met({ cloud_area_fraction: 100, fog_area_fraction: 5 }, 'cloudy'))!.fog).toBe(false)
  })

  it('falls back to defaults for missing fields and normalises the direction', () => {
    const w = skyWeatherFromMetNorway(met({ wind_from_direction: -90 }, 'partlycloudy_day'))!
    expect(w.cloudCover).toBe(0.5)
    expect(w.windSpeedMs).toBe(CLEAR_SKY.windSpeedMs)
    expect(w.windFromDeg).toBe(270)
  })

  it('labels from cloud cover when there is no symbol, and leaves temperature unknown', () => {
    const w = skyWeatherFromMetNorway(met({ cloud_area_fraction: 80 }))!
    expect(w.condition).toBe('Cloudy')
    expect(w.temperatureC).toBeNull()
  })

  it('labels a dry sky from the instant cloud cover so the label matches the picture', () => {
    expect(skyWeatherFromMetNorway(met({ cloud_area_fraction: 100 }, 'partlycloudy_night'))!.condition).toBe('Cloudy')
    expect(skyWeatherFromMetNorway(met({ cloud_area_fraction: 30 }, 'cloudy'))!.condition).toBe('Mostly clear')
    expect(skyWeatherFromMetNorway(met({ cloud_area_fraction: 30 }, 'lightrain'))!.condition).toBe('Light rain')
  })

  it('the default sky claims no reading', () => {
    expect(CLEAR_SKY.condition).toBeNull()
    expect(CLEAR_SKY.temperatureC).toBeNull()
  })

  it('returns null for a response with no forecast', () => {
    expect(skyWeatherFromMetNorway(null)).toBeNull()
    expect(skyWeatherFromMetNorway({})).toBeNull()
    expect(skyWeatherFromMetNorway({ properties: { timeseries: [] } })).toBeNull()
  })
})

describe('cloud layers (the complete endpoint)', () => {
  it('New York, 10 October 2026: all-high 91% cloud is a clear sky with cirrus, not "Cloudy"', () => {
    const w = skyWeatherFromMetNorway(
      met(
        { cloud_area_fraction: 91.4, cloud_area_fraction_high: 91.4, cloud_area_fraction_low: 0, cloud_area_fraction_medium: 0, fog_area_fraction: 0, air_temperature: 14.7, wind_speed: 2.5, wind_from_direction: 358.7 },
        'partlycloudy_day',
        0,
      ),
    )!
    expect(w.cloudCover).toBeLessThan(0.1)
    expect(w.cirrus).toBeCloseTo(0.914)
    expect(['Clear', 'Mostly clear']).toContain(w.condition)
    expect(w.condition).toBe('Mostly clear')
    expect(w.fog).toBe(false)
    expect(w.temperatureC).toBe(14.7)
  })

  it('low 80% cloud is "Cloudy" on the existing scale, with no cirrus', () => {
    const w = skyWeatherFromMetNorway(met({ cloud_area_fraction: 80, cloud_area_fraction_low: 80, cloud_area_fraction_medium: 0, cloud_area_fraction_high: 0 }))!
    expect(w.cloudCover).toBeCloseTo(0.8)
    expect(w.cirrus).toBe(0)
    expect(w.condition).toBe('Cloudy')
  })

  it('mixed layers: low and medium overlap into the dense cover, high is cirrus', () => {
    const w = skyWeatherFromMetNorway(met({ cloud_area_fraction: 85, cloud_area_fraction_low: 30, cloud_area_fraction_medium: 50, cloud_area_fraction_high: 70 }, 'partlycloudy_day'))!
    // 1 - (1 - 0.3)(1 - 0.85 * 0.5)
    expect(w.cloudCover).toBeCloseTo(1 - 0.7 * (1 - 0.85 * 0.5))
    expect(w.cirrus).toBeCloseTo(0.7)
    expect(w.condition).toBe('Partly cloudy')
  })

  it('overlapping layers never pass 1, and medium counts a little less than low', () => {
    expect(denseCover(1, 1)).toBe(1)
    expect(denseCover(0.5, 0.5)).toBeLessThan(1)
    expect(denseCover(0.5, 0.5)).toBeGreaterThan(0.5)
    expect(denseCover(0, 0.5)).toBeLessThan(denseCover(0.5, 0))
    expect(denseCover(0, 0)).toBe(0)
    expect(skyWeatherFromMetNorway(met({ cloud_area_fraction_low: 100, cloud_area_fraction_medium: 100, cloud_area_fraction_high: 100 }))!.cloudCover).toBe(1)
  })

  it('a missing layer counts as none when the others are there', () => {
    const w = skyWeatherFromMetNorway(met({ cloud_area_fraction: 60, cloud_area_fraction_high: 60 }))!
    expect(w.cloudCover).toBe(0)
    expect(w.cirrus).toBeCloseTo(0.6)
  })

  it('cirrus alone makes "Clear" into "Mostly clear" at most, never cloudier', () => {
    expect(coverLabel(0, 0)).toBe('Clear')
    expect(coverLabel(0, CIRRUS_LABEL_MIN - 0.01)).toBe('Clear')
    expect(coverLabel(0, CIRRUS_LABEL_MIN)).toBe('Mostly clear')
    expect(coverLabel(0, 1)).toBe('Mostly clear')
    expect(coverLabel(0.3, 1)).toBe('Mostly clear')
    expect(coverLabel(0.6, 1)).toBe('Partly cloudy')
    expect(coverLabel(0.9, 1)).toBe('Cloudy')
    // Thin high cloud only: Clear below the threshold, Mostly clear above, whatever the total says.
    expect(skyWeatherFromMetNorway(met({ cloud_area_fraction: 20, cloud_area_fraction_high: 20, cloud_area_fraction_low: 0, cloud_area_fraction_medium: 0 }))!.condition).toBe('Clear')
    expect(skyWeatherFromMetNorway(met({ cloud_area_fraction: 100, cloud_area_fraction_high: 100, cloud_area_fraction_low: 0, cloud_area_fraction_medium: 0 }, 'cloudy'))!.condition).toBe('Mostly clear')
    for (const cover of [0, 0.2, 0.5, 0.9]) for (const ci of [0, 0.5, 1]) expect(SKY_CONDITION_LABELS.has(coverLabel(cover, ci))).toBe(true)
  })

  it('a fog fraction over the threshold is fog, labelled "Fog" whatever the symbol', () => {
    const w = skyWeatherFromMetNorway(met({ cloud_area_fraction: 100, cloud_area_fraction_low: 100, cloud_area_fraction_medium: 0, cloud_area_fraction_high: 0, fog_area_fraction: 45 }, 'cloudy'))!
    expect(w.fog).toBe(true)
    expect(w.condition).toBe('Fog')
    expect(skyWeatherFromMetNorway(met({ cloud_area_fraction_low: 10, fog_area_fraction: 29 }))!.fog).toBe(false)
    // Rain in fog: what's falling names it.
    expect(skyWeatherFromMetNorway(met({ cloud_area_fraction_low: 90, fog_area_fraction: 80 }, 'lightrain', 0.4))).toMatchObject({ fog: true, condition: 'Light rain' })
  })

  it('something falling still fills the sky, whatever the layers say', () => {
    const w = skyWeatherFromMetNorway(met({ cloud_area_fraction_low: 0, cloud_area_fraction_medium: 20, cloud_area_fraction_high: 90 }, 'lightrainshowers_day', 0.3))!
    expect(w.precip).toBe('rain')
    expect(w.cloudCover).toBeGreaterThanOrEqual(0.75)
    expect(w.condition).toBe('Light rain showers')
  })
})
