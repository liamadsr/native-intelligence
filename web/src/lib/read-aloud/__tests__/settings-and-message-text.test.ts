// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import {
  READ_ALOUD_AUTO_KEY,
  READ_ALOUD_VOICE_KEY,
  getReadAloudAuto,
  getReadAloudVoice,
  setReadAloudAuto,
  setReadAloudVoice,
} from '../settings'
import { messageSpeechMarkdown } from '../message-text'

describe('read-aloud settings (device-local)', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => vi.restoreAllMocks())

  it('defaults: auto off, default voice', () => {
    expect(getReadAloudAuto()).toBe(false)
    expect(getReadAloudVoice()).toBeNull()
  })

  it('stores only non-defaults, and tiny values', () => {
    setReadAloudAuto(true)
    setReadAloudVoice('marius')
    expect(localStorage.getItem(READ_ALOUD_AUTO_KEY)).toBe('1')
    expect(localStorage.getItem(READ_ALOUD_VOICE_KEY)).toBe('marius')
    expect(getReadAloudAuto()).toBe(true)
    expect(getReadAloudVoice()).toBe('marius')

    setReadAloudAuto(false)
    setReadAloudVoice(null)
    expect(localStorage.getItem(READ_ALOUD_AUTO_KEY)).toBeNull()
    expect(localStorage.getItem(READ_ALOUD_VOICE_KEY)).toBeNull()
  })

  it('ignores an oversized voice id', () => {
    setReadAloudVoice('x'.repeat(65))
    expect(localStorage.getItem(READ_ALOUD_VOICE_KEY)).toBeNull()
    localStorage.setItem(READ_ALOUD_VOICE_KEY, 'y'.repeat(65))
    expect(getReadAloudVoice()).toBeNull()
  })

  it('storage that throws (full, private mode) reads as defaults and never throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    expect(() => setReadAloudAuto(true)).not.toThrow()
    expect(() => setReadAloudVoice('alba')).not.toThrow()
    expect(getReadAloudAuto()).toBe(false)
    expect(getReadAloudVoice()).toBeNull()
  })
})

describe('messageSpeechMarkdown', () => {
  const msg = (parts: unknown[]) => ({ parts }) as { parts: Array<{ type: string; text?: unknown; state?: unknown }> }

  it('joins text parts as separate blocks and skips reasoning, tools and files', () => {
    const m = msg([
      { type: 'reasoning', text: 'Thinking about it.' },
      { type: 'text', text: 'Let me check.', state: 'done' },
      { type: 'tool-search', toolCallId: 'c1', state: 'output-available' },
      { type: 'file', mediaType: 'image/png', url: 'x' },
      { type: 'text', text: 'Found it', state: 'streaming' },
    ])
    expect(messageSpeechMarkdown(m)).toBe('Let me check.\n\nFound it')
  })

  it('closes a finished text part so its last sentence can be read straight away', () => {
    expect(messageSpeechMarkdown(msg([{ type: 'text', text: 'Done.', state: 'done' }]))).toBe('Done.\n\n')
    expect(messageSpeechMarkdown(msg([{ type: 'text', text: 'Checking.' }, { type: 'tool-x', state: 'input-available' }]))).toBe(
      'Checking.\n\n',
    )
    expect(messageSpeechMarkdown(msg([{ type: 'text', text: 'Still going', state: 'streaming' }]))).toBe('Still going')
  })

  it('only grows by appending as the message streams', () => {
    const steps = [
      msg([{ type: 'text', text: 'Checking', state: 'streaming' }]),
      msg([{ type: 'text', text: 'Checking now.', state: 'streaming' }]),
      msg([{ type: 'text', text: 'Checking now.', state: 'done' }]),
      msg([{ type: 'text', text: 'Checking now.', state: 'done' }, { type: 'tool-x', state: 'input-streaming' }]),
      msg([{ type: 'text', text: 'Checking now.', state: 'done' }, { type: 'tool-x', state: 'output-available' }, { type: 'text', text: '', state: 'streaming' }]),
      msg([{ type: 'text', text: 'Checking now.', state: 'done' }, { type: 'tool-x', state: 'output-available' }, { type: 'text', text: 'All good.', state: 'streaming' }]),
    ]
    const texts = steps.map((m) => messageSpeechMarkdown(m))
    for (let i = 1; i < texts.length; i++) expect(texts[i].startsWith(texts[i - 1])).toBe(true)
  })

  it('fromPart skips what was already there', () => {
    const m = msg([
      { type: 'text', text: 'Which account?', state: 'done' },
      { type: 'tool-ask_user', state: 'output-available' },
      { type: 'text', text: 'Acme it is.', state: 'done' },
    ])
    expect(messageSpeechMarkdown(m, 2)).toBe('Acme it is.\n\n')
    expect(messageSpeechMarkdown(m, 3)).toBe('')
  })
})
