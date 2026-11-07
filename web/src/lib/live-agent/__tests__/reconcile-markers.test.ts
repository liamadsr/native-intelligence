import { describe, it, expect } from 'vitest'
import { reconcileSummaryMarkers, type RealProposal } from '../reconcile-markers'

const P = (id: string, text: string): RealProposal => ({ id, display_text: text })

describe('reconcileSummaryMarkers', () => {
  it('keeps a valid marker and its bullet untouched', () => {
    const real = [P('real-1', 'Do the thing')]
    const summary = `## Next Steps\n\n- Do the thing\n<!-- proposal:real-1 -->`
    const out = reconcileSummaryMarkers(summary, real)
    expect(out).toContain('<!-- proposal:real-1 -->')
    expect(out).toContain('- Do the thing')
    // no duplicate appended block
    expect(out.match(/## Next Steps/g)?.length).toBe(1)
  })

  it('drops an empty bullet whose only content is a stale marker', () => {
    // The real bug: summary has bullets that are ONLY a marker pointing at an id
    // that does not exist among the real proposals → renders as an empty bullet.
    const real = [P('real-1', 'Real action one')]
    const summary =
      `## Next Steps\n\n` +
      `- <!-- proposal:ghost-aaa -->\n` +
      `- <!-- proposal:ghost-bbb -->\n` +
      `- <!-- proposal:real-1 -->`
    const out = reconcileSummaryMarkers(summary, real)
    // ghost markers gone, no empty bullets left
    expect(out).not.toContain('ghost-aaa')
    expect(out).not.toContain('ghost-bbb')
    // the real one is still anchored (it was referenced, so not re-appended)
    expect((out.match(/proposal:real-1/g) || []).length).toBe(1)
    // no line is just a dash
    expect(out.split('\n').some((l) => l.trim() === '-')).toBe(false)
  })

  it('strips a stale INLINE marker but keeps the real bullet text', () => {
    const real: RealProposal[] = []
    const summary = `- Liam to send the deck <!-- proposal:ghost -->`
    const out = reconcileSummaryMarkers(summary, real)
    expect(out).toContain('Liam to send the deck')
    expect(out).not.toContain('proposal:ghost')
  })

  it('appends real proposals the summary never referenced under Next Steps', () => {
    const real = [P('a', 'Action A'), P('b', 'Action B')]
    const summary = `## Summary\n\nWe talked about stuff.`
    const out = reconcileSummaryMarkers(summary, real)
    expect(out).toContain('## Next Steps')
    expect(out).toContain('- Action A')
    expect(out).toContain('<!-- proposal:a -->')
    expect(out).toContain('- Action B')
    expect(out).toContain('<!-- proposal:b -->')
  })

  it('appends orphans into an existing Next Steps header rather than duplicating it', () => {
    const real = [P('ref-1', 'Already anchored'), P('orphan-1', 'Not yet anchored')]
    const summary =
      `## Next Steps\n\n- Already anchored\n<!-- proposal:ref-1 -->`
    const out = reconcileSummaryMarkers(summary, real)
    expect(out.match(/## Next Steps/g)?.length).toBe(1)
    expect(out).toContain('<!-- proposal:ref-1 -->')
    expect(out).toContain('- Not yet anchored')
    expect(out).toContain('<!-- proposal:orphan-1 -->')
  })

  it('collapses a valid marker repeated on its own line to a single card', () => {
    // The real prod bug: the batch agent emits the SAME valid id twice (e.g.
    // once inline on a bullet and again under another section), each marker
    // renders an identical proposal card.
    const real = [P('dup-1', 'Email Sarah the proposal by Friday')]
    const summary =
      `## Next Steps\n\n` +
      `- Email Sarah the proposal by Friday\n<!-- proposal:dup-1 -->\n\n` +
      `## Team Work\n\n` +
      `- Email Sarah the proposal by Friday\n<!-- proposal:dup-1 -->`
    const out = reconcileSummaryMarkers(summary, real)
    // The id is anchored exactly once now.
    expect((out.match(/proposal:dup-1/g) || []).length).toBe(1)
    // Not re-appended as an orphan (it was referenced).
    expect(out.match(/## Next Steps/g)?.length).toBe(1)
  })

  it('collapses a repeated valid INLINE marker to one, keeping all the text', () => {
    const real = [P('dup-2', 'Ship it')]
    const summary =
      `- First mention of the task <!-- proposal:dup-2 -->\n` +
      `- Second mention of the task <!-- proposal:dup-2 -->`
    const out = reconcileSummaryMarkers(summary, real)
    expect((out.match(/proposal:dup-2/g) || []).length).toBe(1)
    // Both bullets' text survives — only the duplicate marker is stripped.
    expect(out).toContain('First mention of the task')
    expect(out).toContain('Second mention of the task')
  })

  it('is a no-op when every marker is valid and every proposal is referenced', () => {
    const real = [P('x', 'X thing')]
    const summary = `## Next Steps\n\n- X thing\n<!-- proposal:x -->`
    expect(reconcileSummaryMarkers(summary, real)).toBe(summary)
  })

  it('returns empty summary unchanged', () => {
    expect(reconcileSummaryMarkers('', [P('a', 'A')])).toBe('')
  })

  it('handles a summary with proposals=[] by stripping all markers/empty bullets', () => {
    const summary = `## Next Steps\n\n- <!-- proposal:gone -->`
    const out = reconcileSummaryMarkers(summary, [])
    expect(out).not.toContain('proposal:gone')
    expect(out.split('\n').some((l) => l.trim() === '-')).toBe(false)
  })
})
