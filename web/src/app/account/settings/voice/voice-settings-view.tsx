'use client'

/**
 * Voice settings — the status hub for the user's trained voiceprint, plus
 * (desktop only) read-aloud: the on-device voice that reads chat replies, Read
 * anywhere: the same voice reading text selected in any app, and voice mode:
 * talking with the chat. (The assistant's name is in Preferences.)
 *
 * NOT gated by isDesktopApp()/isLowerEnvironment(): teaching Native Intelligence your voice is
 * a real feature on every platform. Two states:
 *   • not enrolled → a hero-ish card that launches the enrollment flow.
 *   • enrolled     → status card (trained date + quality label) with Re-train
 *     and Remove actions, plus the privacy + cross-workspace explainer.
 * Under the voiceprint card in both: Voice focus (desktop builds that send
 * speech audio only), which needs the voiceprint.
 *
 * Uses the shared use-voice-profile hook (GET /api/account/voice-profile),
 * which refetches on focus so returning from enrollment updates the view.
 */

import { useState } from 'react'
import { AudioWaveform, Check, ShieldCheck, Globe, Trash2, RefreshCw } from 'lucide-react'
import { useSettingsNavigate } from '@/app/account/settings/settings-shell'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useVoiceProfile } from '@/hooks/use-voice-profile'
import { qualityLabel, type VoiceQualityLabel } from '@/lib/voice-profile/types'
import { ReadAloudSection } from './read-aloud-section'
import { ReadAnywhereSection } from './read-anywhere-section'
import { VoiceFocusSection } from './voice-focus-section'
import { VoiceModeSection } from './voice-mode-section'

const QUALITY_COPY: Record<VoiceQualityLabel, { label: string; hint: string | null }> = {
  excellent: { label: 'Excellent', hint: null },
  good: { label: 'Good', hint: null },
  fair: { label: 'Fair', hint: 'Consider re-training in a quieter room for a cleaner voiceprint.' },
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

export function VoiceSettingsView() {
  const navigate = useSettingsNavigate()
  const { status, loading, refresh } = useVoiceProfile()
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const enrolled = status?.enrolled === true
  /** The enrollment flow (the hero's button, Re-train, Voice focus's). */
  const train = () => navigate('/account/voice-enrollment')

  async function handleRemove() {
    setRemoving(true)
    setError(null)
    try {
      const res = await fetch('/api/account/voice-profile', { method: 'DELETE' })
      if (!res.ok) {
        setError('Couldn’t remove your voice profile. Try again.')
        return
      }
      setConfirmRemove(false)
      refresh()
    } catch {
      setError('Couldn’t remove your voice profile. Try again.')
    } finally {
      setRemoving(false)
    }
  }

  const quality =
    status?.quality != null ? QUALITY_COPY[qualityLabel(status.quality)] : null

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-8 py-8">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white shadow-sm dark:bg-zinc-800">
            <AudioWaveform className="h-5 w-5 text-emerald-500" />
          </div>
          <div>
            <h1 className="text-lg font-semibold">Voice</h1>
            <p className="text-sm text-muted-foreground">
              Teach Native Intelligence your voice so it always knows which speaker in a meeting is you.
            </p>
          </div>
        </div>

        <Separator className="my-6" />

        <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
          Your voiceprint
        </div>

        {loading && !status ? (
          <p className="mt-3 text-sm text-muted-foreground">Loading…</p>
        ) : enrolled ? (
          // ── Enrolled ──────────────────────────────────────────
          <div className="mt-3 space-y-4">
            <div className="rounded-lg border border-border bg-muted/30 px-4 py-3">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Check className="h-4 w-4 shrink-0 text-emerald-500" />
                    <span className="font-medium">Voice trained</span>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {status?.createdAt ? `Trained on ${formatDate(status.createdAt)}` : 'Trained'}
                    {quality ? ` · ${quality.label}` : ''}
                  </p>
                  {quality?.hint && (
                    <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                      {quality.hint}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={train}
                  >
                    <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                    Re-train
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setConfirmRemove(true)}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                    Remove
                  </Button>
                </div>
              </div>
            </div>

            {/* Voice focus — desktop only, on a build that sends speech audio. */}
            <VoiceFocusSection trained onTrain={train} />

            {error && <p className="text-sm text-destructive">{error}</p>}

            <VoiceExplainer />
          </div>
        ) : (
          // ── Not enrolled ──────────────────────────────────────
          <div className="mt-3 space-y-4">
            <div className="rounded-lg border border-border bg-muted/30 px-5 py-5">
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-background">
                  <AudioWaveform className="h-5 w-5 text-foreground" />
                </div>
                <div className="min-w-0">
                  <p className="font-medium">Teach Native Intelligence your voice</p>
                  <p className="text-sm text-muted-foreground">
                    Read a 60-second story once. Takes about a minute.
                  </p>
                </div>
              </div>
              <Button
                className="mt-4"
                onClick={train}
              >
                <AudioWaveform className="mr-2 h-4 w-4" />
                Teach Native Intelligence your voice
              </Button>
            </div>

            <VoiceFocusSection trained={false} onTrain={train} />

            <VoiceExplainer />
          </div>
        )}

        {/* Read aloud — desktop only, when this build ships the on-device
            text-to-speech module (modules_list includes local-tts). Browsers
            and older desktop builds render nothing. */}
        <ReadAloudSection />

        {/* Read anywhere — desktop only, when this build can read selections:
            the same voice, for text selected in any app. */}
        <ReadAnywhereSection />

        {/* Voice mode — desktop only, when voice_status says this build has
            chat voice. Its pause setting sits next to Read aloud,
            whose voice it shares. */}
        <VoiceModeSection />
      </div>

      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title="Remove your voice profile?"
        description="Native Intelligence will stop recognizing your voice in meetings until you train it again. This can’t be undone, but you can always re-train."
        confirmLabel="Remove"
        busy={removing}
        onConfirm={handleRemove}
      />
    </div>
  )
}

/** The muted "what it's for / privacy / cross-workspace" explainer, shared by
 *  both states. */
function VoiceExplainer() {
  return (
    <div className="space-y-2 rounded-lg border border-border/60 bg-transparent px-4 py-3 text-sm text-muted-foreground">
      <p className="flex items-start gap-2">
        <AudioWaveform className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          During a meeting, Native Intelligence compares each speaker against your voiceprint so
          it can label your turns as “You” — automatically.
        </span>
      </p>
      <p className="flex items-start gap-2">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          Your voiceprint is private to your account. Teammates can never see or
          hear it.
        </span>
      </p>
      <p className="flex items-start gap-2">
        <Globe className="mt-0.5 h-4 w-4 shrink-0" />
        <span>This works everywhere you use Native Intelligence — you only need to do it once.</span>
      </p>
    </div>
  )
}
