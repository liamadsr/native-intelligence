'use client'

/**
 * Where the floating sky preview (sky-dev-panel.tsx) mounts: once in the
 * dashboard shell and once on the public pages' sky. Renders nothing until
 * the dev settings turn the panel on, and nothing at all in production: the
 * panel's import sits behind a `process.env.NODE_ENV` check the build
 * inlines, so its chunk is dropped from production bundles.
 */

import { lazyComponent } from '@/lib/lazy-component'
import { useSkyDevSettings } from '@/lib/sky/sky-dev-store'

const SkyDevPanel =
  process.env.NODE_ENV !== 'production'
    ? lazyComponent(() => import('./sky-dev-panel').then((m) => m.SkyDevPanel))
    : null

export function SkyDevPanelMount() {
  if (process.env.NODE_ENV === 'production' || !SkyDevPanel) return null
  return <DevMount Panel={SkyDevPanel} />
}

function DevMount({ Panel }: { Panel: NonNullable<typeof SkyDevPanel> }) {
  const { floating } = useSkyDevSettings()
  return floating ? <Panel /> : null
}
