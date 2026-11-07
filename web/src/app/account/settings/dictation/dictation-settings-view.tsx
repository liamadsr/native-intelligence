'use client'

/**
 * Settings → Dictation (Liam, 2026-10-25): how dictated words come out, in the
 * chat box and, on the desktop, in any app.
 *
 *   - Dictate anywhere: tap right ⌥ in any app, talk, tap it again
 *     (./dictate-anywhere-section; desktop only, renders nothing elsewhere).
 *   - Remove filler words: um, uh and similar left out (@/lib/voice/fillers),
 *     on by default, this device's setting.
 *
 * Names and terms are corrected automatically from Settings → Vocabulary.
 */
import { useEffect, useState } from 'react'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { getRemoveFillers, setRemoveFillers } from '@/lib/voice/fillers'
import { DictateAnywhereSection } from './dictate-anywhere-section'

export function DictationSettingsView() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-8 py-8">
        <h1 className="text-lg font-semibold">Dictation</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          How your dictated words come out. Names and terms are spelled right automatically, from your vocabulary.
        </p>

        <div className="mt-6 rounded-lg border border-border bg-muted/30 px-4 py-3">
          <FillerWords />
        </div>

        <DictateAnywhereSection />
      </div>
    </div>
  )
}

function FillerWords() {
  const [on, setOn] = useState(true)
  useEffect(() => setOn(getRemoveFillers()), [])
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <Label className="text-sm font-medium">Remove filler words</Label>
        <p className="text-xs text-muted-foreground">Leaves out “um”, “uh” and similar sounds from what you dictate.</p>
      </div>
      <Switch
        aria-label="Remove filler words"
        checked={on}
        onCheckedChange={(next) => {
          setRemoveFillers(next)
          setOn(next)
        }}
      />
    </div>
  )
}
