// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { VOICE_ASK_LIMITS, parseVoiceAsk, parseVoiceAskSnapshot, snapshotFromListenKey } from '../voice-ask'
import { VOICE_ASK_EVENT, deliverVoiceAsk, isVoiceAskDelivery, type VoiceAskDelivery } from '../voice-ask-delivery'

/**
 * A spoken ask's systemContext (../voice-ask): the snapshot of what the user
 * was listening to, made from the Listen item's key, bounded for a request
 * header; and its trip to the chat panel (../voice-ask-delivery).
 */

describe('snapshotFromListenKey', () => {
  it('a document, by id, with the sentence being read', () => {
    expect(snapshotFromListenKey('doc:3f1c', null, 'It is due Friday.')).toEqual({
      kind: 'document',
      id: '3f1c',
      readingAt: 'It is due Friday.',
    })
  })

  it('an email thread, by its thread id (not the latest message)', () => {
    expect(snapshotFromListenKey('email-thread:1929fa3c5b7e0d12:1929fb00aa11bb22')).toEqual({
      kind: 'email-thread',
      id: '1929fa3c5b7e0d12',
    })
  })

  it('a brief, by its subject’s kind and id (an id with colons too)', () => {
    expect(snapshotFromListenKey('brief:capture:cap-1')).toEqual({ kind: 'capture', id: 'cap-1' })
    expect(snapshotFromListenKey('brief:event:google:abc123', null, 'At 3 pm.')).toEqual({
      kind: 'event',
      id: 'google:abc123',
      readingAt: 'At 3 pm.',
    })
    expect(snapshotFromListenKey('brief:spreadsheet:1')).toBeNull()
  })

  it('a key it does not know (a browser key too: the in-app browser is gone): null', () => {
    expect(snapshotFromListenKey('md:section-1')).toBeNull()
    expect(snapshotFromListenKey('')).toBeNull()
    expect(snapshotFromListenKey('browser-page:main:teams:x')).toBeNull()
    expect(snapshotFromListenKey('doc:')).toEqual({ kind: 'document' })
  })
})

describe('parseVoiceAsk / parseVoiceAskSnapshot', () => {
  it('passes a well-formed ask through', () => {
    expect(parseVoiceAsk({ snapshot: { kind: 'action', id: 'a-1', readingAt: 'Due today.' } })).toEqual({
      snapshot: { kind: 'action', id: 'a-1', readingAt: 'Due today.' },
    })
    expect(parseVoiceAsk({})).toEqual({})
  })

  it('is null for what is not an ask', () => {
    expect(parseVoiceAsk(undefined)).toBeNull()
    expect(parseVoiceAsk('yes')).toBeNull()
    expect(parseVoiceAsk([])).toBeNull()
  })

  it('bounds every string, on one line, angle brackets defused; ids must look like ids', () => {
    const snapshot = parseVoiceAskSnapshot({
      kind: 'document',
      id: 'x'.repeat(VOICE_ASK_LIMITS.id + 1),
      readingAt: `line one\nline two <b>${'z'.repeat(400)}`,
    })!
    expect(snapshot.id).toBeUndefined()
    expect(snapshot.readingAt!.startsWith('line one line two ‹b›')).toBe(true)
    expect([...snapshot.readingAt!].length).toBe(VOICE_ASK_LIMITS.readingAt)
    expect(snapshot.readingAt!.endsWith('…')).toBe(true)
    expect(parseVoiceAskSnapshot({ kind: 'document', id: 'has space' })).toEqual({ kind: 'document' })
  })

  it('an unknown kind is no snapshot', () => {
    expect(parseVoiceAskSnapshot({ kind: 'spreadsheet', id: '1' })).toBeNull()
    expect(parseVoiceAsk({ snapshot: { kind: 'spreadsheet' } })).toEqual({})
  })
})

describe('deliverVoiceAsk', () => {
  it('no panel takes it: null', () => {
    expect(deliverVoiceAsk('Who sent this?', {})).toBeNull()
  })

  it('a panel takes it: speaking and the outcome (once) reach the host; interrupt reaches the panel', () => {
    const onSpeaking = vi.fn()
    const onSettled = vi.fn()
    const cut = vi.fn()
    let delivery: VoiceAskDelivery | null = null
    const listener = (e: Event) => {
      delivery = (e as CustomEvent).detail
      expect(isVoiceAskDelivery(delivery)).toBe(true)
      delivery!.accept()
      delivery!.onInterrupt(cut)
    }
    window.addEventListener(VOICE_ASK_EVENT, listener)
    try {
      const handle = deliverVoiceAsk('Who sent this?', { snapshot: { kind: 'document', id: 'd1' } }, { onSpeaking, onSettled })!
      expect(handle).not.toBeNull()
      expect(delivery!.text).toBe('Who sent this?')
      expect(delivery!.voiceAsk).toEqual({ snapshot: { kind: 'document', id: 'd1' } })
      delivery!.speaking()
      expect(onSpeaking).toHaveBeenCalledTimes(1)
      handle.interrupt()
      expect(cut).toHaveBeenCalledTimes(1)
      delivery!.settle('interrupted')
      delivery!.settle('spoken')
      expect(onSettled).toHaveBeenCalledTimes(1)
      expect(onSettled).toHaveBeenCalledWith('interrupted')
      // Over: nothing more either way.
      delivery!.speaking()
      handle.interrupt()
      expect(onSpeaking).toHaveBeenCalledTimes(1)
      expect(cut).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener(VOICE_ASK_EVENT, listener)
    }
  })

  it('cancelled by the host: nothing more is reported', () => {
    const onSettled = vi.fn()
    let delivery: VoiceAskDelivery | null = null
    const listener = (e: Event) => {
      delivery = (e as CustomEvent).detail
      delivery!.accept()
    }
    window.addEventListener(VOICE_ASK_EVENT, listener)
    try {
      const handle = deliverVoiceAsk('Next', {}, { onSettled })!
      handle.cancel()
      delivery!.settle('spoken')
      expect(onSettled).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener(VOICE_ASK_EVENT, listener)
    }
  })

  it('isVoiceAskDelivery refuses anything else', () => {
    expect(isVoiceAskDelivery(null)).toBe(false)
    expect(isVoiceAskDelivery({ text: 'x', voiceAsk: {} })).toBe(false)
  })
})
