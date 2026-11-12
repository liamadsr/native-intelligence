import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AudioClock } from '../src/clock.ts'
import { backoffMs } from '../src/backoff.ts'

test('audio times map to when they were heard, across a stretch nothing was sent (a mute)', () => {
  const c = new AudioClock()
  // 3 s of audio from t=1000 in 10 ms frames, then a 60 s mute, then 2 s more.
  for (let i = 0; i < 300; i++) c.sent(1000 + i * 10, 10)
  for (let i = 0; i < 200; i++) c.sent(64_000 + i * 10, 10)
  assert.equal(c.size, 2, 'contiguous frames are one stretch')
  assert.equal(c.audioMs, 5000)
  assert.equal(c.wallAt(0), 1000)
  assert.equal(c.wallAt(1500), 2500)
  // Audio second 3.5 is half a second into the second stretch, a minute later in the call.
  assert.equal(c.wallAt(3500), 64_500)
})

test('frames a little late still run on; a gap starts a new stretch', () => {
  const c = new AudioClock()
  c.sent(0, 10)
  c.sent(25, 10) // 15 ms late: the same stretch
  c.sent(500, 10) // a gap
  assert.equal(c.size, 2)
  assert.equal(c.wallAt(15), 15)
  assert.equal(c.wallAt(25), 505)
})

test('nothing sent: no time; forgetting keeps the stretch a later time falls in', () => {
  const c = new AudioClock()
  assert.equal(c.wallAt(0), null)
  c.sent(0, 1000)
  c.sent(5000, 1000)
  c.sent(9000, 1000)
  c.forgetBefore(1500)
  assert.equal(c.size, 2)
  assert.equal(c.wallAt(1500), 5500)
  assert.equal(c.wallAt(2500), 9500)
})

test('backoff doubles up to its cap, with no more than a quarter of jitter', () => {
  const o = { baseMs: 500, maxMs: 10_000 }
  assert.equal(backoffMs(0, o, () => 1), 500)
  assert.equal(backoffMs(1, o, () => 1), 1000)
  assert.equal(backoffMs(3, o, () => 1), 4000)
  assert.equal(backoffMs(50, o, () => 1), 10_000)
  assert.equal(backoffMs(3, o, () => 0), 3000)
})
