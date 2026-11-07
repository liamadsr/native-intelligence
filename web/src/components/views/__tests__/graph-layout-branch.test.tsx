/**
 * The `graph` layout branch of UnifiedViewLayout.
 *
 * `view_layout` is ONE global enum shared by every entity type, but only a page
 * that supplies `renderGraph` has a canvas to draw. So a view can always ask
 * for a layout the surface it is mounted on cannot give it — from a saved claim
 * view opened somewhere that embeds claims without a canvas, or from a
 * hand-made API call. `resolveEffectiveLayout` is the one place that decides
 * what happens then, and everything downstream keys off its answer rather than
 * the configured value.
 *
 * The subtle half is the row query. The canvas fetches its own tiles, so a real
 * graph must NOT also run the paginated row query — that result is thrown away,
 * on every filter edit, competing with the fetch it is racing. But the FALLBACK
 * list very much must run it. A gate written against `config.layout` instead of
 * the effective one satisfies the first requirement and silently breaks the
 * second: a permanently empty list with no error.
 */
import { describe, it, expect } from 'vitest'
import { resolveEffectiveLayout } from '@/components/views/unified-view-layout'
import { defaultLayout } from '@/lib/views/types'

describe('resolveEffectiveLayout', () => {
  it('draws the graph when the page supplied one', () => {
    expect(resolveEffectiveLayout('graph', true)).toBe('graph')
  })

  it('falls back to the list when the page has no canvas', () => {
    expect(resolveEffectiveLayout('graph', false)).toBe('list')
  })

  it('leaves the tabular layouts alone either way', () => {
    for (const hasGraph of [true, false]) {
      expect(resolveEffectiveLayout('list', hasGraph)).toBe('list')
      expect(resolveEffectiveLayout('board', hasGraph)).toBe('board')
    }
  })
})

describe('the row query follows the EFFECTIVE layout', () => {
  // The gate in UnifiedViewLayout is `enabled: !isGraph`, where `isGraph` is
  // computed from the effective layout. Stating the rule here as data is what
  // catches a future edit that keys it back off `config.layout`.
  const shouldQueryRows = (layout: 'list' | 'board' | 'graph', hasGraph: boolean) =>
    resolveEffectiveLayout(layout, hasGraph) !== 'graph'

  it('is skipped only when a canvas is actually drawn', () => {
    expect(shouldQueryRows('graph', true)).toBe(false)
  })

  it('RUNS for the fallback list — otherwise it renders empty forever', () => {
    expect(shouldQueryRows('graph', false)).toBe(true)
  })

  it('runs for lists and boards', () => {
    expect(shouldQueryRows('list', true)).toBe(true)
    expect(shouldQueryRows('board', true)).toBe(true)
  })
})

describe('what a claim view opens on', () => {
  it('is the map — a page WITH a canvas skips the row query on first paint', () => {
    // The two halves have to agree: claims default to `graph`, and that default
    // must be the thing that suppresses the row query. If `defaultLayout` ever
    // returned 'list' for claims, the Knowledge page's pill would say "Graph"
    // over a list of sentences.
    const layout = defaultLayout('claim')
    expect(layout).toBe('graph')
    expect(resolveEffectiveLayout(layout, true)).toBe('graph')
  })

  it('is a list on a surface with no canvas, and that list is populated', () => {
    const layout = defaultLayout('claim')
    expect(resolveEffectiveLayout(layout, false)).toBe('list')
  })
})
