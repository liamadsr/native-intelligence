'use client'

import { useSyncExternalStore, type MouseEventHandler } from 'react'
import { usePostHog } from 'posthog-js/react'
import {
  downloadHref,
  otherPlatform,
  platformFromUserAgent,
  platformName,
  type DownloadPlatform,
} from '@/lib/app-download'

const subscribe = () => () => {}
const clientPlatform = () => platformFromUserAgent(navigator.userAgent)
const serverPlatform = (): DownloadPlatform => 'mac'

/**
 * The visitor's platform. The server and the first client render say 'mac'
 * (a static page can't know); a Windows visitor's label switches after
 * hydration. The link works either way: /api/download also reads the user
 * agent.
 */
export function useVisitorPlatform(): DownloadPlatform {
  return useSyncExternalStore(subscribe, clientPlatform, serverPlatform)
}

export function PlatformIcon({ platform, className }: { platform: DownloadPlatform; className?: string }) {
  return platform === 'mac' ? (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z" />
    </svg>
  ) : (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M0 3.449L9.75 2.1v9.451H0m10.949-9.602L24 0v11.4H10.949M0 12.6h9.75v9.451L0 20.699M10.949 12.6H24V24l-12.9-1.801" />
    </svg>
  )
}

/**
 * "Download for macOS" / "Download for Windows". `platform`: 'auto' is the
 * visitor's, 'other' the one they're not on (a second button beside the
 * first). Clicks are captured as `cta_clicked` { location, type:
 * download_<platform> } when `location` is set.
 */
export function DownloadLink({
  platform = 'auto',
  className,
  iconClassName,
  location,
  onClick,
}: {
  platform?: DownloadPlatform | 'auto' | 'other'
  className?: string
  iconClassName?: string
  location?: string
  onClick?: MouseEventHandler<HTMLAnchorElement>
}) {
  const visitor = useVisitorPlatform()
  const posthog = usePostHog()
  const target: DownloadPlatform =
    platform === 'auto' ? visitor : platform === 'other' ? otherPlatform(visitor) : platform
  return (
    <a
      href={downloadHref(target)}
      onClick={(event) => {
        if (location) posthog?.capture('cta_clicked', { location, type: target === 'mac' ? 'download_macos' : 'download_windows' })
        onClick?.(event)
      }}
      className={className}
    >
      <PlatformIcon platform={target} className={iconClassName} />
      Download for {platformName(target)}
    </a>
  )
}
