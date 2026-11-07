'use client'

/**
 * Developer settings → Sky preview: pick the weather, the time of day and the
 * place the sky draws, to see it in any condition (the desktop app has no URL
 * bar for `?sky=…`). Dev only, like the whole Developer page; remembered on
 * this device (sky-dev-store.ts). The settings sheet covers the sky, so the
 * same controls can float over the app (sky-dev-panel.tsx).
 */

import { useEffect, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { SkyDevControls } from '@/components/sky/sky-dev-controls'
import { parseSkyOverride } from '@/lib/sky/dev-override'
import { resetSkyDevOverride, setSkyDevSettings, useSkyDevSettings } from '@/lib/sky/sky-dev-store'

export function SkyPreviewSection() {
  const s = useSkyDevSettings()
  const [urlOverride, setUrlOverride] = useState(false)
  useEffect(() => setUrlOverride(parseSkyOverride(window.location.search) !== null), [])
  const overridden = s.weather !== null || s.minuteOfDay !== null || s.place !== null

  return (
    <div className="rounded-lg border p-6">
      <h3 className="text-sm font-semibold">Sky preview</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Set the weather, time of day and place the sky draws. Dev only, and remembered on this device.
      </p>
      {urlOverride && (
        <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
          This page&apos;s URL has <code className="rounded bg-muted px-1 py-0.5">?sky</code> parameters: they win over
          these where they set something.
        </p>
      )}

      <SkyDevControls className="mt-4" />

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <Switch
            checked={s.floating}
            onCheckedChange={(on) => setSkyDevSettings({ floating: on })}
            aria-label="Show floating controls"
          />
          Show floating controls
        </label>
        <Button variant="outline" onClick={resetSkyDevOverride} disabled={!overridden}>
          <RotateCcw className="mr-2 h-4 w-4" />
          Reset to real sky
        </Button>
      </div>
    </div>
  )
}
