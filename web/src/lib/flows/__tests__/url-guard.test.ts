import { describe, it, expect } from 'vitest'
import { isPublicHttpUrl } from '../url-guard'

describe('isPublicHttpUrl', () => {
  it('accepts public http(s) URLs', () => {
    expect(isPublicHttpUrl('https://api.example.com/x')).toBe(true)
    expect(isPublicHttpUrl('http://example.com')).toBe(true)
  })

  it('rejects empty / non-string / unparseable', () => {
    expect(isPublicHttpUrl('')).toBe(false)
    expect(isPublicHttpUrl('   ')).toBe(false)
    expect(isPublicHttpUrl(null)).toBe(false)
    expect(isPublicHttpUrl(undefined)).toBe(false)
    expect(isPublicHttpUrl(42)).toBe(false)
    expect(isPublicHttpUrl('not a url')).toBe(false)
  })

  it('rejects non-http(s) protocols', () => {
    expect(isPublicHttpUrl('ftp://example.com')).toBe(false)
    expect(isPublicHttpUrl('file:///etc/passwd')).toBe(false)
    expect(isPublicHttpUrl('javascript:alert(1)')).toBe(false)
  })

  it('rejects private / loopback / link-local hosts (SSRF guard)', () => {
    for (const url of [
      'http://localhost/x',
      'http://127.0.0.1/x',
      'http://0.0.0.0/x',
      'http://[::1]/x',
      'http://service.local/x',
      'http://169.254.1.1/x',
      'http://10.0.0.5/x',
      'http://192.168.1.1/x',
      'http://172.16.0.1/x',
      'http://172.31.255.255/x',
    ]) {
      expect(isPublicHttpUrl(url), `should reject ${url}`).toBe(false)
    }
  })

  it('rejects the loopback / metadata forms a literal-string check misses', () => {
    for (const url of [
      'http://[::ffff:127.0.0.1]/x',
      'http://[::ffff:169.254.169.254]/latest/meta-data/',
      'http://[::ffff:a9fe:a9fe]/x',
      'http://127.0.0.2:8080/x',
      'http://localhost./x',
      'http://100.64.0.1/x',
      'http://metadata.google.internal/x',
      'http://[fd00::1]/x',
    ]) {
      expect(isPublicHttpUrl(url), `should reject ${url}`).toBe(false)
    }
  })

  it('does not over-block public 172.x outside the private range', () => {
    expect(isPublicHttpUrl('http://172.15.0.1/x')).toBe(true)
    expect(isPublicHttpUrl('http://172.32.0.1/x')).toBe(true)
  })
})
