/**
 * Every kind of record has ONE identity (a glyph and a colour), and no two
 * kinds can be mistaken for each other: the glyph alone tells them apart.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ENTITY_COLORS,
  ENTITY_COLOR_TEXT,
  ENTITY_COLOR_WASH,
  ENTITY_IDENTITIES,
  ENTITY_IDENTITY_KINDS,
  FINDABLE_GROUP_IDENTITY_KIND,
  entityIdentity,
  entityTextClass,
  resolveEntityIdentityKind,
} from '../entity-identity'
import { FINDABLE, FINDABLE_GROUPS, FINDABLE_KINDS } from '@/lib/search/findable-registry'
import { MENTIONABLE_TYPES } from '@/lib/entity-links/mentionable'
import { ENTITY_REGISTRY } from '@/lib/knowledge/entity-registry'
import { CREATE_TYPES } from '@/lib/create/create-types'
import { CARD_REPLY_ICONS } from '@/lib/chat/card-reply'
import { SENTENCE_ICON_GLYPHS } from '@/components/attention/sentence-icon'

/** One name per identity: an agent is also a `recipe`, a knowledge package also a `package`. */
const SAME_THING: Record<string, string> = { recipe: 'agent', package: 'knowledge_package' }
const DISTINCT_KINDS = ENTITY_IDENTITY_KINDS.filter((k) => !(k in SAME_THING))

describe('entity identity registry', () => {
  it('gives every kind the search finds an identity', () => {
    for (const kind of FINDABLE_KINDS) {
      expect(entityIdentity(kind), kind).not.toBeNull()
      // And the kind it is stored as, and mentioned as.
      const { entity, mention } = FINDABLE[kind]
      if (entity) expect(entityIdentity(entity), `${kind} → ${entity}`).not.toBeNull()
      if (mention) expect(entityIdentity(mention), `${kind} → ${mention}`).not.toBeNull()
    }
  })

  it('gives every mentionable kind and every registered entity an identity', () => {
    for (const kind of [...MENTIONABLE_TYPES, ...ENTITY_REGISTRY.map((e) => e.id)]) expect(entityIdentity(kind), kind).not.toBeNull()
  })

  it('gives every type the Create dialog makes an identity', () => {
    for (const t of CREATE_TYPES) expect(entityIdentity(t.id), t.id).not.toBeNull()
  })

  it('gives every search tab (a group of kinds) a kind to wear', () => {
    for (const group of FINDABLE_GROUPS) {
      const kind = FINDABLE_GROUP_IDENTITY_KIND[group]
      expect(ENTITY_IDENTITIES[kind], group).toBeDefined()
    }
    // No two tabs wear the same glyph.
    const glyphs = FINDABLE_GROUPS.map((g) => ENTITY_IDENTITIES[FINDABLE_GROUP_IDENTITY_KIND[g]].icon)
    expect(new Set(glyphs).size).toBe(glyphs.length)
  })

  it('never lets two kinds share both glyph and colour', () => {
    const seen = new Map<string, string>()
    for (const kind of DISTINCT_KINDS) {
      const { icon, color } = ENTITY_IDENTITIES[kind]
      const name = (icon as { displayName?: string }).displayName ?? String(icon)
      const key = `${name}:${color}`
      expect(seen.get(key), `${kind} and ${seen.get(key)} are both ${key}`).toBeUndefined()
      seen.set(key, kind)
    }
  })

  it('never tells two kinds apart by colour alone: every kind has its own glyph', () => {
    const owner = new Map<unknown, string>()
    for (const kind of DISTINCT_KINDS) {
      const { icon } = ENTITY_IDENTITIES[kind]
      expect(owner.get(icon), `${kind} and ${owner.get(icon)} share a glyph`).toBeUndefined()
      owner.set(icon, kind)
    }
  })

  it('draws a kind stored under two names as one identity', () => {
    for (const [alias, kind] of Object.entries(SAME_THING)) {
      expect(ENTITY_IDENTITIES[alias as keyof typeof ENTITY_IDENTITIES]).toBe(ENTITY_IDENTITIES[kind as keyof typeof ENTITY_IDENTITIES])
    }
  })

  it('names every identity and tints it in a registered hue', () => {
    for (const kind of ENTITY_IDENTITY_KINDS) {
      const { label, color } = ENTITY_IDENTITIES[kind]
      expect(label.trim(), kind).not.toBe('')
      expect(ENTITY_COLORS, kind).toContain(color)
    }
  })

  it('resolves the other names a kind goes by, and nothing else', () => {
    expect(resolveEntityIdentityKind('table')).toBe('data_table')
    expect(resolveEntityIdentityKind('channel')).toBe('team_chat_channel')
    expect(resolveEntityIdentityKind('email')).toBe('email_thread')
    expect(resolveEntityIdentityKind('event')).toBe('calendar_event')
    expect(resolveEntityIdentityKind('task')).toBe('action')
    expect(resolveEntityIdentityKind('document')).toBe('document')
    expect(resolveEntityIdentityKind('toString')).toBeNull()
    expect(resolveEntityIdentityKind('nope')).toBeNull()
    expect(resolveEntityIdentityKind(null)).toBeNull()
    expect(entityIdentity('nope')).toBeNull()
    expect(entityTextClass('document')).toBe('text-entity-purple')
    expect(entityTextClass('nope')).toBe('')
  })

  it("draws a For you card's kind icons as the kinds' own glyphs", () => {
    expect(SENTENCE_ICON_GLYPHS.document).toBe(ENTITY_IDENTITIES.document.icon)
    expect(SENTENCE_ICON_GLYPHS.action).toBe(ENTITY_IDENTITIES.action.icon)
    expect(SENTENCE_ICON_GLYPHS.capture).toBe(ENTITY_IDENTITIES.capture.icon)
    expect(SENTENCE_ICON_GLYPHS.mail).toBe(ENTITY_IDENTITIES.email_thread.icon)
    expect(SENTENCE_ICON_GLYPHS.bot).toBe(ENTITY_IDENTITIES.agent.icon)
    for (const icon of CARD_REPLY_ICONS) expect(SENTENCE_ICON_GLYPHS[icon], icon).toBeDefined()
  })
})

describe('entity identity colours are theme tokens', () => {
  const css = readFileSync(join(process.cwd(), 'src/styles/tailwind.css'), 'utf8')

  it('defines every hue for the light and the dark theme, and as a Tailwind colour', () => {
    for (const hue of ENTITY_COLORS) {
      const defs = css.match(new RegExp(`^\\s*--entity-${hue}:\\s*oklch\\(`, 'gm')) ?? []
      expect(defs.length, `--entity-${hue}`).toBe(2)
      expect(css, hue).toContain(`--color-entity-${hue}: var(--entity-${hue});`)
      expect(ENTITY_COLOR_TEXT[hue]).toBe(`text-entity-${hue}`)
      expect(ENTITY_COLOR_WASH[hue]).toBe(`bg-entity-${hue}/10`)
    }
  })

  it('keeps each hue darker on the light theme than on the dark', () => {
    for (const hue of ENTITY_COLORS) {
      const [light, dark] = [...css.matchAll(new RegExp(`--entity-${hue}:\\s*oklch\\(([\\d.]+)`, 'g'))].map((m) => Number(m[1]))
      expect(light, hue).toBeLessThanOrEqual(0.56)
      expect(dark, hue).toBeGreaterThanOrEqual(0.7)
    }
  })
})
