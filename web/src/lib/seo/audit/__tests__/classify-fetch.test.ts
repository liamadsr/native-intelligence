/**
 * How a page fetch resolved (../classify-fetch.ts): a firewall or bot
 * challenge must read as blocked, a 429 as rate limited, no answer as an
 * error, and everything else as a real answer.
 */
import { describe, expect, it } from 'vitest'
import { classifyFetch } from '../classify-fetch'

describe('classifyFetch', () => {
  it('is an error when nothing answered', () => {
    expect(classifyFetch(0, false, '')).toBe('error')
  })

  it('is rate limited on a 429, even with a Cloudflare mitigation header', () => {
    expect(classifyFetch(429, false, '')).toBe('rate_limited')
    expect(classifyFetch(429, true, '')).toBe('rate_limited')
  })

  it('is blocked when Cloudflare says it mitigated the request', () => {
    expect(classifyFetch(200, true, '<title>Home</title>')).toBe('blocked')
    expect(classifyFetch(403, true, '')).toBe('blocked')
  })

  it.each([401, 403, 202])('is blocked on a %i', (status) => {
    expect(classifyFetch(status, false, '')).toBe('blocked')
  })

  it.each([
    '<html><head><title>Just a moment...</title></head></html>',
    '<title> Attention Required! | Cloudflare </title>',
    '<title>One moment, please...</title>',
    '<script>location="/.well-known/sgcaptcha/?r=%2F"</script>',
  ])('is blocked on a challenge page served with a 200: %s', (body) => {
    expect(classifyFetch(200, false, body)).toBe('blocked')
  })

  it('is blocked on a 503 that carries a challenge, and ok on a plain 503', () => {
    expect(
      classifyFetch(503, false, '<div id="challenge-platform"></div>'),
    ).toBe('blocked')
    expect(classifyFetch(503, false, 'Verifying you are human')).toBe('blocked')
    expect(classifyFetch(503, false, '<h1>Down for maintenance</h1>')).toBe(
      'ok',
    )
  })

  it('is ok on real pages, redirects, 404s and 500s', () => {
    expect(
      classifyFetch(200, false, '<title>Just a moment of calm</title>'),
    ).toBe('ok')
    expect(classifyFetch(301, false, '')).toBe('ok')
    expect(classifyFetch(404, false, '<title>Not found</title>')).toBe('ok')
    expect(classifyFetch(500, false, '')).toBe('ok')
  })
})
