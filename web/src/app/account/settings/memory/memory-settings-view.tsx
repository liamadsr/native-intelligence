'use client'

import { WhatNiLearned } from '@/components/memory/what-ni-learned'

/**
 * Settings → Memory: what Native Intelligence has learned, every area (one-agent plan
 * Part 3, "Memory"). The same editor sits on each area's page once S3 gives
 * the areas their pages.
 *
 * Learning is on by default (Liam, 2026-10-17): there is no switch. What Native Intelligence
 * notices about the person (their chats, how they write their sent mail, read
 * live and never kept) is live at once and marked "Native Intelligence noticed this", with
 * a one-tap remove. Only workspace lines wait for an owner or admin.
 */
export function MemorySettingsView() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-8 py-8">
        <h1 className="text-lg font-semibold">What Native Intelligence has learned</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Preferences Native Intelligence follows in each area: yours, and your workspace’s. Edit or remove any line, including what Native Intelligence noticed on its own.
        </p>
        <WhatNiLearned className="mt-8" />
      </div>
    </div>
  )
}
