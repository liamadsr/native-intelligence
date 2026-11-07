'use client'

/**
 * The agent card's Call (Liam, 2026-10-23, Dots' agent card: "add the call
 * button to the agent page which should just start the voice mode"): one
 * wide button under the agent's row that starts the main chat's voice mode
 * (birds/voice-bird.ts callMainVoice: the composer's waveform's way, no
 * bird), and hangs it up.
 *
 * Its state is voice mode's own (useMainVoice, as the chat panel reports it:
 * it reports itself on the moment it starts opening the mic), never one of
 * its own, so it can't stick: Call while off; Calling… while voice mode
 * starts, and a click then hangs up; End call while it's on. A refusal toasts
 * at the chat, as the waveform's does.
 *
 * Voice mode is the desktop's, once its speech models are in
 * (useVoiceAvailability `conversation`): anywhere else there is no button,
 * as the composer has no waveform there. While a capture records, or Voice ID
 * enrollment listens, Call says why and does nothing (aria-disabled, so the
 * reason can still be reached from the keyboard); a call already under way
 * can always be hung up.
 */
import { callMainVoice, endMainVoice, useMainVoice } from '@/components/birds/voice-bird'
import { useOptionalRecordingStable } from '@/hooks/recording-context'
import { useVoiceAvailability, voiceBlockedLabel } from '@/hooks/use-voice-availability'
import { cn } from '@/lib/utils'
import { Loader2, Phone, PhoneOff } from 'lucide-react'

/** `className` is its box's (its spacing): none at all where there's no button. */
export function AgentCallButton({ name, className }: { name: string; className?: string }) {
  const recording = useOptionalRecordingStable()
  const availability = useVoiceAvailability({ recording: !!(recording?.isRecording || recording?.isStarting) })
  const call = useMainVoice()
  if (!availability.conversation) return null

  const blocked = call === 'off' && availability.blocked ? voiceBlockedLabel(availability.blocked) : null
  const onClick = () => {
    if (blocked) return
    if (call === 'off') void callMainVoice()
    else endMainVoice()
  }
  // Each label holds the words it shows (a voice command says what it sees).
  const label = call === 'on' ? `End call with ${name}` : call === 'starting' ? `Calling ${name}… (hang up)` : `Call ${name}`
  return (
    <div className={className}>
      <button
        type="button"
        data-agent-call={call}
        aria-label={label}
        aria-disabled={blocked ? true : undefined}
        title={blocked ?? undefined}
        onClick={onClick}
        className={cn(
          'flex h-9 w-full items-center justify-center gap-2 rounded-xl text-[13px] font-medium transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none',
          call === 'on'
            ? 'bg-red-500/10 text-red-700 hover:bg-red-500/15 dark:text-red-400'
            : 'bg-muted/70 text-foreground hover:bg-muted',
          blocked && 'cursor-default opacity-60 hover:bg-muted/70',
        )}
      >
        {call === 'on' ? (
          <PhoneOff aria-hidden className="size-4" />
        ) : call === 'starting' ? (
          <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />
        ) : (
          <Phone aria-hidden className="size-4" />
        )}
        {call === 'on' ? 'End call' : call === 'starting' ? 'Calling…' : 'Call'}
      </button>
    </div>
  )
}
