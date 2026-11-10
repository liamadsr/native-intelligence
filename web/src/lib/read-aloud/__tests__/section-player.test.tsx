// @vitest-environment jsdom
/**
 * The section player (../section-player), with the desktop bridge mocked.
 *
 * Contract pinned here:
 *  - unsupported: playSection does nothing and never touches the bridge;
 *  - a run clears the desktop queue first, then sends one tts_speak per
 *    sentence, in order, with the chosen voice and ids
 *    `section:${pageLoadId}:${n}`; playingKey clears when the last is `done`;
 *  - pause (../resume-points): cancels and keeps the sentence speaking (or the
 *    first not yet done); playing the key again resumes there after a leading
 *    cancel, clamped to the sentences it has now; a run read to its end keeps
 *    no point; starting another key, or another reader taking the desktop,
 *    pauses the run;
 *  - true stops keep no point: stop (cancelling again behind a speak still in
 *    flight), supported → false, pagehide, an error or a refused speak (with a
 *    cancel); someone else's `cancelled` (another window reading) is a pause,
 *    keeping the place, with no cancel of ours;
 *  - a key read to its end is `wasReadToTheEnd` until it plays again;
 *    `text_too_long` only skips a sentence;
 *  - one desktop queue (../reader): a chat read claiming the desktop pauses
 *    the section silently, and a section starting pauses a chat read;
 *  - a feed (a Listen brief still being written): takes over at once, speaks
 *    each batch as it arrives, stays playing between batches, and ends once it
 *    has ended and its last sentence is done; the run being over aborts its
 *    signal; a pause between batches keeps the next sentence's place, and a
 *    resumed feed skips to it (or says its last sentence, if it ends first);
 *    a feed that throws reads what it gave; the engine warms while the first
 *    sentence is written;
 *  - prepare: at most once per 20 s, only where supported;
 *  - Interactive mode: the sentence being read (getSectionPlayingSentence),
 *    and each sentence noted as it starts speaking, by the section player and
 *    the chat's read-aloud alike, for the echo guard (../recent-speech).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { UIMessage } from '@ai-sdk/react'
import type { LocalModuleInfo, TtsStatePayload } from '@/lib/tauri-bridge'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const bridge = vi.hoisted(() => ({
  desktop: true,
  info: null as LocalModuleInfo | null,
  calls: [] as Array<[string, unknown?]>,
  speakImpl: null as null | ((args: { id: string; text: string; voice?: string }) => Promise<void>),
  listeners: new Set<(p: TtsStatePayload) => void>(),
}))

vi.mock('@/lib/platform', () => ({ isDesktopApp: () => bridge.desktop }))
vi.mock('@/hooks/use-local-module', () => ({
  useLocalModule: () => ({
    loaded: true,
    supported: bridge.info !== null,
    info: bridge.info,
    state: bridge.info?.state ?? null,
    progress: null,
    enabled: bridge.info?.enabled ?? false,
    busy: false,
    error: null,
    enable: async () => {},
    disable: async () => {},
    removeAssets: async () => {},
  }),
}))
vi.mock('@/lib/tauri-bridge', () => ({
  tauriBridge: {
    ttsSpeak: async (args: { id: string; text: string; voice?: string }) => {
      bridge.calls.push(['speak', args])
      if (bridge.speakImpl) await bridge.speakImpl(args)
    },
    ttsCancel: async () => {
      bridge.calls.push(['cancel'])
    },
    ttsPrepare: async () => {
      bridge.calls.push(['prepare'])
    },
    onTtsState: (cb: (p: TtsStatePayload) => void) => {
      bridge.listeners.add(cb)
      return () => bridge.listeners.delete(cb)
    },
  },
}))

import {
  __resetSectionPlayerForTests,
  getSectionPlayerSnapshot,
  getSectionPlayingSentence,
  pauseSection,
  pauseSectionIfKeyStartsWith,
  playSection,
  prepareSectionPlayer,
  setSectionPlayerSupported,
  stopSection,
  useSectionPlayer,
  useSectionPlayerSupported,
  wasReadToTheEnd,
  type SectionPlayerState,
  type SentenceFeed,
} from '../section-player'
import { claimReader, releaseReader } from '../reader'
import { __resetResumePointsForTests, getLastPausedKey, getResumePoint } from '../resume-points'
import { __resetRecentSpeechForTests, recentSpeech } from '../recent-speech'
import { useReadAloud, type ReadAloudHandle } from '@/hooks/use-read-aloud'

const READY: LocalModuleInfo = {
  id: 'local-tts',
  version: 'e801e7d',
  enabled: true,
  state: 'ready',
  progress: null,
  downloadBytes: 144_200_000,
  assetsPresent: true,
  error: null,
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  })
}

async function emit(p: TtsStatePayload) {
  await act(async () => {
    for (const cb of [...bridge.listeners]) cb(p)
  })
  await flush()
}

const speaks = () =>
  bridge.calls.filter((c) => c[0] === 'speak').map((c) => c[1] as { id: string; text: string; voice?: string })
/** The calls in order: 'cancel', 'prepare', or a spoken sentence's text. */
const said = () => bridge.calls.map((c) => (c[0] === 'speak' ? (c[1] as { text: string }).text : c[0]))
const playing = () => getSectionPlayerSnapshot().playingKey
/** said(), less the engine warming. */
const heard = () => said().filter((c) => c !== 'prepare')

async function play(key = 'md:a', sentences: string[] | SentenceFeed = ['One.', 'Two.', 'Three.']) {
  await act(async () => playSection(key, sentences))
  await flush()
}

beforeEach(() => {
  __resetSectionPlayerForTests()
  __resetResumePointsForTests()
  __resetRecentSpeechForTests()
  bridge.desktop = true
  bridge.info = READY
  bridge.calls = []
  bridge.speakImpl = null
  bridge.listeners.clear()
  localStorage.clear()
  setSectionPlayerSupported(true)
})

afterEach(() => {
  __resetSectionPlayerForTests()
  __resetResumePointsForTests()
})

describe('section player — supported', () => {
  it('does nothing, and never touches the bridge, while unsupported', async () => {
    setSectionPlayerSupported(false)
    bridge.calls = []
    await play()
    prepareSectionPlayer()
    stopSection()
    await flush()
    expect(bridge.calls).toEqual([])
    expect(bridge.listeners.size).toBe(0)
    expect(playing()).toBeNull()
  })

  it('does nothing with nothing to say', async () => {
    await play('md:a', [])
    expect(bridge.calls).toEqual([])
    expect(playing()).toBeNull()
  })

  it('turning unsupported mid-run stops it, cancelling the desktop and keeping no place', async () => {
    await play()
    bridge.calls = []
    await act(async () => setSectionPlayerSupported(false))
    expect(playing()).toBeNull()
    expect(bridge.calls).toEqual([['cancel']])
    expect(bridge.listeners.size).toBe(0)
    expect(getResumePoint('md:a')).toBeNull()
  })
})

describe('section player — a run', () => {
  it('clears the queue, then sends each sentence in order with ids `section:${pageLoadId}:${n}`', async () => {
    await play('md:a', ['One.', 'Two.', 'Three.'])
    expect(bridge.calls[0]).toEqual(['cancel'])
    expect(speaks().map((s) => s.text)).toEqual(['One.', 'Two.', 'Three.'])
    const ids = speaks().map((s) => s.id)
    expect(ids.every((id) => /^section:[a-z0-9]+:\d+$/.test(id))).toBe(true)
    expect(new Set(ids.map((id) => id.split(':')[1])).size).toBe(1)
    const ns = ids.map((id) => Number(id.split(':')[2]))
    expect(ns).toEqual([ns[0], ns[0] + 1, ns[0] + 2])
    expect(playing()).toBe('md:a')
  })

  it('passes the chosen voice', async () => {
    localStorage.setItem('ni:read-aloud:voice', 'cosette')
    await play()
    expect(speaks().every((s) => s.voice === 'cosette')).toBe(true)
  })

  it('stays playing until the LAST sentence is done, then lets go of the desktop', async () => {
    await play()
    const [s1, s2, s3] = speaks()
    await emit({ id: s1.id, state: 'speaking' })
    await emit({ id: s1.id, state: 'done' })
    await emit({ id: s2.id, state: 'done' })
    expect(playing()).toBe('md:a')
    await emit({ id: s3.id, state: 'done' })
    expect(playing()).toBeNull()
    expect(bridge.listeners.size).toBe(0)
    expect(bridge.calls.filter((c) => c[0] === 'cancel')).toHaveLength(1) // only the leading one
  })

  it('ignores state events for ids it did not send', async () => {
    await play()
    await emit({ id: 'other:1', state: 'cancelled' })
    await emit({ id: 'section:zz:0', state: 'done' })
    expect(playing()).toBe('md:a')
  })

  it('playing another section replaces the first, which keeps its place: cleared again, the old sentences go no further', async () => {
    let release!: () => void
    bridge.speakImpl = () => new Promise<void>((resolve) => (release = resolve))
    await play('md:a', ['A1.', 'A2.'])
    expect(speaks().map((s) => s.text)).toEqual(['A1.']) // A1 in flight
    bridge.speakImpl = null
    await act(async () => playSection('md:b', ['B1.']))
    await act(async () => release())
    await flush()
    expect(said()).toEqual(['cancel', 'A1.', 'cancel', 'B1.'])
    expect(playing()).toBe('md:b')
    // Paused, not thrown away: A1 was never done.
    expect(getResumePoint('md:a')).toBe(0)
    expect(getLastPausedKey()).toBe('md:a')
  })
})

describe('section player — pause and resume', () => {
  it('pause cancels and keeps the sentence speaking; playing the key again resumes there after a leading cancel', async () => {
    await play('doc:1')
    const [s1, s2] = speaks()
    await emit({ id: s1.id, state: 'speaking' })
    await emit({ id: s1.id, state: 'done' })
    await emit({ id: s2.id, state: 'speaking' })
    bridge.calls = []
    await act(async () => pauseSection('doc:1'))
    expect(bridge.calls).toEqual([['cancel']])
    expect(playing()).toBeNull()
    expect(bridge.listeners.size).toBe(0)
    expect(getResumePoint('doc:1')).toBe(1)
    expect(getLastPausedKey()).toBe('doc:1')

    bridge.calls = []
    await play('doc:1')
    expect(said()).toEqual(['cancel', 'Two.', 'Three.'])
    expect(playing()).toBe('doc:1')
    // The run carries its place now: the store forgets it.
    expect(getResumePoint('doc:1')).toBeNull()
    expect(getLastPausedKey()).toBeNull()
  })

  it('the sentence speaking counts even when the one before never said done', async () => {
    await play('doc:1')
    await emit({ id: speaks()[1].id, state: 'speaking' })
    await act(async () => pauseSection())
    expect(getResumePoint('doc:1')).toBe(1)
  })

  it('paused before anything was said, it resumes from the first sentence', async () => {
    await play('doc:1')
    await act(async () => pauseSection('doc:1'))
    expect(getResumePoint('doc:1')).toBe(0)
    bridge.calls = []
    await play('doc:1')
    expect(said()).toEqual(['cancel', 'One.', 'Two.', 'Three.'])
  })

  it('resuming works the sentences out again, clamped to the last one when the content shrank', async () => {
    await play('doc:1')
    await emit({ id: speaks()[2].id, state: 'speaking' })
    await act(async () => pauseSection('doc:1'))
    expect(getResumePoint('doc:1')).toBe(2)
    bridge.calls = []
    await play('doc:1', ['One, rewritten.', 'Two, rewritten.'])
    expect(said()).toEqual(['cancel', 'Two, rewritten.'])
  })

  it('a run read to its end keeps no point: the next play starts from the top', async () => {
    await play('doc:1')
    await emit({ id: speaks()[1].id, state: 'speaking' })
    await act(async () => pauseSection('doc:1'))
    bridge.calls = []
    await play('doc:1')
    for (const s of speaks()) await emit({ id: s.id, state: 'done' })
    expect(playing()).toBeNull()
    expect(getResumePoint('doc:1')).toBeNull()
    bridge.calls = []
    await play('doc:1')
    expect(said()).toEqual(['cancel', 'One.', 'Two.', 'Three.'])
  })

  it('playing the key that plays picks up at its current sentence', async () => {
    await play('doc:1')
    await emit({ id: speaks()[1].id, state: 'speaking' })
    bridge.calls = []
    await play('doc:1')
    expect(said()).toEqual(['cancel', 'Two.', 'Three.'])
  })

  it('pause only touches its own key, and does nothing when nothing plays', async () => {
    await play('doc:1')
    bridge.calls = []
    pauseSection('doc:2')
    await flush()
    expect(playing()).toBe('doc:1')
    await act(async () => pauseSection('doc:1'))
    bridge.calls = []
    pauseSection()
    await flush()
    expect(bridge.calls).toEqual([])
    expect(getResumePoint('doc:1')).toBe(0)
  })

  it('true stops keep no place: stop, an error, pagehide', async () => {
    await play('doc:1')
    await act(async () => stopSection())
    expect(getResumePoint('doc:1')).toBeNull()

    bridge.calls = []
    await play('doc:1')
    await emit({ id: speaks()[0].id, state: 'error', error: 'device lost' })
    expect(playing()).toBeNull()
    expect(getResumePoint('doc:1')).toBeNull()

    await play('doc:1')
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'))
    })
    expect(playing()).toBeNull()
    expect(getResumePoint('doc:1')).toBeNull()
    expect(getLastPausedKey()).toBeNull()
  })
})

/** A feed the test hands batches to, one at a time. */
function controlledFeed() {
  const queue: Array<readonly string[] | Error | null> = []
  let wake: (() => void) | null = null
  const opened: AbortSignal[] = []
  const feed: SentenceFeed = (signal) => {
    opened.push(signal)
    return (async function* () {
      for (;;) {
        while (queue.length === 0) await new Promise<void>((resolve) => (wake = resolve))
        const item = queue.shift()!
        if (item === null) return
        if (item instanceof Error) throw item
        yield item
      }
    })()
  }
  const put = async (item: readonly string[] | Error | null) => {
    queue.push(item)
    wake?.()
    wake = null
    await flush()
  }
  return {
    feed,
    opened,
    give: (...sentences: string[]) => put(sentences),
    end: () => put(null),
    fail: () => put(new Error('network')),
  }
}

describe('section player — a feed', () => {
  it('takes over at once, speaks each batch as it arrives, and stays playing until it has ended and its last is done', async () => {
    const f = controlledFeed()
    await play('brief:capture:1', f.feed)
    expect(heard()).toEqual(['cancel'])
    expect(playing()).toBe('brief:capture:1')
    // Its first sentence is still being written: the engine warms meanwhile.
    expect(said().filter((c) => c === 'prepare')).toHaveLength(1)

    await f.give('One.')
    expect(heard()).toEqual(['cancel', 'One.'])
    await emit({ id: speaks()[0].id, state: 'done' })
    // All it gave is done, more is coming: still playing.
    expect(playing()).toBe('brief:capture:1')

    await f.give('Two.', 'Three.')
    expect(heard()).toEqual(['cancel', 'One.', 'Two.', 'Three.'])
    await emit({ id: speaks()[1].id, state: 'done' })
    await f.end()
    expect(playing()).toBe('brief:capture:1')
    await emit({ id: speaks()[2].id, state: 'done' })
    expect(playing()).toBeNull()
    expect(bridge.listeners.size).toBe(0)
  })

  it('an empty feed ends with nothing said; unsupported, the feed is never opened', async () => {
    const f = controlledFeed()
    await play('brief:capture:1', f.feed)
    await f.end()
    expect(heard()).toEqual(['cancel'])
    expect(playing()).toBeNull()

    setSectionPlayerSupported(false)
    const g = controlledFeed()
    bridge.calls = []
    await play('brief:capture:2', g.feed)
    expect(g.opened).toHaveLength(0)
    expect(bridge.calls).toEqual([])
  })

  it('the run being over aborts the feed, and what it gives after that is dropped', async () => {
    const f = controlledFeed()
    await play('brief:capture:1', f.feed)
    await f.give('One.')
    await act(async () => stopSection())
    expect(f.opened[0].aborted).toBe(true)
    bridge.calls = []
    await f.give('Two.') // a feed that ignores its signal
    expect(bridge.calls).toEqual([])

    const g = controlledFeed()
    await play('brief:capture:2', g.feed)
    await play('doc:1') // another key takes over
    expect(g.opened[0].aborted).toBe(true)
  })

  it('a pause between batches keeps the next sentence; the resumed feed skips to it', async () => {
    const f = controlledFeed()
    await play('brief:contact:1', f.feed)
    await f.give('One.', 'Two.')
    for (const s of speaks()) await emit({ id: s.id, state: 'done' })
    await act(async () => pauseSection('brief:contact:1'))
    expect(f.opened[0].aborted).toBe(true)
    expect(getResumePoint('brief:contact:1')).toBe(2)

    const g = controlledFeed()
    bridge.calls = []
    await play('brief:contact:1', g.feed)
    await g.give('One.', 'Two.')
    await g.give('Three.')
    expect(heard()).toEqual(['cancel', 'Three.'])
  })

  it('paused mid-sentence it resumes at that sentence; a feed ending before the place says its last', async () => {
    const f = controlledFeed()
    await play('brief:contact:1', f.feed)
    await f.give('One.', 'Two.', 'Three.')
    await emit({ id: speaks()[2].id, state: 'speaking' })
    await act(async () => pauseSection())
    expect(getResumePoint('brief:contact:1')).toBe(2)

    const g = controlledFeed()
    bridge.calls = []
    await play('brief:contact:1', g.feed)
    await g.give('Uno.')
    await g.give('Dos.')
    expect(heard()).toEqual(['cancel'])
    await g.end()
    expect(heard()).toEqual(['cancel', 'Dos.'])
    await emit({ id: speaks()[0].id, state: 'done' })
    expect(playing()).toBeNull()
  })

  it('a feed that throws reads what it gave, then ends', async () => {
    const f = controlledFeed()
    await play('brief:event:1', f.feed)
    await f.give('One.')
    await f.fail()
    expect(heard()).toEqual(['cancel', 'One.'])
    expect(playing()).toBe('brief:event:1')
    await emit({ id: speaks()[0].id, state: 'done' })
    expect(playing()).toBeNull()
  })
})

describe('section player — another window, and reading to the end', () => {
  it('someone else’s cancel (another Native Intelligence window reading) is a pause: the place is kept, with no cancel of ours', async () => {
    await play('doc:1')
    const [, second, last] = speaks()
    await emit({ id: second.id, state: 'speaking' })
    bridge.calls = []
    await emit({ id: last.id, state: 'cancelled' })
    expect(playing()).toBeNull()
    expect(bridge.calls).toEqual([])
    expect(getResumePoint('doc:1')).toBe(1)
    expect(wasReadToTheEnd('doc:1')).toBe(false)
  })

  it('a key read to its end says so until it plays again; a paused or stopped one never does', async () => {
    await play('doc:1')
    for (const s of speaks()) await emit({ id: s.id, state: 'done' })
    expect(playing()).toBeNull()
    expect(wasReadToTheEnd('doc:1')).toBe(true)

    await play('doc:1')
    expect(wasReadToTheEnd('doc:1')).toBe(false)
    await act(async () => pauseSection('doc:1'))
    expect(wasReadToTheEnd('doc:1')).toBe(false)
    await play('doc:2')
    await act(async () => stopSection())
    expect(wasReadToTheEnd('doc:2')).toBe(false)
  })
})

describe('section player — ends', () => {
  it('stop cancels now and clears', async () => {
    await play()
    bridge.calls = []
    await act(async () => stopSection())
    expect(bridge.calls).toEqual([['cancel']])
    expect(playing()).toBeNull()
    expect(bridge.listeners.size).toBe(0)
  })

  it('stop also cancels behind a speak still in flight', async () => {
    let release!: () => void
    bridge.speakImpl = () => new Promise<void>((resolve) => (release = resolve))
    await play('md:a', ['One.', 'Two.'])
    bridge.calls = []
    await act(async () => stopSection())
    expect(bridge.calls).toEqual([['cancel']])
    await act(async () => release())
    await flush()
    // The in-flight speak may land after the first cancel: a second follows it,
    // and the rest of the section is never sent.
    expect(bridge.calls).toEqual([['cancel'], ['cancel']])
  })

  it('stop(key) and pauseSectionIfKeyStartsWith only touch their own section; nothing plays → no cancel', async () => {
    await play('pm:3:0')
    bridge.calls = []
    stopSection('md:other')
    pauseSectionIfKeyStartsWith('pm:4:')
    await flush()
    expect(playing()).toBe('pm:3:0')
    expect(bridge.calls).toEqual([])
    // An editor going away pauses its section: it keeps its place.
    await act(async () => pauseSectionIfKeyStartsWith('pm:3:'))
    expect(playing()).toBeNull()
    expect(bridge.calls).toEqual([['cancel']])
    expect(getResumePoint('pm:3:0')).toBe(0)
    bridge.calls = []
    stopSection()
    await flush()
    expect(bridge.calls).toEqual([])
  })

  it('a sentence refused as text_too_long is skipped; the run reads on and still finishes', async () => {
    bridge.speakImpl = async ({ text }) => {
      if (text === 'Two.') throw Object.assign(new Error('text_too_long'), { code: 'text_too_long' })
    }
    await play()
    expect(speaks().map((s) => s.text)).toEqual(['One.', 'Two.', 'Three.'])
    const [s1, , s3] = speaks()
    await emit({ id: s1.id, state: 'done' })
    expect(playing()).toBe('md:a')
    await emit({ id: s3.id, state: 'done' })
    expect(playing()).toBeNull()
  })

  it('a sentence the desktop reports as text_too_long is skipped too', async () => {
    await play()
    const [s1, s2, s3] = speaks()
    await emit({ id: s1.id, state: 'done' })
    await emit({ id: s2.id, state: 'error', error: 'text_too_long' })
    expect(playing()).toBe('md:a')
    await emit({ id: s3.id, state: 'done' })
    expect(playing()).toBeNull()
  })

  it('any other refused speak (e.g. recording) ends the run, cancelling', async () => {
    bridge.speakImpl = async () => {
      throw Object.assign(new Error('recording'), { code: 'recording' })
    }
    await play()
    expect(playing()).toBeNull()
    // The leading cancel, the refused first sentence (the rest are dropped),
    // then the ending cancel, plus one chained behind that speak, which still
    // counts as in flight while its refusal is handled (as in useReadAloud).
    expect(bridge.calls.map((c) => c[0])).toEqual(['cancel', 'speak', 'cancel', 'cancel'])
  })

  it('an error ends the run with a cancel; someone else’s cancelled ends it without one', async () => {
    await play()
    const errored = speaks()[0]
    bridge.calls = []
    await emit({ id: errored.id, state: 'error', error: 'device lost' })
    expect(playing()).toBeNull()
    expect(bridge.calls).toEqual([['cancel']])

    bridge.calls = []
    await play()
    const first = speaks()[0]
    bridge.calls = []
    await emit({ id: first.id, state: 'cancelled' })
    expect(playing()).toBeNull()
    expect(bridge.calls).toEqual([])
  })

  it('pagehide stops a run, cancelling; not when nothing is being read', async () => {
    await play()
    const [s1, s2, s3] = speaks()
    bridge.calls = []
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'))
    })
    expect(bridge.calls).toEqual([['cancel']])
    expect(playing()).toBeNull()

    for (const s of [s1, s2, s3]) await emit({ id: s.id, state: 'cancelled' })
    bridge.calls = []
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'))
    })
    expect(bridge.calls).toEqual([])
  })
})

describe('section player — one desktop queue', () => {
  it('another reader claiming the desktop pauses the section silently: it keeps its place', async () => {
    await play()
    await emit({ id: speaks()[1].id, state: 'speaking' })
    bridge.calls = []
    const chat = {}
    const lose = vi.fn()
    claimReader(chat, lose)
    await flush()
    expect(playing()).toBeNull()
    expect(bridge.calls).toEqual([]) // the new reader's own leading cancel covers it
    expect(bridge.listeners.size).toBe(0)
    expect(getResumePoint('md:a')).toBe(1)
    releaseReader(chat)
  })

  it('a section starting ends the other reader’s run', async () => {
    const chat = {}
    const lose = vi.fn()
    claimReader(chat, lose)
    await play()
    expect(lose).toHaveBeenCalledTimes(1)
    expect(playing()).toBe('md:a')
  })

  it('with the real chat read-aloud: a section takes over a reply, and a reply takes over a section, each paused', async () => {
    let chat!: ReadAloudHandle
    const reply = { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Answer one. Answer two.' }] } as unknown as UIMessage
    function Panel() {
      chat = useReadAloud({ messages: [reply], status: 'ready', recording: false })
      return null
    }
    const host = document.createElement('div')
    const root: Root = createRoot(host)
    await act(async () => root.render(h(Panel)))
    await flush()

    await act(async () => chat.speakMessage('a1', 'Answer one. Answer two.'))
    await flush()
    expect(chat.speakingMessageId).toBe('a1')

    await play()
    expect(chat.speakingMessageId).toBeNull()
    expect(playing()).toBe('md:a')
    expect(getResumePoint('a1')).toBe(0)

    bridge.calls = []
    await act(async () => chat.speakMessage('a1', 'Answer one. Answer two.'))
    await flush()
    expect(playing()).toBeNull()
    expect(chat.speakingMessageId).toBe('a1')
    expect(getResumePoint('md:a')).toBe(0)
    // One cancel, the chat's own leading one: the section let go without another.
    expect(bridge.calls.filter((c) => c[0] === 'cancel')).toHaveLength(1)

    await act(async () => root.unmount())
  })
})

describe('section player — Interactive mode', () => {
  it('says which sentence is being read (the one speaking, else the first not yet done), and none once paused', async () => {
    expect(getSectionPlayingSentence()).toBeNull()
    await play('doc:d1', ['One.', 'Two.', 'Three.'])
    expect(getSectionPlayingSentence()).toEqual({ key: 'doc:d1', text: 'One.' })
    const [, s2] = speaks()
    await emit({ id: s2.id, state: 'speaking' })
    expect(getSectionPlayingSentence()).toEqual({ key: 'doc:d1', text: 'Two.' })
    await act(async () => pauseSection())
    expect(getSectionPlayingSentence()).toBeNull()
  })

  it('notes each sentence as it starts speaking (the echo guard), the chat read-aloud too', async () => {
    await play('doc:d1', ['One.', 'Two.'])
    expect(recentSpeech()).toEqual([])
    const [s1, s2] = speaks()
    await emit({ id: s1.id, state: 'speaking' })
    await emit({ id: s2.id, state: 'speaking' })
    expect(recentSpeech()).toEqual(['One.', 'Two.'])

    let chat!: ReadAloudHandle
    const reply = { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'It was Maya.' }] } as unknown as UIMessage
    function Panel() {
      chat = useReadAloud({ messages: [reply], status: 'ready', recording: false })
      return null
    }
    const host = document.createElement('div')
    const root: Root = createRoot(host)
    await act(async () => root.render(h(Panel)))
    await flush()
    bridge.calls = []
    await act(async () => chat.speakMessage('a1', 'It was Maya.'))
    await flush()
    const [r1] = speaks()
    await emit({ id: r1.id, state: 'speaking' })
    expect(recentSpeech()).toEqual(['One.', 'Two.', 'It was Maya.'])
    await act(async () => root.unmount())
  })
})

describe('section player — prepare and the hook', () => {
  it('prepares at most once per 20 s', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-09-27T12:00:00Z'))
      prepareSectionPlayer()
      prepareSectionPlayer()
      vi.setSystemTime(new Date('2026-09-27T12:00:19Z'))
      prepareSectionPlayer()
      expect(bridge.calls).toEqual([['prepare']])
      vi.setSystemTime(new Date('2026-09-27T12:00:21Z'))
      prepareSectionPlayer()
      expect(bridge.calls).toEqual([['prepare'], ['prepare']])
    } finally {
      vi.useRealTimers()
    }
  })

  it('useSectionPlayer follows supported and the playing key', async () => {
    const seen: SectionPlayerState[] = []
    function Probe() {
      seen.push(useSectionPlayer())
      return null
    }
    const host = document.createElement('div')
    const root = createRoot(host)
    await act(async () => root.render(h(Probe)))
    expect(seen.at(-1)).toEqual({ supported: true, playingKey: null })
    await play('md:x')
    expect(seen.at(-1)).toEqual({ supported: true, playingKey: 'md:x' })
    await act(async () => setSectionPlayerSupported(false))
    expect(seen.at(-1)).toEqual({ supported: false, playingKey: null })
    await act(async () => root.unmount())
  })

  it('useSectionPlayerSupported follows supported only, not the playing key', async () => {
    const seen: boolean[] = []
    function Probe() {
      seen.push(useSectionPlayerSupported())
      return null
    }
    const host = document.createElement('div')
    const root = createRoot(host)
    await act(async () => root.render(h(Probe)))
    expect(seen).toEqual([true])
    await play('md:x')
    expect(seen).toEqual([true])
    await act(async () => setSectionPlayerSupported(false))
    expect(seen).toEqual([true, false])
    await act(async () => root.unmount())
  })
})
