// @vitest-environment jsdom
/**
 * "Copy transcript" in a capture's window preferences: the saved transcript
 * of a stopped capture, the live one (after any resumed part) of the capture
 * that's recording — read at the click, never another capture's live buffer —
 * as "Name: words" lines; and a word when there's nothing to copy yet.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, type ReactNode } from 'react'
import type { TranscriptSegment } from '@/lib/deepgram-stream'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const env = vi.hoisted(() => ({
  live: [] as TranscriptSegment[],
  copied: [] as string[],
  toasts: [] as string[],
}))
vi.mock('@/lib/clipboard', () => ({
  copyTextToClipboard: async (text: string) => {
    env.copied.push(text)
  },
}))
vi.mock('sonner', () => ({
  toast: Object.assign((m: string) => env.toasts.push(m), { error: (m: string) => env.toasts.push(m) }),
}))
vi.mock('@/hooks/recording-context', () => ({
  useOptionalRecordingStable: () => ({ getTranscriptSegmentsSnapshot: () => env.live }),
}))
vi.mock('@/hooks/use-recording', () => ({
  getSpeakerDisplayName: (speaker: string, names: Record<string, string>) => names[speaker] ?? speaker,
}))
vi.mock('@/components/desktop/speaker-contact-search', () => ({
  SpeakerContactSearch: ({ children }: { children?: ReactNode }) => children,
}))

import { CopyTranscriptButton } from '../copy-transcript-button'

const seg = (id: string, speaker: string, text: string, isFinal = true): TranscriptSegment => ({
  id,
  text,
  stream: 'mic',
  speaker,
  startTime: 0,
  endTime: 0,
  isFinal,
  words: [],
})

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  env.live = []
  env.copied = []
  env.toasts = []
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

const click = async (props: Partial<Parameters<typeof CopyTranscriptButton>[0]>) => {
  await act(async () =>
    root.render(
      h(CopyTranscriptButton, {
        isActiveRecording: false,
        liveIsThisCapture: false,
        resumedPriorTranscript: null,
        persistedTranscript: null,
        speakerNames: { remote_1: 'Sam' },
        ...props,
      }),
    ),
  )
  await act(async () => (container.querySelector('button') as HTMLButtonElement).click())
}

describe('CopyTranscriptButton', () => {
  it("copies a stopped capture's saved transcript", async () => {
    env.live = [seg('x', 'remote_1', 'another capture, still recording')]
    await click({ persistedTranscript: '[remote_1] hello\n[local_1] hi back' })
    expect(env.copied).toEqual(['Sam: hello\nlocal_1: hi back'])
  })

  it('copies the recording capture’s live transcript, after its resumed part, finals only', async () => {
    env.live = [seg('a', 'remote_1', 'we agreed'), seg('b', 'local_1', 'and then', false)]
    await click({ isActiveRecording: true, liveIsThisCapture: true, resumedPriorTranscript: '[local_1] earlier' })
    expect(env.copied).toEqual(['local_1: earlier\nSam: we agreed'])
  })

  it('says so when there is nothing to copy yet', async () => {
    await click({ isActiveRecording: true, liveIsThisCapture: true })
    expect(env.copied).toEqual([])
    expect(env.toasts).toEqual(['No transcript yet'])
  })
})
