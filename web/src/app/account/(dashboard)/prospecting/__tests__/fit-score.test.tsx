// @vitest-environment jsdom
/**
 * The smallest piece of Prospecting chrome, and one of the easiest to get
 * subtly wrong.
 *
 * FIT SCORE. The number and its word, the way Exa's own demo shows them
 * ("HOT · STRONG FIT · 95"). The bands are a verdict, so the scale has to be
 * readable as one — hot emerald, warm sky, moderate amber, cold muted — and
 * an UNSCORED entry says "Not scored" rather than rendering nothing: an
 * omitted chip silently reads as a bad score and un-aligns every row beneath
 * it.
 *
 * (The stage tabs — All · Saved · Needs review · Dismissed — used to be a chip
 * strip tested here. They live in the views' own tab row now, and are pinned
 * by src/components/views/__tests__/view-tabs-prospect-stages.test.tsx.)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { PROSPECT_FIT_LABELS } from '@/lib/prospecting/types'
import { FIT_LABEL_FLOOR } from '@/lib/prospecting/fit'
import {
  FIT_LABEL_CLASSES,
  FIT_UNSCORED_TITLE,
  fitScoreClass,
  fitScoreTitle,
  fitScoreWord,
} from '@/lib/prospecting/fit-display'
import { FitScore } from '../fit-score'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function chip(): HTMLElement {
  return container.querySelector('[data-fit-score]') as HTMLElement
}

describe('fit-display', () => {
  it('gives every band its own colour, and the four are distinct', () => {
    const classes = PROSPECT_FIT_LABELS.map((l) => FIT_LABEL_CLASSES[l])
    expect(new Set(classes).size).toBe(PROSPECT_FIT_LABELS.length)
    expect(fitScoreClass(95)).toContain('emerald')
    expect(fitScoreClass(70)).toContain('sky')
    expect(fitScoreClass(50)).toContain('amber')
    // Cold is the quiet one — "we do not think so" must not shout.
    expect(fitScoreClass(10)).toContain('muted')
    // And unscored is its own grey, distinct from every band.
    expect(classes).not.toContain(fitScoreClass(null))
  })

  it('reads the bands at the shared floors', () => {
    expect(fitScoreWord(FIT_LABEL_FLOOR.strong)).toBe('Strong match')
    expect(fitScoreWord(FIT_LABEL_FLOOR.strong - 1)).toBe('Good match')
    expect(fitScoreWord(FIT_LABEL_FLOOR.good - 1)).toBe('Partial match')
    expect(fitScoreWord(FIT_LABEL_FLOOR.partial - 1)).toBe('Weak match')
    expect(fitScoreWord(null)).toBeNull()
  })

  it('puts the long word AND the number in the tooltip', () => {
    expect(fitScoreTitle(88)).toBe('Match score 88 of 100 · Strong match')
    expect(fitScoreTitle(12)).toBe('Match score 12 of 100 · Weak match')
    expect(fitScoreTitle(null)).toBe(FIT_UNSCORED_TITLE)
    // The unscored title says what to DO, not just what is missing.
    expect(FIT_UNSCORED_TITLE.toLowerCase()).toContain('enrich')
  })
})

describe('FitScore', () => {
  it('renders the number and its word, with the long form as the accessible label', async () => {
    await act(async () => {
      root.render(<FitScore score={88} />)
    })
    expect(chip().textContent).toBe('88match score')
    expect(chip().getAttribute('data-fit-score')).toBe('88')
    expect(chip().getAttribute('data-fit-label')).toBe('strong')
    expect(chip().getAttribute('aria-label')).toBe('Match score 88 of 100 · Strong match')
    expect(chip().className).toContain('emerald')
  })

  it('renders every band', async () => {
    for (const [score, band] of [
      [100, 'strong'],
      [65, 'good'],
      [40, 'partial'],
      [0, 'weak'],
    ] as const) {
      await act(async () => {
        root.render(<FitScore score={score} />)
      })
      // The chip says what the number IS; the band rides on the attribute
      // (and the colour), never as a temperature word.
      expect(chip().textContent, String(score)).toBe(`${score}match score`)
      expect(chip().getAttribute('data-fit-label'), String(score)).toBe(band)
    }
  })

  it('renders an unscored entry as "Not scored", never as nothing', async () => {
    await act(async () => {
      root.render(<FitScore score={null} />)
    })
    expect(chip().getAttribute('data-fit-score')).toBe('none')
    expect(chip().getAttribute('data-fit-label')).toBe('none')
    expect(chip().textContent).toBe('Not scored')
    expect(chip().getAttribute('title')).toBe(FIT_UNSCORED_TITLE)
    // Same footprint as a scored chip, so a mixed list still lines up.
    expect(chip().className).toContain('h-6')
  })
})
