/**
 * The face ids (bot-faces.ts): plain data the column, its trigger and the
 * voice dealer key on. Pinned: every character once with its name; a built
 * face's id round-trips its recipe; the part lists never move (an id's letters
 * mean their place in them); and a face is named after its character or body.
 */
import { describe, expect, it } from 'vitest'
import {
  BOT_CHARACTERS,
  BUILT_BODIES,
  BUILT_COLORS,
  BUILT_EYES,
  BUILT_GLASSES,
  BUILT_WEAR,
  builtBotId,
  builtBotRecipe,
  characterName,
  isBuiltBotId,
  type BotRecipe,
} from '../bot-faces'

describe('BOT_CHARACTERS', () => {
  it('is 24 characters, each once, no two names alike', () => {
    const types = BOT_CHARACTERS.map((c) => c.type)
    expect(types).toHaveLength(24)
    expect(new Set(types).size).toBe(24)
    expect(new Set(BOT_CHARACTERS.map((c) => c.name)).size).toBe(24)
    expect(BOT_CHARACTERS[0]).toEqual({ type: 'chat', name: 'Assistant' })
  })
})

describe('characterName', () => {
  it('names a character, a built face after its body, and anything else as Sprout', () => {
    expect(characterName('mail')).toBe('Email')
    expect(characterName('notes')).toBe('Note taker')
    expect(characterName(builtBotId({ body: 'heart', glasses: 'round' })!)).toBe('Heart')
    expect(characterName(builtBotId({ body: 'dev', worn: 'cap' })!)).toBe('Developer')
    expect(characterName('nope' as never)).toBe('Sprout')
  })
})

describe('a built face’s id', () => {
  it('is its recipe: every part round-trips', () => {
    const recipes: BotRecipe[] = [
      { body: 'round' },
      { body: 'deals', color: '#F47FB4' },
      { body: 'egg', eyes: 'sleepy', glasses: 'round', worn: 'headset' },
      { body: 'mail', color: '#F4F2FA', eyes: 'happy', glasses: 'monocle', worn: 'antenna', wornColor: '#8B5A3C' },
    ]
    for (const recipe of recipes) {
      const id = builtBotId(recipe)!
      expect(id).toMatch(/^x[a-z]{7}$/)
      expect(builtBotRecipe(id)).toEqual(recipe)
    }
    expect(builtBotId({ body: 'round' })).toBe('xaaaaaaa')
    expect(builtBotId({ body: 'egg', eyes: 'sleepy', glasses: 'round', worn: 'headset' })).toBe('xabagbba')
  })

  it('gives one face one id', () => {
    expect(builtBotId({ body: 'round', eyes: 'classic' })).toBe(builtBotId({ body: 'round' }))
    expect(builtBotId({ body: 'round', wornColor: '#F47FB4' })).toBe(builtBotId({ body: 'round' }))
    expect(builtBotId({ body: 'round', color: '#f47fb4' })).toBe(builtBotId({ body: 'round', color: '#F47FB4' }))
    expect(builtBotRecipe('xaaabaaa')).toBeNull()
    expect(builtBotRecipe('xaaaaaab')).toBeNull()
  })

  it('refuses parts that aren’t in the lists, and reads no character’s id as one', () => {
    expect(builtBotId({ body: 'nope' })).toBeNull()
    expect(builtBotId({ body: 'round', color: '#123456' })).toBeNull()
    expect(builtBotId({ body: 'round', glasses: 'constructor' })).toBeNull()
    for (const bad of ['x', 'xaaaaaa', 'xaaaaaaaa', 'Xaaaaaaa', 'xaaaaaa1', 'xzzaaaaa', 'xaazaaaa', 'xaaaaaza', null, 42]) {
      expect(isBuiltBotId(bad), String(bad)).toBe(false)
    }
    for (const { type } of BOT_CHARACTERS) expect(isBuiltBotId(type), type).toBe(false)
  })

  it('never moves a part: these lists are append-only', () => {
    expect(BUILT_BODIES).toEqual([
      'round', 'egg', 'drop', 'triangle', 'square', 'pill', 'flower', 'heart', 'cloud', 'star', 'hexagon', 'bean',
      'chat', 'research', 'reconciler', 'sprout', 'writer', 'triage', 'extraction', 'berry',
      'dev', 'nova', 'live', 'flows', 'notes', 'ember', 'scout', 'dew',
      'coach', 'mail', 'knowledge', 'calendar', 'acorn', 'browser', 'shroom', 'deals',
    ])
    expect(BUILT_COLORS).toEqual([
      '#F47FB4', '#D573DC', '#9B6BFF', '#5B7BFF', '#4FB4FF', '#57C7A8',
      '#BFDB4A', '#F7CE4B', '#F28B6C', '#2E3350', '#8B5A3C', '#F4F2FA',
    ])
    expect(BUILT_EYES).toEqual(['classic', 'dot', 'googly', 'sparkle', 'ring', 'sleepy', 'happy'])
    expect(BUILT_GLASSES).toEqual(['round', 'square', 'shades', 'hearts', 'monocle'])
    expect(BUILT_WEAR).toEqual(['headset', 'bowtie', 'cap', 'beanie', 'beret', 'tophat', 'party', 'crown', 'halo', 'flower', 'leaf', 'antenna'])
    expect([...BUILT_BODIES.slice(12)].sort()).toEqual(BOT_CHARACTERS.map((c) => c.type).sort())
  })
})
