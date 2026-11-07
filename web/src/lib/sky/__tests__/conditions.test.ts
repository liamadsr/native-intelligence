import { describe, expect, it } from 'vitest'
import {
  conditionsLine,
  firstNameOf,
  formatTemperature,
  greetingFor,
  greetingLine,
  regionOfLocale,
  temperatureUnit,
  type ConditionsInput,
} from '../conditions'

describe('greeting', () => {
  it('follows the local hour: morning 5–12, afternoon 12–17, evening 17–24, "Hello" 0–5', () => {
    expect(greetingFor(4)).toBe('Hello')
    expect(greetingFor(5)).toBe('Good morning')
    expect(greetingFor(11)).toBe('Good morning')
    expect(greetingFor(12)).toBe('Good afternoon')
    expect(greetingFor(16)).toBe('Good afternoon')
    expect(greetingFor(17)).toBe('Good evening')
    expect(greetingFor(21)).toBe('Good evening')
    expect(greetingFor(22)).toBe('Good evening')
    expect(greetingFor(23)).toBe('Good evening')
    expect(greetingFor(0)).toBe('Hello')
  })

  it('greets by first name when there is one, and plainly when not', () => {
    expect(greetingLine(19, 'Liam Alizadeh')).toBe('Good evening, Liam')
    expect(greetingLine(19, '  Zoë  ')).toBe('Good evening, Zoë')
    expect(greetingLine(9, null)).toBe('Good morning')
    expect(greetingLine(9, '')).toBe('Good morning')
  })

  it('never greets an email address, a number or a runaway string', () => {
    expect(firstNameOf('liam@dial8.ai')).toBeNull()
    expect(firstNameOf('12345')).toBeNull()
    expect(firstNameOf('x'.repeat(40))).toBeNull()
  })
})

describe('temperature unit', () => {
  it('is °F in the US (and the places that read it), °C elsewhere', () => {
    expect(temperatureUnit('US')).toBe('F')
    expect(temperatureUnit('PR')).toBe('F')
    expect(temperatureUnit('CA')).toBe('C')
    expect(temperatureUnit('GB')).toBe('C')
  })

  it("falls back to the browser locale's region only when the country is unknown", () => {
    expect(temperatureUnit(null, 'en-US')).toBe('F')
    expect(temperatureUnit(null, 'en-GB')).toBe('C')
    expect(temperatureUnit(null, 'en')).toBe('C')
    expect(temperatureUnit(null, null)).toBe('C')
    expect(temperatureUnit('CA', 'en-US')).toBe('C')
  })

  it('reads the region from a locale tag, script or not', () => {
    expect(regionOfLocale('en-US')).toBe('US')
    expect(regionOfLocale('zh-Hant-TW')).toBe('TW')
    expect(regionOfLocale('fr_ca')).toBe('CA')
    expect(regionOfLocale('de')).toBeNull()
  })

  it('formats whole degrees with no unit letter, a true minus and no negative zero', () => {
    expect(formatTemperature(9.4, 'C')).toBe('9°')
    expect(formatTemperature(9.4, 'F')).toBe('49°')
    expect(formatTemperature(-0.3, 'C')).toBe('0°')
    expect(formatTemperature(-2.6, 'C')).toBe('\u22123°')
  })
})

describe('conditions line', () => {
  const base: ConditionsInput = {
    condition: 'Light rain',
    temperatureC: 9,
    city: 'Toronto',
    located: true,
    unit: 'C',
    phase: 'day',
  }

  it('reads condition · temperature · city', () => {
    expect(conditionsLine(base)).toBe('Light rain · 9° · Toronto')
    expect(conditionsLine({ ...base, unit: 'F', city: 'Chicago' })).toBe('Light rain · 48° · Chicago')
  })

  it('adds the sunrise at night only', () => {
    expect(conditionsLine({ ...base, condition: 'Clear', temperatureC: 4, phase: 'night', sunrise: '7:12 AM' })).toBe(
      'Clear · 4° · Toronto · sunrise 7:12 AM',
    )
    expect(conditionsLine({ ...base, phase: 'dusk', sunrise: '7:12 AM' })).toBe('Light rain · 9° · Toronto')
  })

  it('leaves out a missing or overlong city', () => {
    expect(conditionsLine({ ...base, city: null })).toBe('Light rain · 9°')
    expect(conditionsLine({ ...base, city: 'Llanfairpwllgwyngyllgogerychwyrndrobwll' })).toBe('Light rain · 9°')
  })

  it('says nothing without a real reading: never a made-up condition', () => {
    expect(conditionsLine({ ...base, located: false })).toBeNull()
    expect(conditionsLine({ ...base, condition: null })).toBeNull()
    expect(conditionsLine({ ...base, temperatureC: null })).toBeNull()
    expect(conditionsLine({ ...base, temperatureC: Number.NaN })).toBeNull()
  })
})
