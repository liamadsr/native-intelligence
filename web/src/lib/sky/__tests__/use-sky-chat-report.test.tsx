// @vitest-environment jsdom
/**
 * useSkyChatReport against the app's one activity store: only the active
 * panel's chat counts, an inactive one withdraws its report, and unmounting
 * releases everything it held.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement as h, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { skyActivity } from '../sky-activity'
import { useSkyChatReport } from '../use-sky-chat-report'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Report = Parameters<typeof useSkyChatReport>[0]

function Panel(props: Report) {
  useSkyChatReport(props)
  return null
}

const idle: Report = { active: true, streaming: false, fullScreen: false, empty: false }

let root: Root
const render = (...panels: Report[]) =>
  act(() => root.render(h(Fragment, null, ...panels.map((p, i) => h(Panel, { key: i, ...p })))))

describe('useSkyChatReport', () => {
  beforeEach(() => {
    root = createRoot(document.createElement('div'))
  })
  afterEach(() => {
    act(() => root.unmount())
  })

  it('holds the sky while the active panel streams or is full screen', () => {
    render({ ...idle, streaming: true })
    expect(skyActivity.holds().some((k) => k.startsWith('stream'))).toBe(true)
    render({ ...idle, fullScreen: true })
    expect(skyActivity.holds().some((k) => k.startsWith('stream'))).toBe(false)
    expect(skyActivity.holds().some((k) => k.startsWith('full'))).toBe(true)
  })

  it('an inactive panel withdraws its report', () => {
    render({ ...idle, streaming: true, fullScreen: true, empty: true })
    expect(skyActivity.holds()).toHaveLength(2)
    expect(skyActivity.isChatEmpty()).toBe(true)
    render({ ...idle, active: false, streaming: true, fullScreen: true, empty: true })
    expect(skyActivity.holds()).toEqual([])
    expect(skyActivity.isChatEmpty()).toBe(false)
  })

  it('unmounting releases the stream and full-screen holds and the empty report', () => {
    render({ ...idle, streaming: true, fullScreen: true, empty: true })
    expect(skyActivity.holds()).toHaveLength(2)
    act(() => root.unmount())
    expect(skyActivity.holds()).toEqual([])
    expect(skyActivity.isChatEmpty()).toBe(false)
    root = createRoot(document.createElement('div'))
  })

  it('with two panels mounted, only the active one counts', () => {
    // The active chat is empty; a hidden tab's chat has messages and is streaming.
    render({ ...idle, empty: true }, { ...idle, active: false, empty: false, streaming: true })
    expect(skyActivity.isChatEmpty()).toBe(true)
    expect(skyActivity.holds()).toEqual([])

    // Switch tabs: the other one is now active, the first withdraws.
    render({ ...idle, active: false, empty: true }, { ...idle, empty: false, streaming: true })
    expect(skyActivity.isChatEmpty()).toBe(false)
    expect(skyActivity.holds()).toHaveLength(1)
  })
})
