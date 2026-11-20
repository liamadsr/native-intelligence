'use client'

import type { ReactNode } from 'react'
import { MicOff } from 'lucide-react'
import { useAgentActivity } from '@/hooks/recording-context'
import {
  ToolCallsView,
  TranscriptView,
  useCaptureFinalSegmentCount,
  useCaptureTranscript,
  type CaptureTranscriptSource,
} from '@/components/capture/live-capture-header'

/**
 * The capture page's Transcripts and Tools, as tabs beside Overview and Agents
 * (Liam, 11-20: the row of floating pills at the foot of the card "looks
 * ugly"; nothing floats at the bottom any more). They were pills whose cards
 * rose out of them (the old live-capture-pills.tsx); the lines, the speakers,
 * Copy and the count are the same, the count on the tab's label now.
 *
 * Every piece is a LEAF over the recording stores, as the pills were, so the
 * transcript's ~6-7×/s flushes never reach the ~4k-line capture page:
 *   - the Transcripts tab's label reads only the final-line COUNT
 *     (useCaptureFinalSegmentCount: new finals, never interim flushes);
 *   - the transcript's lines are read by TranscriptLines, mounted only while
 *     the Transcripts tab is the one shown;
 *   - the Tools tab (label and list) reads the live agent's activity itself.
 *
 * Tools is a tab only while the capture records: the live agent's calls exist
 * only then, so after it the tab would only ever open onto nothing (the pills'
 * rule, kept). The page decides that; these just draw.
 */

/** A tab's count, beside its name: muted, and absent at zero. */
function TabCount({ count }: { count: number }) {
  if (count <= 0) return null
  return <span data-capture-tab-count="" className="tabular-nums opacity-60">{count}</span>
}

export type TranscriptsTabLabelProps = Pick<
  CaptureTranscriptSource,
  'isActiveRecording' | 'persistedTranscript' | 'holdsLiveSegments'
> & {
  /** A desktop capture that has lost the other side's audio: an amber muted mic on the tab. */
  alert?: boolean
}

/** "Transcripts 12": the Transcripts tab's label, counting the final lines. */
export function TranscriptsTabLabel({ alert = false, ...source }: TranscriptsTabLabelProps) {
  const count = useCaptureFinalSegmentCount(source)
  return (
    <span
      className="inline-flex items-center gap-1.5"
      title={alert ? "System audio isn't being captured — open for details" : undefined}
    >
      {alert && <MicOff aria-label="System audio isn't being captured" className="h-3 w-3 text-amber-500" />}
      <span>Transcripts</span>
      <TabCount count={count} />
    </span>
  )
}

/** "Tools 3": the Tools tab's label, counting the live agent's calls. */
export function ToolsTabLabel() {
  const events = useAgentActivity()
  return (
    <span className="inline-flex items-center gap-1.5">
      <span>Tools</span>
      <TabCount count={events.length} />
    </span>
  )
}

export type TranscriptsSectionProps = CaptureTranscriptSource & {
  speakerNames: Record<string, string>
  demotedSelfLabels?: ReadonlySet<string>
  /** Whether the tab is the one shown. Hidden, the lines are not mounted. */
  active: boolean
  /** Heads the tab: the system-audio notice, about who is in this transcript. */
  notice?: ReactNode
  /** Under the notice: Voice ID, the speakers heard (null while it is in the live agent's HUD). */
  voiceId?: ReactNode
}

/**
 * The Transcripts tab's page: the notice and Voice ID, then the transcript in
 * a reading column, with Copy. The notice and Voice ID stay mounted while
 * another tab shows (hidden), so the notice's grant flow ("stop and restart
 * the capture…") survives the OS prompt taking focus, as it did in the pill's
 * card; the lines mount only while the tab is shown.
 */
export function TranscriptsSection({
  speakerNames,
  demotedSelfLabels,
  active,
  notice,
  voiceId,
  ...source
}: TranscriptsSectionProps) {
  return (
    <div
      data-capture-section="transcripts"
      className={active ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}
    >
      <div className="mx-auto flex min-h-0 w-full max-w-[736px] flex-1 flex-col px-4 pt-2 sm:px-6">
        {notice && <div data-capture-transcript-notice="" className="shrink-0 pb-2 empty:hidden">{notice}</div>}
        {voiceId && <div data-capture-voice-id="" className="shrink-0 pb-2 empty:hidden">{voiceId}</div>}
        <div className="min-h-0 flex-1">
          {active && (
            <TranscriptLines speakerNames={speakerNames} demotedSelfLabels={demotedSelfLabels} {...source} />
          )}
        </div>
      </div>
    </div>
  )
}

/** The transcript's lines, read here — below the section — so their flushes
 *  re-render only this, and only while the tab is shown. */
function TranscriptLines({
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

/** The Tools tab's page: the live agent's tool calls, in a reading column. */
export function ToolsSection() {
  const events = useAgentActivity()
  return (
    <div data-capture-section="tools" className="flex min-h-0 flex-1 flex-col">
      <div className="mx-auto flex min-h-0 w-full max-w-[736px] flex-1 flex-col px-4 pt-2 sm:px-6">
        <ToolCallsView events={events} title="Live agent tool calls" />
      </div>
    </div>
  )
}
