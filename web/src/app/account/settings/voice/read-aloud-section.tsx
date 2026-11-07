'use client'

/**
 * Settings → Voice → Read aloud: the desktop's on-device text-to-speech module
 * (`local-tts`, Kyutai Pocket TTS; docs/plans/local-modules.md §3.6).
 *
 * Renders only inside the desktop app on a build whose modules_list includes
 * local-tts; a browser or an older desktop sees nothing (there is no fallback
 * to a system voice). Once the module is Ready: an Auto-read switch and a
 * voice picker, both device-local (src/lib/read-aloud/settings.ts). The voice
 * is Read anywhere's too (./read-anywhere-section).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Square, Volume2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { LocalModuleLink, LocalModuleRow } from '@/components/desktop/local-module-row'
import { useLocalModule } from '@/hooks/use-local-module'
import { useOptionalRecordingStable } from '@/hooks/recording-context'
import { LOCAL_TTS_MODULE_ID, isLocalModuleUsable } from '@/lib/local-modules'
import { TtsRefusedError, type TtsVoice } from '@/lib/tauri-bridge'
import { speechOutput } from '@/lib/speech-output'
import { getReadAloudAuto, getReadAloudVoice, setReadAloudAuto, setReadAloudVoice } from '@/lib/read-aloud/settings'
import { useReadAloudHeld } from '@/lib/read-aloud/mic-guard'
import { syncReadAnywhereVoice } from '@/lib/read-aloud/read-anywhere-voice'

/** The Speed choices (Liam, 2026-10-22: "really fast like 4x but all the way
 *  down to 0.75 and 0.5"). The desktop keeps the pitch at every one. */
export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4] as const

/** The choice closest to a stored rate (the desktop clamps; it never stores
 *  one off this list unless an older build did). */
export function nearestSpeed(rate: number): number {
  return SPEEDS.reduce((best, s) => (Math.abs(s - rate) < Math.abs(best - rate) ? s : best), 1)
}

const POCKET_TTS_URL = 'https://huggingface.co/kyutai/pocket-tts'
const CC_BY_4_URL = 'https://creativecommons.org/licenses/by/4.0/'

export function ReadAloudSection() {
  const tts = useLocalModule(LOCAL_TTS_MODULE_ID)
  if (!tts.supported) return null

  return (
    <div data-testid="read-aloud-section">
      <Separator className="my-6" />

      <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        Read aloud
      </div>

      <div className="mt-3 space-y-4">
        <LocalModuleRow
          module={tts}
          testId="local-module-row-local-tts"
          title="Read aloud"
          description="Reads Dial8's chat replies aloud on this Mac. Runs on-device, free and unlimited."
          pendingNote="Read aloud and Interactive appear once it's ready."
          attribution={
            <>
              Speech by Kyutai&apos;s <LocalModuleLink href={POCKET_TTS_URL}>Pocket TTS</LocalModuleLink>, licensed{' '}
              <LocalModuleLink href={CC_BY_4_URL}>CC BY 4.0</LocalModuleLink>
            </>
          }
        />

        {isLocalModuleUsable(tts.info) && <ReadAloudOptions />}
      </div>
    </div>
  )
}

type PreviewState = { id: string; playing: boolean } | null

let previewSeq = 0
/** Per page load, so a previous page's preview events never match. */
const previewLoadId = Math.random().toString(36).slice(2, 8)

function ReadAloudOptions() {
  const recording = useOptionalRecordingStable()
  // A capture, or a Voice ID enrollment recording the user's voice (whose
  // voiceprint must never hear the preview).
  const enrolling = useReadAloudHeld()
  const isRecording = !!(recording?.isRecording || recording?.isStarting) || enrolling

  const [auto, setAuto] = useState(getReadAloudAuto)
  const [voiceId, setVoiceId] = useState(getReadAloudVoice)
  const [voices, setVoices] = useState<TtsVoice[] | null>(null)
  /** null: this desktop build has no Speed setting. */
  const [speed, setSpeed] = useState<number | null>(null)
  const [preview, setPreview] = useState<PreviewState>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const previewRef = useRef<PreviewState>(null)
  previewRef.current = preview

  useEffect(() => {
    let cancelled = false
    void speechOutput.voices().then((list) => {
      if (!cancelled) setVoices(list)
    })
    void speechOutput
      .rate()
      .then((rate) => {
        if (!cancelled) setSpeed(rate === null ? null : nearestSpeed(rate))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const handleSpeed = useCallback((value: string) => {
    const rate = Number(value)
    setSpeed(rate)
    void speechOutput
      .setRate(rate)
      .then((applied) => setSpeed(nearestSpeed(applied)))
      .catch(() => {})
  }, [])

  // The preview's own sentence: playing until it is done, cancelled or fails.
  useEffect(() => {
    return speechOutput.onState((p) => {
      if (p.id !== previewRef.current?.id) return
      if (p.state === 'speaking') setPreview({ id: p.id, playing: true })
      if (p.state === 'done' || p.state === 'cancelled' || p.state === 'error') setPreview(null)
    })
  }, [])

  // Leaving the page (or a recording starting) silences a preview.
  // (holdReadAloud already cancelled the desktop for an enrollment.)
  useEffect(() => {
    if (isRecording && previewRef.current) {
      setPreview(null)
      void speechOutput.cancel()
    }
  }, [isRecording])
  useEffect(() => {
    return () => {
      if (previewRef.current) void speechOutput.cancel()
    }
  }, [])

  const defaultVoice = voices?.find((v) => v.default) ?? voices?.[0] ?? null
  // A stored id the catalogue no longer has falls back to the default.
  const selected = voices?.find((v) => v.id === voiceId) ?? defaultVoice

  const handleAuto = useCallback((on: boolean) => {
    setAuto(on)
    setReadAloudAuto(on)
  }, [])

  const handleVoice = useCallback(
    (id: string) => {
      setVoiceId(id)
      // The default is stored as "nothing stored".
      const stored = id === defaultVoice?.id ? null : id
      setReadAloudVoice(stored)
      // Read anywhere reads in this voice too.
      void syncReadAnywhereVoice(stored)
    },
    [defaultVoice],
  )

  const handlePreview = useCallback(async () => {
    setPreviewError(null)
    if (previewRef.current) {
      previewRef.current = null
      setPreview(null)
      await speechOutput.cancel()
      return
    }
    if (!selected) return
    const id = `preview:${previewLoadId}:${previewSeq++}`
    // The ref leads the state so an early tts://state event already matches.
    previewRef.current = { id, playing: false }
    setPreview(previewRef.current)
    await speechOutput.cancel()
    try {
      await speechOutput.speak({
        id,
        text: `Hi, I'm ${selected.name}. This is how Dial8 will read your replies.`,
        voice: selected.id,
      })
    } catch (err) {
      if (previewRef.current?.id === id) previewRef.current = null
      setPreview(null)
      setPreviewError(
        err instanceof TtsRefusedError && err.code === 'recording'
          ? 'Read aloud is paused while a capture is recording.'
          : 'Couldn’t play the preview. Try again.',
      )
    }
  }, [selected])

  return (
    <div className="space-y-4 rounded-lg border border-border bg-muted/30 px-4 py-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Label className="text-sm font-medium">Auto-read replies</Label>
          <p className="text-xs text-muted-foreground">
            Speak each chat reply as it arrives, sentence by sentence. Otherwise, use the speaker button on a reply.
          </p>
        </div>
        <Switch aria-label="Auto-read replies" checked={auto} onCheckedChange={handleAuto} />
      </div>

      {voices && voices.length > 0 && selected && (
        <div className="space-y-1.5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <Label className="text-sm font-medium">Voice</Label>
              {selected.description && <p className="text-xs text-muted-foreground">{selected.description}</p>}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Select value={selected.id} onValueChange={handleVoice}>
                <SelectTrigger className="w-40" aria-label="Voice">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {voices.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      {v.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="sm"
                className="h-9"
                disabled={isRecording}
                onClick={() => {
                  void handlePreview()
                }}
              >
                {preview ? (
                  preview.playing ? (
                    <Square className="mr-1.5 h-3 w-3 fill-current" />
                  ) : (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  )
                ) : (
                  <Volume2 className="mr-1.5 h-3.5 w-3.5" />
                )}
                {preview ? 'Stop' : 'Preview'}
              </Button>
            </div>
          </div>
          {previewError && <p className="text-[11px] text-red-700 dark:text-red-400">{previewError}</p>}
        </div>
      )}

      {speed !== null && (
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <Label className="text-sm font-medium">Speed</Label>
            <p className="text-xs text-muted-foreground">
              How fast replies, Read anywhere and voice mode speak, at the same pitch.
            </p>
          </div>
          <Select value={String(speed)} onValueChange={handleSpeed}>
            <SelectTrigger className="w-40" aria-label="Speed">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SPEEDS.map((s) => (
                <SelectItem key={s} value={String(s)}>
                  {s === 1 ? 'Normal' : `${s}×`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  )
}
