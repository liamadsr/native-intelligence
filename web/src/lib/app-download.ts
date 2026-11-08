/**
 * Which desktop app a visitor downloads. `/api/download` serves the file:
 * `?platform=` when a button chose it, else the visitor's user agent.
 */
export type DownloadPlatform = 'mac' | 'windows'

/** Windows visitors get the Windows installer; everyone else the Mac app. */
export function platformFromUserAgent(userAgent: string | null | undefined): DownloadPlatform {
  return userAgent && /Windows/i.test(userAgent) ? 'windows' : 'mac'
}

/** `?platform=` as a button sends it: anything else is no choice. */
export function parsePlatform(value: string | null | undefined): DownloadPlatform | null {
  return value === 'mac' || value === 'windows' ? value : null
}

export function otherPlatform(platform: DownloadPlatform): DownloadPlatform {
  return platform === 'mac' ? 'windows' : 'mac'
}

export function downloadHref(platform: DownloadPlatform): string {
  return `/api/download?platform=${platform}`
}

export function platformName(platform: DownloadPlatform): string {
  return platform === 'mac' ? 'macOS' : 'Windows'
}

/** The public file for each platform (overridable per environment). */
export function downloadUrl(platform: DownloadPlatform, env: Record<string, string | undefined> = process.env): string {
  if (platform === 'windows') {
    return env.APP_DOWNLOAD_URL_WINDOWS ?? 'https://pub-68f42b03823f4321b0938337ad51ef08.r2.dev/Dial8-setup.exe'
  }
  return env.APP_DOWNLOAD_URL ?? 'https://pub-68f42b03823f4321b0938337ad51ef08.r2.dev/Dial8.dmg'
}
