'use client'

/**
 * Settings → Voice → Voice focus, under the voiceprint card: voice mode and
 * Interactive answer only the user and people Native Intelligence recognises by voice
 * (src/lib/voice/voice-focus.ts). Desktop only, and only on a build whose
 * `voice_status` says it sends speech audio (`speechAudio`); otherwise
 * nothing. Device-local (src/lib/voice/settings.ts `dial8:voice:focus`), off
 * by default. It needs the voiceprint: untrained, the switch is off and
 * disabled and the card offers the enrollment flow.
 */

import { useCallback, useState } from 'react'
import { AudioWaveform } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { isDesktopApp } from '@/lib/platform'
import { getVoiceFocus, setVoiceFocus } from '@/lib/voice/settings'
import { useVoiceStatus } from '@/lib/voice/status-store'

export function VoiceFocusSection({ trained, onTrain }: { trained: boolean; onTrain: () => void }) {
  const status = useVoiceStatus()
  const [on, setOn] = useState(getVoiceFocus)

  const handleChange = useCallback((next: boolean) => {
    setOn(next)
    setVoiceFocus(next)
  }, [])

  if (!isDesktopApp() || status.speechAudio !== true) return null

  return (
    <div
      className="rounded-lg border border-border bg-muted/30 px-4 py-3"
      data-testid="voice-focus-section"
      data-trained={trained ? 'true' : 'false'}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Label htmlFor="voice-focus-switch" className="text-sm font-medium">
            Voice focus
          </Label>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Only respond to you and people Native Intelligence recognises by voice. Voices it doesn’t know, like a TV or
            people nearby, are ignored. Turn it off to hear everyone.
          </p>
        </div>
        <Switch
          id="voice-focus-switch"
          aria-label="Voice focus"
          className="mt-0.5 shrink-0"
          checked={trained && on}
          disabled={!trained}
          onCheckedChange={handleChange}
        />
      </div>
      {!trained && (
        <div className="mt-3 flex items-center justify-between gap-4 border-t border-border/60 pt-3">
          <p className="text-xs text-muted-foreground">Train your voice first so Native Intelligence knows it’s you.</p>
          <Button variant="outline" size="sm" className="shrink-0" onClick={onTrain}>
            <AudioWaveform className="mr-1.5 h-3.5 w-3.5" />
            Train your voice
          </Button>
        </div>
      )}
    </div>
  )
}
