/**
 * The desktop download (lib/app-download.ts): only the URLs in
 * APP_DOWNLOAD_URL / APP_DOWNLOAD_URL_WINDOWS, and build-time flags
 * (next.config.mjs downloadFlags) that hide every button when one is unset.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { downloadFlags } from '../../../next.config.mjs'
import { downloadUrl, hasDownload, parsePlatform } from '../app-download'

afterEach(() => vi.unstubAllEnvs())

describe('downloadUrl', () => {
  it('reads each platform from its own variable', () => {
    vi.stubEnv('APP_DOWNLOAD_URL', ' https://downloads.example.com/App.dmg ')
    vi.stubEnv('APP_DOWNLOAD_URL_WINDOWS', 'https://downloads.example.com/App-setup.exe')
    expect(downloadUrl('mac')).toBe('https://downloads.example.com/App.dmg')
    expect(downloadUrl('windows')).toBe('https://downloads.example.com/App-setup.exe')
  })

  it('is null when unset or blank: no built-in file', () => {
    vi.stubEnv('APP_DOWNLOAD_URL', '')
    vi.stubEnv('APP_DOWNLOAD_URL_WINDOWS', '  ')
    expect(downloadUrl('mac')).toBeNull()
    expect(downloadUrl('windows')).toBeNull()
  })
})

describe('hasDownload', () => {
  it('follows the build-time flags, Mac by default', () => {
    vi.stubEnv('NEXT_PUBLIC_HAS_MAC_DOWNLOAD', '1')
    vi.stubEnv('NEXT_PUBLIC_HAS_WINDOWS_DOWNLOAD', '')
    expect(hasDownload()).toBe(true)
    expect(hasDownload('windows')).toBe(false)
    vi.stubEnv('NEXT_PUBLIC_HAS_MAC_DOWNLOAD', '')
    expect(hasDownload()).toBe(false)
  })
})

describe('downloadFlags (next.config.mjs)', () => {
  it("sets '1' for each URL that is set, '' otherwise", () => {
    expect(downloadFlags({ APP_DOWNLOAD_URL: 'https://downloads.example.com/App.dmg' })).toEqual({
      NEXT_PUBLIC_HAS_MAC_DOWNLOAD: '1',
      NEXT_PUBLIC_HAS_WINDOWS_DOWNLOAD: '',
    })
    expect(downloadFlags({ APP_DOWNLOAD_URL: ' ', APP_DOWNLOAD_URL_WINDOWS: undefined })).toEqual({
      NEXT_PUBLIC_HAS_MAC_DOWNLOAD: '',
      NEXT_PUBLIC_HAS_WINDOWS_DOWNLOAD: '',
    })
  })
})

describe('parsePlatform', () => {
  it('takes mac or windows, nothing else', () => {
    expect(parsePlatform('mac')).toBe('mac')
    expect(parsePlatform('windows')).toBe('windows')
    expect(parsePlatform('linux')).toBeNull()
    expect(parsePlatform(null)).toBeNull()
  })
})
