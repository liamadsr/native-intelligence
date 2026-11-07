'use client'

import type { ReactNode } from 'react'
import { MessageSquareText, MicOff, Wrench } from 'lucide-react'
import { useAgentActivity } from '@/hooks/recording-context'
import {
  ToolCallsView,
  TranscriptView,
  useCaptureFinalSegmentCount,
  useCaptureTranscript,
  type CaptureTranscriptSource,
} from '@/components/capture/live-capture-header'
import { ComposerLiquidPill } from '../chat/composer-liquid-pill'

/** The Transcripts card: room to read a few exchanges. */
const TRANSCRIPT_CARD_WIDTH_PX = 380
const TRANSCRIPT_CARD_HEIGHT_PX = 360

/** The Tools card: a list of one-line calls. */
const TOOLS_CARD_WIDTH_PX = 320
const TOOLS_CARD_HEIGHT_PX = 280

export type LiveTranscriptsPillProps = CaptureTranscriptSource & {
  speakerNames: Record<string, string>
  demotedSelfLabels?: ReadonlySet<string>
  notice?: ReactNode
  alert?: boolean
}

/**
 * The capture's transcript, as a pill at the foot of its card (see
 * CaptureControlsBar) whose card rises out of it (see ComposerLiquidPill):
 * the live transcript while
 * this capture records, the saved one after. The pill counts its final lines.
 *
 * A leaf: it reads the live transcript itself, so the transcript's flushes
 * never reach the capture page that places it. And the pill face reads only
 * its COUNT (useCaptureFinalSegmentCount — new finals, never interim
 * flushes); the lines are read by the card's content (TranscriptCardContent),
 * mounted only while the card is out. So while it's shut — most of a meeting —
 * a flush re-renders nothing here at all.
 *
 * `notice` heads the card — the capture page's system-audio notice, which is
 * about exactly this transcript (whether the other side is in it). It stays
 * mounted while the card is shut, so its grant flow's follow-up ("stop and
 * restart the capture…") survives the OS prompt taking focus. `alert` swaps
 * the pill's icon for an amber muted mic, so a capture that has lost the other
 * side's audio says so without the card being opened.
 */
export function LiveTranscriptsPill({
  speakerNames,
  demotedSelfLabels,
  notice,
  alert = false,
  ...source
}: LiveTranscriptsPillProps) {
  const finalSegmentCount = useCaptureFinalSegmentCount(source)
  return (
    <ComposerLiquidPill
      name="transcripts"
      label="Transcripts"
      icon={
        alert ? (
          <MicOff className="h-3.5 w-3.5 text-amber-500" />
        ) : (
          <MessageSquareText className="h-3.5 w-3.5" />
        )
      }
      count={finalSegmentCount}
      title={alert ? "System audio isn't being captured — open for details" : undefined}
      cardLabel="Transcript"
      cardMaxWidth={TRANSCRIPT_CARD_WIDTH_PX}
      cardMaxHeight={TRANSCRIPT_CARD_HEIGHT_PX}
      cardHeader={notice ? <div className="shrink-0 px-2 pt-2 empty:hidden">{notice}</div> : null}
    >
      <TranscriptCardContent
        isActiveRecording={source.isActiveRecording}
        resumedPriorTranscript={source.resumedPriorTranscript}
        persistedTranscript={source.persistedTranscript}
        holdsLiveSegments={source.holdsLiveSegments}
        speakerNames={speakerNames}
        demotedSelfLabels={demotedSelfLabels}
      />
    </ComposerLiquidPill>
  )
}

/** The Transcripts card's content: the transcript's lines, read here — below
 *  the pill — so their flushes re-render only this, and only while the card
 *  is out (ComposerLiquidPill mounts its children just then). */
function TranscriptCardContent({
  speakerNames,
  demotedSelfLabels,
  ...source
}: CaptureTranscriptSource & {
  speakerNames: Record<string, string>
  demotedSelfLabels?: ReadonlySet<string>
}) {
  const { segments } = useCaptureTranscript(source)
  return (
    <TranscriptView
      segments={segments}
      speakerNames={speakerNames}
      demotedSelfLabels={demotedSelfLabels}
      title="Transcript"
    />
  )
}

/**
 * The live agent's tool calls, as a pill beside Transcripts whose card rises
 * out of it. A leaf, like Transcripts: it reads the agent's activity itself.
 */
export function LiveToolsPill() {
  const events = useAgentActivity()
  return (
    <ComposerLiquidPill
      name="tools"
      label="Tools"
      icon={<Wrench className="h-3.5 w-3.5" />}
      count={events.length}
      cardLabel="Live agent tool calls"
      cardMaxWidth={TOOLS_CARD_WIDTH_PX}
      cardMaxHeight={TOOLS_CARD_HEIGHT_PX}
    >
      <ToolCallsView events={events} title="Tools" />
    </ComposerLiquidPill>
  )
}

/**
 * The capture's pills, at the foot of its card (CaptureControlsBar):
 * Transcripts, and Tools only while the capture is recording. The live
 * agent's tool calls exist only during the recording, so after it a Tools pill
 * would only ever open onto nothing; the saved transcript is still there to
 * read.
 */
export function LiveCapturePills(props: LiveTranscriptsPillProps) {
  return (
    <>
      <LiveTranscriptsPill {...props} />
      {props.isActiveRecording && <LiveToolsPill />}
    </>
  )
}
