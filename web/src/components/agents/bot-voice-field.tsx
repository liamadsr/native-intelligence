'use client'

/**
 * A bot's voice in the one agent editor (docs/plans/bots-v4.md, Phase B2): one
 * of the desktop app's voices (`tts_voices`), or Automatic (lib/bots/bot-voice.ts):
 * a voice dealt from its face that the other bots on screen aren't using, while
 * there are enough to go round; or, when another bot wearing the same face
 * chose a voice, that one (one face speaks one voice), and the field says so.
 * "Hear it" says a line in the voice picked (`tts_speak { voice }`), or in the
 * one Automatic gives it now.
 *
 * It's the bot's own, like its face (decision 11): saving changes only this
 * bot (editor-model.ts planEditorSave). Two bots may share a voice: the field
 * says which other bots in the workspace chose this one, and never refuses it.
 * A voice this Mac doesn't have stays chosen (another Mac may have it), stays
 * on offer to go back to, and here the bot speaks automatically.
 *
 * The browser has no voices, so nothing shows there; nor on a desktop build
 * that lists none. A radio group of plain buttons, as the skills picker, so the
 * voices read top to bottom for a screen reader: Tab reaches the one picked,
 * and the arrow keys (Home, End) move the pick.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { Loader2, Square, Volume2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useOptionalRecordingStable } from '@/hooks/recording-context'
import { automaticVoice, faceVoiceBesides, useBotVoiceCrewNow, useDeviceVoices } from '@/lib/bots/bot-voice'
import { voiceUsedByLabel } from '@/lib/bots/workspace-faces'
import { useReadAloudHeld } from '@/lib/read-aloud/mic-guard'
import { TtsRefusedError, type TtsVoice } from '@/lib/tauri-bridge'
import { speechOutput } from '@/lib/speech-output'
import type { FieldRule } from '@/lib/agents/editable-fields'
import type { EditorFace } from '@/lib/agents/editor-model'
import { cn } from '@/lib/utils'
import { EditorField } from './editor-field'

export interface BotVoiceFieldProps {
  /** The bot's id; null for a bot still to be made. Its own entry is left out of "Also used by". */
  botId: string | null
  /** Its name, as the sample says it. */
  name: string
  /** Its face as it's being edited: what Automatic deals from. */
  face: string | null
  /** The voice picked: a desktop voice id, or null for Automatic. */
  value: string | null
  /** The voice it has saved (null: Automatic, or a bot still to be made): Automatic's sample leaves it out. */
  saved: string | null
  onChange: (voice: string | null) => void
  rule: FieldRule
  /** The workspace's faces, with the voices their bots chose (the editor's read). */
  faces?: readonly Pick<EditorFace, 'id' | 'name' | 'voice'>[]
}

/** Why "Hear it" couldn't speak, in words. */
export function sampleError(err: unknown): string {
  if (err instanceof TtsRefusedError) {
    if (err.code === 'recording') return 'It can’t speak while a capture is recording.'
    if (err.code === 'not_ready') return 'Read aloud isn’t set up on this Mac yet: Settings → Voice.'
  }
  return 'Couldn’t play it. Try again.'
}

/** What the Automatic choice says it does: a voice another bot on its face chose (`shared`, by name), or the deal. */
export function automaticNote(shared: string | null): string {
  return shared
    ? `Another agent like it chose ${shared}, so on Automatic it speaks in that voice too.`
    : 'Automatic picks a voice the other agents aren’t using, while there are enough to go round.'
}

/** Where an arrow key moves the pick in a group of `count`, from `at`; null for any other key. */
export function radioStep(key: string, at: number, count: number): number | null {
  if (count === 0) return null
  if (key === 'ArrowRight' || key === 'ArrowDown') return (at + 1) % count
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (at - 1 + count) % count
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  return null
}

/** What "Hear it" says, in the bot's name. */
export function sampleLine(name: string): string {
  return `Hi, I’m ${name.trim() || 'your agent'}. This is how I’ll sound.`
}

export function BotVoiceField(props: BotVoiceFieldProps) {
  const labelId = useId()
  const voices = useDeviceVoices()
  // The browser, or a desktop that lists no voices: nothing to pick, so no field.
  if (voices === null) return null
  return (
    <EditorField label="Voice" labelId={labelId} hint="How it sounds when it talks to you in the desktop app." rule={props.rule}>
      {voices === undefined ? <Skeleton className="h-7 w-full" data-voice-loading="" /> : <VoicePicker {...props} voices={voices} labelledBy={labelId} />}
    </EditorField>
  )
}

function VoicePicker({
  botId,
  name,
  face,
  value,
  saved,
  onChange,
  rule,
  faces = [],
  voices,
  labelledBy,
}: BotVoiceFieldProps & { voices: readonly TtsVoice[]; labelledBy: string }) {
  const crew = useBotVoiceCrewNow()
  const sample = useVoiceSample()
  const onThisMac = (id: string) => voices.some((v) => v.id === id)
  const here = value === null || onThisMac(value)
  // What Automatic gives it now: its face's voice among the bots on screen, without the one it saved.
  const automatic = automaticVoice(face ?? '', voices, crew.faces, crew.chosen, saved)
  // Another bot on its face chose a voice: on Automatic it speaks in that one.
  const shared = faceVoiceBesides(face ?? '', voices, crew.chosen, saved)
  const usedBy = voiceUsedByLabel(faces, value, botId)
  // Chosen on another Mac: it stays on offer (to go back to after trying others), though this Mac can't say it.
  const missing = [...new Set([saved, value])].filter((id): id is string => !!id && !onThisMac(id))
  const choices: Array<{ id: string | null; label: string }> = [
    { id: null, label: 'Automatic' },
    ...voices.map((v) => ({ id: v.id, label: v.name })),
    ...missing.map((id) => ({ id, label: `${id} (not on this Mac)` })),
  ]
  const picked = Math.max(
    0,
    choices.findIndex((c) => c.id === value),
  )
  const buttons = useRef<Array<HTMLButtonElement | null>>([])
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, at: number) => {
    const to = radioStep(e.key, at, choices.length)
    if (to === null) return
    e.preventDefault()
    onChange(choices[to].id)
    buttons.current[to]?.focus()
  }

  return (
    <div className="space-y-1.5" data-bot-voice={value ?? 'automatic'}>
      <div role="radiogroup" aria-labelledby={labelledBy} className="flex flex-wrap gap-1.5">
        {choices.map((choice, index) => {
          const on = choice.id === value
          return (
            <button
              key={choice.id ?? ':automatic'}
              ref={(el) => {
                buttons.current[index] = el
              }}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={index === picked ? 0 : -1}
              disabled={!rule.editable}
              data-voice-choice={choice.id ?? 'automatic'}
              onClick={() => onChange(choice.id)}
              onKeyDown={(e) => onKey(e, index)}
              className={cn(
                'inline-flex h-7 items-center rounded-full border px-2.5 text-xs transition-colors disabled:cursor-default',
                on ? 'border-primary bg-primary/10 font-medium' : 'hover:bg-muted disabled:hover:bg-transparent',
                !rule.editable && !on && 'opacity-50',
              )}
            >
              {choice.label}
            </button>
          )
        })}
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 text-xs"
          disabled={sample.quiet}
          data-voice-sample={sample.playing ? 'playing' : ''}
          onClick={() => void sample.toggle(here && value ? value : automatic, name)}
        >
          {sample.playing ? (
            sample.speaking ? (
              <Square className="h-3 w-3 fill-current" />
            ) : (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            )
          ) : (
            <Volume2 className="h-3.5 w-3.5" />
          )}
          {sample.playing ? 'Stop' : 'Hear it'}
        </Button>
        {value === null && (
          <p className="text-[11px] text-muted-foreground" data-voice-note={shared ? 'shared' : 'automatic'}>
            {automaticNote(shared ? (voices.find((v) => v.id === shared)?.name ?? shared) : null)}
          </p>
        )}
      </div>
      {!here && (
        <p className="text-[11px] text-muted-foreground" data-voice-note="missing">
          This Mac doesn’t have that voice, so here it speaks automatically.
        </p>
      )}
      {usedBy && (
        <p className="text-[11px] text-muted-foreground" data-voice-used-by="">
          {usedBy}. Agents can share a voice.
        </p>
      )}
      {sample.error && (
        <p role="alert" className="text-[11px] text-destructive" data-voice-sample-error="">
          {sample.error}
        </p>
      )}
    </div>
  )
}

type Playing = { id: string; speaking: boolean } | null

let sampleSeq = 0
/** Per page load, so an earlier page's sample events never match. */
const sampleLoad = Math.random().toString(36).slice(2, 8)

/**
 * "Hear it": one line in a voice, played until it's done, stopped or fails.
 * Not while a capture records or something holds read-aloud off (a Voice ID
 * enrollment); one starting stops it, and so does the editor closing.
 */
function useVoiceSample() {
  const recording = useOptionalRecordingStable()
  const held = useReadAloudHeld()
  const quiet = !!(recording?.isRecording || recording?.isStarting) || held
  const [playing, setPlaying] = useState<Playing>(null)
  const [error, setError] = useState<string | null>(null)
  const playingRef = useRef<Playing>(null)
  playingRef.current = playing

  useEffect(() => {
    return speechOutput.onState((p) => {
      if (p.id !== playingRef.current?.id) return
      if (p.state === 'speaking') setPlaying({ id: p.id, speaking: true })
      if (p.state === 'done' || p.state === 'cancelled' || p.state === 'error') {
        playingRef.current = null
        setPlaying(null)
      }
    })
  }, [])
  useEffect(() => {
    if (quiet && playingRef.current) {
      playingRef.current = null
      setPlaying(null)
      void speechOutput.cancel()
    }
  }, [quiet])
  useEffect(
    () => () => {
      if (playingRef.current) void speechOutput.cancel()
    },
    [],
  )

  const toggle = async (voice: string | null, name: string) => {
    setError(null)
    if (playingRef.current) {
      playingRef.current = null
      setPlaying(null)
      await speechOutput.cancel()
      return
    }
    const id = `bot-voice-sample:${sampleLoad}:${sampleSeq++}`
    // The ref leads the state, so an early tts://state event already matches.
    playingRef.current = { id, speaking: false }
    setPlaying(playingRef.current)
    await speechOutput.cancel()
    try {
      await speechOutput.speak(voice ? { id, text: sampleLine(name), voice } : { id, text: sampleLine(name) })
    } catch (err) {
      if (playingRef.current?.id === id) {
        playingRef.current = null
        setPlaying(null)
      }
      setError(sampleError(err))
    }
  }

  return { playing: playing !== null, speaking: !!playing?.speaking, quiet, error, toggle }
}
