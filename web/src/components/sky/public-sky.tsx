'use client'

/**
 * The public sky, mounted once for the whole site from the root providers
 * (app/providers.tsx), so every public page has it and a new page gets it
 * with no change: behind the page on every route publicSkyShowsOn allows,
 * nothing elsewhere (the signed-in app has its own). It stays mounted across
 * client navigations between public pages, so one canvas (one WebGL context)
 * serves them all; leaving for /account unmounts it and disposes the context.
 */

import { usePathname } from 'next/navigation'
import { publicSkyShowsOn } from '@/lib/sky/public-sky-routes'
import { MarketingSky } from './marketing-sky'

export function PublicSky() {
  const pathname = usePathname()
  return publicSkyShowsOn(pathname) ? <MarketingSky /> : null
}
