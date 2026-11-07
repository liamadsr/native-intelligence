/**
 * Read anywhere in a chat or mail app (../read-anywhere-chat): the desktop's
 * text is read by the in-app browser's own chat reader and the sentences go
 * back with the request's run; text that isn't a chat answers [] (the desktop
 * reads it with its own splitter).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ReadSelectionConvertPayload } from '@/lib/tauri-bridge'

const state = vi.hoisted(() => ({
  listener: null as null | ((p: ReadSelectionConvertPayload) => void),
  unsubscribed: 0,
  answers: [] as Array<[number, string[]]>,
  throws: false,
}))

vi.mock('@/lib/tauri-bridge', () => ({
  tauriBridge: {
    onReadSelectionConvert: (cb: (p: ReadSelectionConvertPayload) => void) => {
      state.listener = cb
      return () => {
        state.unsubscribed++
        state.listener = null
      }
    },
    readSelectionSentences: async (run: number, sentences: string[]) => {
      state.answers.push([run, sentences])
    },
  },
}))
vi.mock('../browser-speech', async (real) => {
  const mod = await real<typeof import('../browser-speech')>()
  return {
    ...mod,
    chatSelectionToSentences: (text: string) => {
      if (state.throws) throw new Error('boom')
      return mod.chatSelectionToSentences(text)
    },
  }
})

import { answerReadAnywhereChats } from '../read-anywhere-chat'

const send = (p: ReadSelectionConvertPayload) => state.listener?.(p)

describe('answerReadAnywhereChats', () => {
  beforeEach(() => {
    state.listener = null
    state.unsubscribed = 0
    state.answers = []
    state.throws = false
  })

  it('reads a chat as who said what, by given name, and answers with the run', () => {
    const stop = answerReadAnywhereChats()
    send({
      run: 7,
      app: 'com.microsoft.teams2',
      text: 'Ann LEE (EXT)\n12:33 PM\nSorry all, need to drop.\nBob SMITH\n12:34 PM\nHere is our list of users.',
    })
    expect(state.answers).toHaveLength(1)
    const [run, sentences] = state.answers[0]
    expect(run).toBe(7)
    const spoken = sentences.join(' ')
    expect(spoken).toContain('Ann said')
    expect(spoken).toContain('Bob then said')
    expect(spoken).not.toMatch(/LEE|SMITH|EXT|12:3/)
    stop()
    expect(state.unsubscribed).toBe(1)
  })

  it('answers [] for text that isn’t a chat, so the desktop reads it itself', () => {
    answerReadAnywhereChats()
    send({ run: 1, app: 'com.microsoft.Outlook', text: 'Thanks for the update. Let’s meet Friday.' })
    // From the review of #920: a meeting's title over its time is not a person.
    send({
      run: 2,
      app: 'com.microsoft.Outlook',
      text: 'Weekly Sync (Microsoft Teams)\nMonday, October 20, 2026 10:00 AM\nPlease join on time.',
    })
    send({ run: 3, app: 'com.microsoft.teams2', text: 'Kickoff (Zoom)\n10:00 AM\nAgenda below.' })
    expect(state.answers).toEqual([
      [1, []],
      [2, []],
      [3, []],
    ])
  })

  it('still reads a chat whose names carry a known tag or a capitals surname', () => {
    answerReadAnywhereChats()
    send({ run: 4, app: 'com.microsoft.teams2', text: 'Emily (Guest)\n9:02 AM\nCan you check it?\nJianmin WANG\n9:03 AM\nOn it.' })
    const spoken = state.answers[0][1].join(' ')
    expect(spoken).toContain('Emily said')
    expect(spoken).toContain('Jianmin then said')
  })

  it('answers [] when the reader fails, so the desktop reads the text itself', () => {
    state.throws = true
    answerReadAnywhereChats()
    send({ run: 3, app: 'com.tinyspeck.slackmacgap', text: 'Anything.' })
    expect(state.answers).toEqual([[3, []]])
  })
})
