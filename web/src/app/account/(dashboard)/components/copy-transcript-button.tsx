'use client'

import { useEffect, useRef, useState } from 'react'
import { Check, ScrollText } from 'lucide-react'
import { toast } from 'sonner'
import { PreferenceActionButton } from '@/components/views/preference-action'
import { copyTextToClipboard } from '@/lib/clipboard'
import { useOptionalRecordingStable } from '@/hooks/recording-context'
import {
  displayTranscriptSegments,
  transcriptCopyText,
  type CaptureTranscriptSource,
} from '@/components/capture/live-capture-header'

/**
 * "Copy transcript" in a capture's window preferences: the whole transcript as
 * text ("Name: words" a line), whether the capture is recording or long
 * stopped — during a live desktop call the transcript is in the live agent's
 * HUD, which has no copy, and the composer's Transcripts pill steps aside.
 *
 * Read when clicked, never subscribed to: the live transcript flushes every
 * ~150ms, and this sits in the panel's toolbar, which must stay off that path.
 * `liveIsThisCapture`: the recording's live buffer belongs to this capture (it
 * is recording, or was the last one recorded this session) — never another's.
 */
export function CopyTranscriptButton({
  isActiveRecording,
  liveIsThisCapture,
  resumedPriorTranscript,
  persistedTranscript,
  speakerNames,
  demotedSelfLabels,
}: CaptureTranscriptSource & {
  liveIsThisCapture: boolean
  speakerNames: Record<string, string>
  demotedSelfLabels?: ReadonlySet<string>
}) {
  const stable = useOptionalRecordingStable()
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  const copy = async () => {
    const live = liveIsThisCapture ? (stable?.getTranscriptSegmentsSnapshot() ?? []) : []
    const segments = displayTranscriptSegments(isActiveRecording, live, resumedPriorTranscript, persistedTranscript)
    const text = transcriptCopyText(segments, speakerNames, demotedSelfLabels)
    if (!text) {
      toast('No transcript yet')
      return
    }
    try {
      if (!(await copyTextToClipboard(text))) {
        toast.error("Couldn't copy the transcript")
        return
      }
      if (timer.current) clearTimeout(timer.current)
      setCopied(true)
      timer.current = setTimeout(() => {
        setCopied(false)
        timer.current = null
      }, 1500)
    } catch {
      toast.error("Couldn't copy the transcript")
    }
  }

  return (
    <PreferenceActionButton
      label={copied ? 'Copied transcript' : 'Copy transcript'}
      variant="ghost"
      size="sm"
      className="h-7 w-7 p-0"
      title="Copy transcript"
      onClick={copy}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <ScrollText className="h-3.5 w-3.5" />}
    </PreferenceActionButton>
  )
}
