'use client'

/**
 * Landing demo of Voice ID on a capture: the capture's card (DemoCard) with
 * its Transcripts card risen out of the pill at its foot, as it opens in the
 * app. The speakers row is the product's VoiceIdCarousel and the lines are
 * its TranscriptView (components/capture/live-capture-header.tsx), on fixture
 * data: two voices Dial8 knows, and one it suggests ("Michael Chen (92%)")
 * that is accepted after a moment, relabelling every one of that voice's
 * lines in place. Content is FICTIONAL.
 */
import { useEffect, useMemo, useState } from 'react'
import { TranscriptView, VoiceIdCarousel } from '@/components/capture/live-capture-header'
import type { TranscriptSegment } from '@/lib/deepgram-stream'
import type { SpeakerIdentification } from '@/lib/voice-id-service'
import { CaptureFoot } from './capture-demo'
import { DemoCard, DemoSky, DemoTabs } from './demo-card'

const YOU = 'local_1'
const JOANNA = 'remote_1'
const MICHAEL = 'remote_2'

const LINES: [string, string][] = [
  [JOANNA, 'Let’s ship the migration behind a flag first and watch it for a week.'],
  [YOU, 'Agreed. I’ll stage the rollout in us-east before Thursday.'],
  [MICHAEL, 'I can own the dashboards for the cutover and flag anything weird.'],
  [JOANNA, 'Perfect. Michael, loop in on-call before you flip it.'],
  [MICHAEL, 'Will do. I’ll post the runbook in the channel today.'],
]

const SEGMENTS: TranscriptSegment[] = LINES.map(([speaker, text], i) => ({
  id: `seg-${i}`,
  text,
  speaker,
  stream: speaker === YOU ? 'mic' : 'system',
  startTime: i * 6,
  endTime: i * 6 + 5,
  isFinal: true,
})) as TranscriptSegment[]

const known = (contactName: string, confidence: number): SpeakerIdentification => ({
  contactId: '',
  contactName,
  confidence,
  isAutoMatched: true,
})

const noop = () => {}

export function SpeakerIdDemo() {
  // 0: Michael's voice suggested; 1: accepted.
  const [accepted, setAccepted] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setAccepted((a) => !a), accepted ? 4200 : 3000)
    return () => clearTimeout(t)
  }, [accepted])

  const speakerContacts = useMemo<Record<string, SpeakerIdentification>>(
    () => ({
      [JOANNA]: known('Joanna Park', 0.97),
      [MICHAEL]: accepted ? known('Michael Chen', 0.92) : { ...known('Michael Chen', 0.92), isSuggestion: true },
    }),
    [accepted],
  )
  const speakerNames = useMemo<Record<string, string>>(
    () => ({ [JOANNA]: 'Joanna Park', ...(accepted ? { [MICHAEL]: 'Michael Chen' } : {}) }),
    [accepted],
  )

  return (
    <DemoSky className="p-3 sm:p-4">
      <div className="[zoom:0.8]">
        <DemoCard title="Platform migration sync" className="h-[600px]">
          <DemoTabs active="Overview" tabs={[{ label: 'Overview' }, { label: 'Agents' }]} />
          <div className="relative min-h-0 flex-1 overflow-hidden px-8">
            <h1 className="pt-4 pb-1 text-2xl font-semibold leading-snug">Platform migration sync</h1>
            <div className="prose prose-sm max-w-full opacity-60 dark:prose-invert prose-headings:font-semibold prose-h2:mb-2 prose-h2:mt-5 prose-p:my-2">
              <h2>Summary</h2>
              <p>The migration ships behind a flag in us-east this week, with a week of watching before the rest of the fleet.</p>
            </div>

            {/* The Transcripts card, risen out of its pill at the card's foot. */}
            <div className="absolute bottom-2 right-3 flex h-[400px] w-[400px] max-w-[calc(100%-1.5rem)] flex-col overflow-hidden rounded-2xl bg-white shadow-[0_10px_40px_-10px_rgb(0_0_0/0.35),0_2px_8px_rgb(0_0_0/0.08)] ring-1 ring-black/5 dark:bg-black dark:ring-white/10">
              <div className="shrink-0 px-2 pt-2">
                <VoiceIdCarousel
                  detectedSpeakers={[JOANNA, YOU, MICHAEL]}
                  activeSpeaker={MICHAEL}
                  speakerNames={speakerNames}
                  speakerContacts={speakerContacts}
                  assignContact={noop}
                  acceptSuggestion={noop}
                  dismissSuggestion={noop}
                  unlinkSpeaker={noop}
                />
              </div>
              <div className="min-h-0 flex-1">
                <TranscriptView segments={SEGMENTS} speakerNames={speakerNames} title="Transcript" />
              </div>
            </div>
          </div>
          <CaptureFoot transcripts={LINES.length} pinned />
        </DemoCard>
      </div>
    </DemoSky>
  )
}
