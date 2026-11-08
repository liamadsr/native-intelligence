import { describe, expect, it } from 'vitest'
import { downloadHref, downloadUrl, otherPlatform, parsePlatform, platformFromUserAgent, platformName } from '../app-download'

const WINDOWS_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const MAC_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15'

describe('desktop downloads', () => {
  it('sends Windows visitors the Windows installer and everyone else the Mac app', () => {
    expect(platformFromUserAgent(WINDOWS_CHROME)).toBe('windows')
    expect(platformFromUserAgent(MAC_SAFARI)).toBe('mac')
    expect(platformFromUserAgent('Mozilla/5.0 (X11; Linux x86_64)')).toBe('mac')
    expect(platformFromUserAgent(null)).toBe('mac')
  })

  it('takes only a known platform from the query', () => {
    expect(parsePlatform('windows')).toBe('windows')
    expect(parsePlatform('mac')).toBe('mac')
    expect(parsePlatform('linux')).toBeNull()
    expect(parsePlatform(null)).toBeNull()
  })

  it('names the files and the buttons', () => {
    expect(downloadUrl('mac', {})).toMatch(/\/Dial8\.dmg$/)
    expect(downloadUrl('windows', {})).toMatch(/\/Dial8-setup\.exe$/)
    expect(downloadUrl('windows', { APP_DOWNLOAD_URL_WINDOWS: 'https://x/y.exe' })).toBe('https://x/y.exe')
    expect(downloadHref('windows')).toBe('/api/download?platform=windows')
    expect([platformName('mac'), platformName('windows')]).toEqual(['macOS', 'Windows'])
    expect(otherPlatform('mac')).toBe('windows')
  })
})
