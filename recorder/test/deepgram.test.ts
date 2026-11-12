import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DeepgramStream, finalOf, type SocketLike } from '../src/deepgram.ts'
import { deepgramUrl, DEEPGRAM_LIVE_URL } from '../src/config.ts'

/** A socket that records what it was sent and lets the test answer as Deepgram. */
class FakeSocket implements SocketLike {
  readyState = 0
  binaryType = 'blob'
  sent: Array<string | number> = []
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  readonly protocols: string[]
  constructor(protocols: string[]) {
    this.protocols = protocols
  }
  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    this.sent.push(typeof data === 'string' ? data : (data as ArrayBufferView).byteLength)
  }
  close(): void {
    this.readyState = 3
    this.onclose?.({})
  }
  open(): void {
    this.readyState = 1
    this.onopen?.({})
  }
  drop(): void {
    this.readyState = 3
    this.onclose?.({ code: 1006 })
  }
  say(text: string, start: number, end: number): void {
    this.onmessage?.({ data: JSON.stringify({ type: 'Results', is_final: true, start, duration: end - start, channel: { alternatives: [{ transcript: text, words: text ? [{ start, end }] : [] }] } }) })
  }
}

function harness() {
  const sockets: FakeSocket[] = []
  const heard: Array<{ text: string; startWallMs: number; endWallMs: number }> = []
  const stream = new DeepgramStream({
    url: 'wss://deepgram.test/v1/listen',
    key: 'k-test',
    socket: (_url, protocols) => {
      const s = new FakeSocket(protocols)
      sockets.push(s)
      return s
    },
    onHeard: (h) => heard.push(h),
  })
  return { stream, sockets, heard }
}

const frame = () => new Int16Array(160)

test('the key goes as the subprotocol; finals come back with the times they were said', async () => {
  const { stream, sockets, heard } = harness()
  assert.deepEqual(sockets[0].protocols, ['token', 'k-test'])
  sockets[0].open()
  for (let i = 0; i < 100; i++) stream.write(frame(), 10_000 + i * 10, 10) // 1 s from t=10 s
  assert.equal(sockets[0].sent.length, 100)
  sockets[0].say('hello there', 0.2, 0.8)
  assert.deepEqual(heard, [{ text: 'hello there', startWallMs: 10_200, endWallMs: 10_800 }])
  await stream.close(10)
})

test('a dropped socket comes back and is sent again only what it had not heard, at its own times', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const { stream, sockets, heard } = harness()
  sockets[0].open()
  for (let i = 0; i < 200; i++) stream.write(frame(), 1000 + i * 10, 10) // 2 s
  sockets[0].say('first part', 0.1, 0.9) // heard up to t=1900
  sockets[0].drop()
  // While it is down, half a second more is said.
  for (let i = 200; i < 250; i++) stream.write(frame(), 1000 + i * 10, 10)
  t.mock.timers.tick(1000)
  assert.equal(sockets.length, 2, 'opened again')
  sockets[1].open()
  // Everything after t=1900: 1.1 s of the old socket's unheard audio plus the 0.5 s said while down.
  const resent = sockets[1].sent.filter((x) => typeof x === 'number').length
  assert.equal(resent, 160, 'what was not heard is sent again, and nothing that was')
  sockets[1].say('second part', 0.0, 0.4)
  assert.equal(heard[1].text, 'second part')
  assert.equal(heard[1].startWallMs, 1900, 'its time is when it was said, not when it was sent again')
  t.mock.timers.reset()
  await stream.close(10)
})

test('a mute asks for what was heard so far, and KeepAlive holds the socket while nothing is sent', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const { stream, sockets } = harness()
  sockets[0].open()
  stream.write(frame(), Date.now(), 10)
  stream.pause()
  assert.ok(sockets[0].sent.includes(JSON.stringify({ type: 'Finalize' })))
  t.mock.timers.tick(8000)
  assert.ok(sockets[0].sent.filter((x) => x === JSON.stringify({ type: 'KeepAlive' })).length >= 1)
  t.mock.timers.reset()
  await stream.close(10)
})

test('close asks for the last words and waits for them', async () => {
  const { stream, sockets, heard } = harness()
  sockets[0].open()
  for (let i = 0; i < 50; i++) stream.write(frame(), 5000 + i * 10, 10)
  const closing = stream.close(2000)
  assert.ok(sockets[0].sent.includes(JSON.stringify({ type: 'CloseStream' })))
  sockets[0].say('last words', 0.0, 0.3)
  sockets[0].close()
  await closing
  assert.equal(heard.at(-1)?.text, 'last words')
  stream.write(frame(), 9000, 10)
  assert.equal(sockets.length, 1, 'closed for good: no new socket')
})

test('only final results with words are heard; silence still moves what is heard on', () => {
  assert.equal(finalOf('not json'), null)
  assert.equal(finalOf(JSON.stringify({ type: 'Metadata' })), null)
  assert.equal(finalOf(JSON.stringify({ type: 'Results', is_final: false, channel: { alternatives: [{ transcript: 'interim' }] } })), null)
  assert.deepEqual(finalOf(JSON.stringify({ type: 'Results', is_final: true, start: 2, duration: 1.5, channel: { alternatives: [{ transcript: '' }] } })), { text: '', start: 2, end: 3.5 })
  assert.deepEqual(
    finalOf(JSON.stringify({ type: 'Results', is_final: true, start: 2, duration: 3, channel: { alternatives: [{ transcript: ' Hi. ', words: [{ start: 2.4, end: 2.9 }] }] } })),
    { text: 'Hi.', start: 2.4, end: 2.9 },
  )
})

test('the streaming address carries the settings, finals only and no diarization', () => {
  const url = new URL(deepgramUrl(DEEPGRAM_LIVE_URL))
  assert.equal(url.searchParams.get('model'), 'nova-3')
  assert.equal(url.searchParams.get('interim_results'), 'false')
  assert.equal(url.searchParams.get('sample_rate'), '16000')
  assert.equal(url.searchParams.get('endpointing'), '300')
  assert.equal(url.searchParams.get('diarize'), null)
})
