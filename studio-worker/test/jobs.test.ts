import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig, DEV_SECRET } from '../src/config.ts'
import { deepgramParams, stableStringify, toTranscript } from '../src/jobs/transcribe.ts'
import { STUDIO_JOB_KINDS, TranscriptSchema } from '../src/engine.ts'

const asset = { id: 'b'.repeat(64), sha256: 'b'.repeat(64), durationSeconds: 2 }

test('settings: a development secret by default, none in production', () => {
  const dev = loadConfig({}, () => 3)
  assert.ok(!('problems' in dev))
  if (!('problems' in dev)) {
    assert.equal(dev.secret, DEV_SECRET)
    assert.equal(dev.appUrl, 'http://localhost:3000')
    assert.equal(dev.kinds.length, STUDIO_JOB_KINDS.length)
    assert.equal(dev.concurrency, 1)
    assert.equal(dev.pollMs, 2000)
    assert.equal(dev.cacheBytes, 5 * 1024 ** 3)
    assert.equal(dev.renderConcurrency, 2)
    assert.match(dev.engineDir, /web\/src\/lib\/studio\/engine$/)
  }
  assert.deepEqual(loadConfig({ NODE_ENV: 'production' }), { problems: ['STUDIO_WORKER_SECRET is required in production'] })
  assert.ok('problems' in loadConfig({ NODE_ENV: 'production', STUDIO_WORKER_SECRET: DEV_SECRET }))
  const prod = loadConfig({ NODE_ENV: 'production', STUDIO_WORKER_SECRET: 's'.repeat(40), STUDIO_APP_URL: 'http://ni-app-proxy:8080/', STUDIO_WORKER_KINDS: 'export, stills,export', STUDIO_CACHE_BYTES: '1000' })
  assert.ok(!('problems' in prod))
  if (!('problems' in prod)) {
    assert.equal(prod.appUrl, 'http://ni-app-proxy:8080')
    assert.deepEqual(prod.kinds, ['export', 'stills'])
    assert.equal(prod.cacheBytes, 1000)
  }
  assert.ok('problems' in loadConfig({ STUDIO_WORKER_KINDS: 'export,render' }))
  assert.ok('problems' in loadConfig({ STUDIO_APP_URL: 'localhost:3000' }))
})

test('canonical JSON sorts keys and leaves out nothing but undefined', () => {
  assert.equal(stableStringify({ b: 1, a: [{ d: 2, c: null }], u: undefined }), '{"a":[{"c":null,"d":2}],"b":1}')
  assert.equal(stableStringify('x'), '"x"')
})

test('Deepgram is asked for nova-3 with smart formatting, and a language when one is given', () => {
  assert.deepEqual(deepgramParams(), { model: 'nova-3', smart_format: 'true', punctuate: 'true', detect_language: 'true' })
  assert.deepEqual(deepgramParams('de'), { model: 'nova-3', smart_format: 'true', punctuate: 'true', language: 'de' })
})

test('an answer becomes the engine’s transcript: ordered, clamped, ids stable', () => {
  const answer = {
    results: {
      channels: [
        {
          alternatives: [
            {
              transcript: 'Hi there. Bye.',
              words: [
                { word: 'hi', punctuated_word: 'Hi', start: 0.1, end: 0.3 },
                { word: 'there', punctuated_word: 'there.', start: 0.05, end: 0.6 }, // starts before the last: raised
                { word: '', start: 0.7, end: 0.8 }, // no text: dropped
                { word: 'bye', punctuated_word: 'Bye.', start: 1.9, end: 2.4 }, // ends past the source: clamped
              ],
            },
          ],
        },
      ],
    },
  }
  const t = toTranscript(answer, asset, 'req')!
  assert.ok(TranscriptSchema.safeParse(t).success)
  assert.deepEqual(t.words.map((w) => [w.text, w.startMs, w.endMs]), [['Hi', 100, 300], ['there.', 100, 600], ['Bye.', 1900, 2000]])
  assert.equal(t.text, 'Hi there. Bye.')
  assert.equal(t.origin, 'imported')
  assert.equal(t.label, 'Transcript')
  assert.equal(t.assetId, asset.id)
  assert.equal(new Set(t.words.map((w) => w.id)).size, 3)
  assert.deepEqual(toTranscript(answer, asset, 'req'), t, 'the same answer gives the same transcript')
  assert.notEqual(toTranscript(answer, asset, 'other')!.id, t.id, 'another request, another id')
  assert.equal(toTranscript({ results: { channels: [{ alternatives: [{ transcript: '', words: [] }] }] } }, asset, 'req'), null)
  assert.equal(toTranscript({}, asset, 'req'), null)
})
