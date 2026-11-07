import { describe, expect, it } from 'vitest'
import { countryFromHeaders, locationFromHeaders, roundCoord } from '../location'

const h = (entries: Record<string, string>) => new Headers(entries)

describe('locationFromHeaders', () => {
  it('reads and rounds the Vercel geolocation headers', () => {
    expect(
      locationFromHeaders(h({ 'x-vercel-ip-latitude': '37.7749', 'x-vercel-ip-longitude': '-122.4194', 'x-vercel-ip-city': 'San%20Francisco' })),
    ).toEqual({ lat: 37.8, lon: -122.4, city: 'San Francisco' })
  })

  it('keeps a city that is not valid URI encoding as it came', () => {
    expect(locationFromHeaders(h({ 'x-vercel-ip-latitude': '1', 'x-vercel-ip-longitude': '2', 'x-vercel-ip-city': '%E0%A4%A' }))?.city).toBe('%E0%A4%A')
  })

  it('is null without coordinates, or with nonsense ones', () => {
    expect(locationFromHeaders(h({}))).toBeNull()
    expect(locationFromHeaders(h({ 'x-vercel-ip-latitude': '37.7' }))).toBeNull()
    expect(locationFromHeaders(h({ 'x-vercel-ip-latitude': 'abc', 'x-vercel-ip-longitude': '1' }))).toBeNull()
    expect(locationFromHeaders(h({ 'x-vercel-ip-latitude': '95', 'x-vercel-ip-longitude': '1' }))).toBeNull()
  })

  it('rounds to one decimal without a negative zero', () => {
    expect(roundCoord(-0.04)).toBe(0)
    expect(Object.is(roundCoord(-0.04), -0)).toBe(false)
    expect(roundCoord(51.5074)).toBe(51.5)
  })
})

describe('countryFromHeaders', () => {
  it('reads a two-letter country, upper-cased', () => {
    expect(countryFromHeaders(h({ 'x-vercel-ip-country': 'US' }))).toBe('US')
    expect(countryFromHeaders(h({ 'x-vercel-ip-country': 'ca' }))).toBe('CA')
  })

  it('is null when absent or not a country code', () => {
    expect(countryFromHeaders(h({}))).toBeNull()
    expect(countryFromHeaders(h({ 'x-vercel-ip-country': 'USA' }))).toBeNull()
    expect(countryFromHeaders(h({ 'x-vercel-ip-country': '' }))).toBeNull()
  })
})
