// The review's scene list (jobs/checks.ts): how each scene reads from its measured numbers, the list as the job
// answers it, and a review of a library video by itself (a reference). Made-up numbers.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isReferenceReview, reviewResult, sceneList, shotOf } from '../src/jobs/checks.ts'

test('review scenes: how a scene reads, first match wins', () => {
  assert.equal(shotOf({ seconds: 4, empty_seconds: 2.5, words_on_screen: 5 }), 'empty')
  assert.equal(shotOf({ seconds: 4, words_on_screen: 3, words_spoken: 9 }), 'text')
  assert.equal(shotOf({ seconds: 4, words_on_screen: 3, alive: 0.9 }), 'motion')
  assert.equal(shotOf({ seconds: 4, words_on_screen: 1, words_spoken: 9 }), 'talk')
  assert.equal(shotOf({ seconds: 4, alive: 0.6 }), 'motion')
  assert.equal(shotOf({ seconds: 4, alive: 0.1 }), 'still')
  assert.equal(shotOf({}), 'still')
})

test('review scenes: the list keeps times, how each reads, what was said and read, never more than it measured', () => {
  const list = sceneList([
    { index: 0, start: 0, end: 4, seconds: 4, enters_by: 'start', alive: 0.05, luma: 0.2, empty_seconds: 0, said: '', words_spoken: 0, on_screen: [], words_on_screen: 0, largest_text: 0, keyframes: ['a.jpg'] },
    { index: 1, start: 4, end: 8.03, seconds: 4.03, enters_by: 'cut', alive: 0.4, luma: 0.5, said: 'Plan the week in one place', words_spoken: 6, on_screen: [{ text: 'Plan less', height: 0.08, frames: 3 }, { text: ' ' }, { text: '=a' }], words_on_screen: 2, largest_text: 0.08 },
  ])
  assert.deepEqual(list, [
    { index: 0, start: 0, end: 4, seconds: 4, shot: 'still', entersBy: 'start', alive: 0.05, luma: 0.2 },
    { index: 1, start: 4, end: 8.03, seconds: 4.03, shot: 'text', entersBy: 'cut', alive: 0.4, luma: 0.5, said: 'Plan the week in one place', words: 6, onScreen: ['Plan less'], wordsOnScreen: 2, textHeight: 0.08 },
  ])
  assert.deepEqual(sceneList(3), [])
  assert.deepEqual(sceneList([{}])[0], { index: 0, start: 0, end: 0, seconds: 0, shot: 'still', entersBy: 'change', alive: 0, luma: 0 })
})

test('review scenes: the answer carries the list and the reference it measured, additively', () => {
  const scenes = sceneList([{ index: 0, start: 0, end: 2, seconds: 2 }])
  const r = reviewResult({ profile: { scenes: 1 }, scenes: 1 }, 'job-1', 0, false, ['review.json'], { sceneList: scenes, reference: { assetId: 'a'.repeat(64), sha256: 'a'.repeat(64) } })
  assert.equal(r.scenes, 1)
  assert.equal(r.sceneList?.length, 1)
  assert.deepEqual(r.reference, { assetId: 'a'.repeat(64), sha256: 'a'.repeat(64) })
  const plain = reviewResult({ scenes: 2 }, 'job-2', 0, true, [])
  assert.equal('sceneList' in plain, false)
  assert.equal('reference' in plain, false)
})

test('review scenes: a library video alone is a reference review; a saved video is not', () => {
  const asset = { id: 'b'.repeat(64), kind: 'video' } as never
  assert.equal(isReferenceReview({ reference: { asset } }), true)
  assert.equal(isReferenceReview({ project: {} as never, digest: 'd', context: { title: '', words: [], layers: [], clicks: [] } }), false)
})
