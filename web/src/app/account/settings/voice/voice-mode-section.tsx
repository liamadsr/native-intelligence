'use client'

/**
 * Settings → Voice → Voice mode (docs/plans/chat-voice.md §3.4): how a spoken
 * conversation in chat behaves. Desktop only, and only on a build whose
 * `voice_status` says it has voice; a browser or an older desktop sees
 * nothing. The pause is device-local (src/lib/voice/settings.ts) and goes to
 * voice_start as `endSilenceMs`; talking over the agent always interrupts it
 * (not a setting). There is no background-noise setting: every session hears
 * turns by speech alone (settings.ts VOICE_NOISE_PROFILE). The voice itself is
 * Read aloud's, above.
 */

import { useCallback, useState } from 'react'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { isDesktopApp } from '@/lib/platform'
import { useVoiceStatus } from '@/lib/voice/status-store'
import { DEFAULT_VOICE_PAUSE, VOICE_PAUSE_OPTIONS, getVoicePause, setVoicePause, type VoicePause } from '@/lib/voice/settings'

export function VoiceModeSection() {
  const status = useVoiceStatus()
  if (!isDesktopApp() || !status.available) return null

  return (
    <div data-testid="voice-mode-section">
      <Separator className="my-6" />

      <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">Voice mode</div>
      <p className="mt-1 text-sm text-muted-foreground">
        Talk with Native Intelligence in chat: press the waveform next to Send, speak, and hear the reply.
        {!status.conversation && (
          <> It needs On-device transcription (Settings → Audio) and Read aloud to be set up.</>
        )}
      </p>

      <VoiceModeOptions />
    </div>
  )
}

function VoiceModeOptions() {
  const [pause, setPause] = useState<VoicePause>(getVoicePause)

  const handlePause = useCallback((value: string) => {
    const next = VOICE_PAUSE_OPTIONS.find((o) => o.value === value)?.value ?? DEFAULT_VOICE_PAUSE
    setPause(next)
    setVoicePause(next)
  }, [])

  return (
    <div className="mt-3 space-y-4 rounded-lg border border-border bg-muted/30 px-4 py-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Label className="text-sm font-medium">Pause before sending</Label>
          <p className="text-xs text-muted-foreground">
            How long you stay quiet before Native Intelligence takes your turn and answers.
          </p>
        </div>
        <Select value={pause} onValueChange={handlePause}>
          <SelectTrigger className="w-40 shrink-0" aria-label="Pause before sending">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {VOICE_PAUSE_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}
