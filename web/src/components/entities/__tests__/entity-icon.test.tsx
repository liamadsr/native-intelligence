/**
 * <EntityIcon>: the kind's own glyph in the kind's own colour, by any of the
 * kind's names; a fallback (muted) for what has no identity.
 */
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Link2 } from 'lucide-react'
import { EntityIcon } from '../entity-icon'
import { ENTITY_COLOR_TEXT, ENTITY_IDENTITIES, ENTITY_IDENTITY_KINDS } from '@/lib/entities/entity-identity'

const html = (el: React.ReactElement) => renderToStaticMarkup(el)

/** The one <svg> an element draws (null for none), read from its markup. */
function drawn(el: React.ReactElement) {
  const markup = html(el)
  const m = /^<svg([^>]*)>([\s\S]*)<\/svg>$/.exec(markup)
  if (!m) return null
  const attrs = new Map([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]]))
  return { innerHTML: m[2], getAttribute: (name: string) => attrs.get(name) ?? null }
}

describe('EntityIcon', () => {
  it("draws every kind's own glyph in its own colour", () => {
    for (const kind of ENTITY_IDENTITY_KINDS) {
      const { icon: Icon, color } = ENTITY_IDENTITIES[kind]
      const svg = drawn(<EntityIcon kind={kind} />)!
      expect(svg, kind).not.toBeNull()
      expect(svg.getAttribute('data-entity-icon')).toBe(kind)
      expect(svg.getAttribute('data-entity-color')).toBe(color)
      expect(svg.getAttribute('class')).toContain(ENTITY_COLOR_TEXT[color])
      expect(svg.getAttribute('aria-hidden')).toBe('true')
      // The same paths the kind's glyph draws on its own.
      expect(svg.innerHTML, kind).toBe(drawn(<Icon />)!.innerHTML)
    }
  })

  it('tells a doc, a meeting, a project and a table apart by shape and by colour', () => {
    const kinds = ['document', 'capture', 'project', 'data_table', 'action', 'team_chat_channel'] as const
    expect(new Set(kinds.map((k) => drawn(<EntityIcon kind={k} />)!.innerHTML)).size).toBe(kinds.length)
    expect(new Set(kinds.map((k) => drawn(<EntityIcon kind={k} />)!.getAttribute('data-entity-color'))).size).toBe(kinds.length)
  })

  it("draws a kind by its other names as the kind's identity", () => {
    expect(html(<EntityIcon kind="table" />)).toBe(html(<EntityIcon kind="data_table" />))
    expect(html(<EntityIcon kind="recipe" />).replace('recipe', 'agent')).toBe(html(<EntityIcon kind="agent" />))
    expect(drawn(<EntityIcon kind="event" />)!.getAttribute('data-entity-icon')).toBe('calendar_event')
  })

  it('sizes the glyph', () => {
    expect(drawn(<EntityIcon kind="document" size="xs" />)!.getAttribute('class')).toContain('size-3')
    expect(drawn(<EntityIcon kind="document" />)!.getAttribute('class')).toContain('size-4')
    expect(drawn(<EntityIcon kind="document" size="xl" />)!.getAttribute('class')).toContain('size-5')
  })

  it('drops the colour when muted, keeping the glyph', () => {
    const svg = drawn(<EntityIcon kind="document" muted />)!
    expect(svg.getAttribute('class')).not.toContain('text-entity-')
    expect(svg.getAttribute('data-entity-color')).toBeNull()
    expect(svg.innerHTML).toBe(drawn(<EntityIcon kind="document" />)!.innerHTML)
  })

  it('draws the fallback, muted, for a kind with no identity; nothing without one', () => {
    const svg = drawn(<EntityIcon kind="nope" fallback={Link2} />)!
    expect(svg.getAttribute('data-entity-icon')).toBe('unknown')
    expect(svg.getAttribute('class')).toContain('text-muted-foreground')
    expect(svg.innerHTML).toBe(drawn(<Link2 />)!.innerHTML)
    expect(drawn(<EntityIcon kind="nope" />)).toBeNull()
    expect(drawn(<EntityIcon kind={null} />)).toBeNull()
  })
})
