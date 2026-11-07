'use client'

/**
 * The speaker button on an assistant reply (read-aloud, desktop local-tts
 * only). ChatPanel owns one useReadAloud and hands it down through
 * ReadAloudContext, so ChatMessage keeps its memoized props: only this button
 * re-renders when reading starts, pauses or stops.
 *
 * Read aloud (idle) → Pause (reading) → Resume (paused: it picks up at the
 * sentence it stopped in, @/lib/read-aloud/resume-points; a reply read to its
 * end starts over). `data-read-aloud` says which: `speaking`, `paused` (the
 * most recent pause anywhere, so its actions row stays pinned like while
 * speaking, see chat-message.tsx), `resumable` (an older pause: Resume on
 * hover only) or `idle`.
 *
 * Renders nothing unless read-aloud is supported (desktop + local-tts Ready +
 * not recording), so the browser never shows it.
 */

import { createContext, memo, useContext } from 'react'
import { Pause, Play, Volume2 } from 'lucide-react'
import type { UIMessage } from '@ai-sdk/react'
import { Button } from '@/components/ui/button'
import { MessageAction } from '@/components/ui/message'
import type { ReadAloudHandle } from '@/hooks/use-read-aloud'
import { messageSpeechMarkdown } from '@/lib/read-aloud/message-text'
import { useIsLastPaused, useResumePoint } from '@/lib/read-aloud/resume-points'

export const ReadAloudContext = createContext<ReadAloudHandle | null>(null)

export const ReadAloudButton = memo(function ReadAloudButton({ message }: { message: UIMessage }) {
  const readAloud = useContext(ReadAloudContext)
  const resumable = useResumePoint(message.id) !== null
  const lastPaused = useIsLastPaused(message.id)
  if (!readAloud?.supported) return null

  const speaking = readAloud.speakingMessageId === message.id
  const paused = !speaking && resumable
  const state = speaking ? 'speaking' : paused ? (lastPaused ? 'paused' : 'resumable') : 'idle'
  const label = speaking ? 'Pause' : paused ? 'Resume' : 'Read aloud'
  return (
    <MessageAction tooltip={label}>
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6"
        aria-label={label}
        aria-pressed={speaking}
        // MessageActions stays visible while this reply is being read or is
        // the one paused last, so Pause and Resume are reachable without
        // hovering (see chat-message.tsx).
        data-read-aloud={state}
        onClick={() => {
          if (speaking) readAloud.pause()
          else readAloud.speakMessage(message.id, messageSpeechMarkdown(message))
        }}
      >
        {speaking ? (
          <Pause className="h-3 w-3 fill-current" />
        ) : paused ? (
          <Play className="h-3 w-3 fill-current" />
        ) : (
          <Volume2 className="h-3 w-3" />
        )}
      </Button>
    </MessageAction>
  )
})
