// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { CARD_STATE_MAX_AGE_MS, sweepCardStates } from '../card-storage'

const NOW = Date.UTC(2026, 10, 10)
const fresh = JSON.stringify({ savedAt: NOW - 1000 })
const stale = JSON.stringify({ savedAt: NOW - CARD_STATE_MAX_AGE_MS - 1000 })

describe('sweepCardStates', () => {
  beforeEach(() => localStorage.clear())

  it('drops the records of cards untouched for too long, and unreadable ones, keeping the rest', () => {
    localStorage.setItem('ni:chat-card:old', stale)
    localStorage.setItem('ni:chat-card:new', fresh)
    localStorage.setItem('ni:chat-card:broken', '{not json')
    localStorage.setItem('ni:other', stale)
    sweepCardStates(NOW)
    expect(Object.keys(localStorage).sort()).toEqual(['ni:chat-card:new', 'ni:other'])
  })

  it('judges the copy the storage rename script left under the old name the same way', () => {
    localStorage.setItem('ni:chat-card:old', stale)
    localStorage.setItem('dial8:chat-card:old', stale)
    localStorage.setItem('dial8:chat-card:new', fresh)
    localStorage.setItem('dial8:other', stale)
    sweepCardStates(NOW)
    expect(Object.keys(localStorage).sort()).toEqual(['dial8:chat-card:new', 'dial8:other'])
  })
})
