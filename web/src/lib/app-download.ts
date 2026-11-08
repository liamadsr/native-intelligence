/**
 * The desktop app's download, when this deployment offers one.
 *
 * /api/download redirects to the file's public URL: APP_DOWNLOAD_URL for
 * macOS, APP_DOWNLOAD_URL_WINDOWS for Windows (`?platform=windows`). There is
 * no built-in file: an unset URL means no download, so the route answers 404
 * and every button or link that offers it renders nothing (hasDownload).
 */
export type DownloadPlatform = 'mac' | 'windows'

/** `?platform=` as a link sends it: anything else is no choice. */
export function parsePlatform(value: string | null | undefined): DownloadPlatform | null {
  return value === 'mac' || value === 'windows' ? value : null
}

/** Server-side: the file's public URL for `platform`, or null when it isn't set. */
export function downloadUrl(platform: DownloadPlatform): string | null {
  const url = platform === 'windows' ? process.env.APP_DOWNLOAD_URL_WINDOWS : process.env.APP_DOWNLOAD_URL
  return url?.trim() || null
}

/**
 * Whether the deployment offers `platform`'s download, anywhere (client or
 * server). next.config.mjs sets these flags at build time from the URLs
 * above, so a button reads the same value on the server and in the browser;
 * keep each a literal `process.env.NEXT_PUBLIC_...` read so Next inlines it.
 */
export function hasDownload(platform: DownloadPlatform = 'mac'): boolean {
  return platform === 'windows'
    ? process.env.NEXT_PUBLIC_HAS_WINDOWS_DOWNLOAD === '1'
    : process.env.NEXT_PUBLIC_HAS_MAC_DOWNLOAD === '1'
}
