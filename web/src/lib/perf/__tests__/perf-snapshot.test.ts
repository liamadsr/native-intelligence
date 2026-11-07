// @vitest-environment jsdom
/**
 * window.__dial8PerfSnapshot(): what the page holds, in counts, with nothing
 * read from what the person wrote (only tags, ids and attribute names).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { describeElement, installPerfSnapshot, takePerfSnapshot, watchPerfChurn } from '../perf-snapshot'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('takePerfSnapshot', () => {
  it('counts the parked pages, inline pages asleep, the thread, the capture panels and what sits on body', () => {
    document.body.innerHTML = `
      <div id="dial8-shell-root">
        <div class="group/msg relative"><p>hello</p></div>
        <div class="group/msg relative"><p>secret words</p><span></span></div>
        <div data-testid="capture-detail" data-capture-id="0b6f7d1e-1111-4222-8333-944455556666"><ul><li></li><li></li></ul></div>
        <div data-chat-card="call_4"><div data-card-header></div><div data-card-dormant="" style="display:none"><div data-card-body-host><p></p></div></div></div>
      </div>
      <div data-card-body-anchor hidden></div>
      <div aria-hidden inert data-card-parked="call_1"><div data-card-body-host><div><span></span></div></div></div>
      <div aria-hidden inert data-card-parked="call_3" data-card-dormant="" style="display:none"><div data-card-body-host><p></p></div></div>
      <div data-chat-card-fullscreen="call_2"></div>
      <script></script>
    `
    const snap = takePerfSnapshot(document, { realtimeTopics: () => ['realtime:capture-stream:a:1', 'realtime:capture-stream:b:2', 'realtime:notifications'] })
    expect(snap.pages).toMatchObject({ cards: 1, parked: 1, parkedElements: 4, dormant: 1, dormantElements: 3, fullScreen: 1, inline: 1, inlineAsleep: 1, inlineAsleepElements: 3 })
    expect(snap.chat).toEqual({ messages: 2, elements: 5 })
    expect(snap.capturePanels).toEqual({ count: 1, elements: 4 })
    expect(snap.hiddenElements).toBe(7)
    expect(snap.realtime).toEqual({ channels: 3, topics: [['capture-stream', 2], ['notifications', 1]] })
    // Scripts hold no layout: not listed.
    expect(snap.body.map((b) => b.label)).toEqual([
      'div#dial8-shell-root',
      'div[data-card-body-anchor]',
      'div[data-card-parked=call_1]',
      'div[data-card-parked=call_3]',
      'div[data-chat-card-fullscreen=call_2]',
    ])
    expect(snap.elements).toBe(document.getElementsByTagName('*').length)
    // Nothing the person wrote.
    expect(JSON.stringify(snap)).not.toContain('secret')
  })

  it('names the widest lists, with the landmark they sit in', () => {
    const rows = Array.from({ length: 30 }, () => '<li></li>').join('')
    document.body.innerHTML = `<section data-transcript-list><div><ul class="space-y-1 text-sm">${rows}</ul></div></section>`
    const snap = takePerfSnapshot(document)
    expect(snap.widest[0]).toEqual({ label: 'ul.space-y-1', children: 30, within: 'section[data-transcript-list]' })
  })

  it('names an element without its UUIDs or long values', () => {
    const el = document.createElement('div')
    el.setAttribute('data-capture-id', '0b6f7d1e-1111-4222-8333-944455556666')
    el.className = 'flex h-full'
    expect(describeElement(el)).toBe('div[data-capture-id=<id>].flex')
    el.setAttribute('data-capture-id', 'x'.repeat(40))
    expect(describeElement(el)).toBe(`div[data-capture-id=${'x'.repeat(21)}…].flex`)
  })

  it('reports no realtime when the client is missing or throws', () => {
    expect(takePerfSnapshot(document).realtime).toBeNull()
    expect(
      takePerfSnapshot(document, {
        realtimeTopics: () => {
          throw new Error('no client')
        },
      }).realtime,
    ).toBeNull()
  })
})

describe('watchPerfChurn', () => {
  it('counts what is written while it watches: stylesheets, <html>, the busiest elements', async () => {
    document.body.innerHTML = '<section id="thread"><div class="row"><span></span></div></section>'
    const row = document.querySelector('.row') as HTMLElement
    const thread = document.getElementById('thread')!
    const watching = watchPerfChurn(document, 50)
    for (let i = 0; i < 5; i++) row.style.width = `${i}px`
    thread.append(document.createElement('div'))
    const style = document.createElement('style')
    document.head.append(style)
    style.remove()
    document.documentElement.setAttribute('data-sky-tone', 'dark')
    const churn = await watching
    expect(churn.styleSheetChanges).toBe(2)
    expect(churn.root).toEqual([['html@data-sky-tone', 1]])
    expect(churn.topAttributes[0]).toEqual({ label: 'style@div.row', writes: 5, subtree: 2 })
    expect(churn.topChildLists.map((c) => c.label)).toContain('section#thread')
    // Stopped: nothing more is counted.
    row.style.width = '9px'
    expect((await watchPerfChurn(document, 10)).mutations.attributes).toBe(0)
    document.documentElement.removeAttribute('data-sky-tone')
  })
})

describe('installPerfSnapshot', () => {
  it('puts the snapshot and the churn reader on window and takes them away again', () => {
    const remove = installPerfSnapshot()
    expect(typeof window.__dial8PerfSnapshot).toBe('function')
    expect(typeof window.__dial8PerfChurn).toBe('function')
    expect(window.__dial8PerfSnapshot!().elements).toBeGreaterThan(0)
    remove()
    expect(window.__dial8PerfSnapshot).toBeUndefined()
    expect(window.__dial8PerfChurn).toBeUndefined()
  })
})
