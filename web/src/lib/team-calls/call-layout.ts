/**
 * How a call's tiles use the stage they are drawn on: the members' panel
 * (src/components/team-calls/call-panel.tsx) and a meeting guest's page
 * (src/components/meeting-links/guest-meeting.tsx) both ask this, with the
 * size of the box the tiles sit in (measured, not the window's: the members'
 * panel is narrower than the window). Pure: no DOM, no React.
 *
 * - No screen shared: the people share the stage. Every column count is tried
 *   and the one that gives each tile the most area wins, each tile's shape held
 *   between tall and 16:9 (a tall stage allows tall tiles; a wide one, square
 *   at the tallest). So on a phone held upright two people stack, one per row,
 *   each the stage's width and half its height; held sideways, or on a desktop,
 *   they sit side by side. Three on a phone stack too (each still wider than
 *   tall, so faces aren't cut to a sliver); four make 2×2; five or six, 2×3.
 *   Once a tile would come out under MIN_TILE_PX tall (seven or more on a
 *   phone), the grid stops shrinking and scrolls instead, two columns on a
 *   narrow stage.
 * - A screen shared: the screens get the stage, and the people become a strip
 *   of small square tiles under them, four across on a phone and up to eight
 *   on a wide stage; on a short wide stage (a phone held sideways) the strip
 *   is a column at the screens' right instead, so the screen keeps its height.
 * - A stage of unbounded height (the members' panel docked at the side, which
 *   grows with what it holds): the tiles take the width, one column for one or
 *   two people, at 16:9; more go in two or three columns at 4:3.
 */

export type CallStageSize = {
  width: number
  /** `Infinity`: the stage grows with its tiles (the members' panel at the side). */
  height: number
}

export type CallLayout =
  /** Not measured yet (the first render, or a test without layout): the tiles fall back to their own shape. */
  | { mode: 'unmeasured' }
  | {
      mode: 'grid'
      cols: number
      rows: number
      /** Every tile's size in CSS pixels. */
      tileWidth: number
      tileHeight: number
      /** The tiles are taller than the stage together: it scrolls. */
      scroll: boolean
      orientation: 'portrait' | 'landscape'
    }
  | {
      mode: 'share'
      /** People per row in the strip beside the shared screens (1 when it is a column at the side). */
      stripCols: number
      /** Under the screens; or, on a short wide stage (a phone held sideways), a column at their right. */
      strip: 'bottom' | 'side'
      orientation: 'portrait' | 'landscape'
    }

/** Under this a tile stops shrinking and the grid scrolls. */
export const MIN_TILE_PX = 96
/** The widest a tile is drawn: a camera's own shape. */
const MAX_ASPECT = 16 / 9
/** The tallest a tile is drawn on a tall stage (one person on a phone fills it). */
const MIN_ASPECT_PORTRAIT = 1 / 2
/** ...and on a wide one: square, no taller. */
const MIN_ASPECT_LANDSCAPE = 1
/** A strip tile's width when working out how many fit across. */
const STRIP_TILE_PX = 88
/** Under this height a wide stage puts the people's strip at the side, so the shared screen keeps its height. */
const SHORT_STAGE_PX = 400

export function callLayout(people: number, screens: number, stage: CallStageSize, opts: { gap?: number } = {}): CallLayout {
  const gap = opts.gap ?? 8
  const width = Math.floor(stage.width)
  const height = stage.height === Infinity ? Infinity : Math.floor(stage.height)
  if (!(width > 0) || !(height > 0)) return { mode: 'unmeasured' }
  const orientation = height > width ? 'portrait' : 'landscape'

  if (screens > 0) {
    if (orientation === 'landscape' && height < SHORT_STAGE_PX) return { mode: 'share', stripCols: 1, strip: 'side', orientation }
    const fit = Math.floor((width + gap) / (STRIP_TILE_PX + gap))
    return { mode: 'share', stripCols: Math.min(8, Math.max(4, fit)), strip: 'bottom', orientation }
  }

  const n = Math.max(1, people)
  const cellWidth = (cols: number) => Math.floor((width - (cols - 1) * gap) / cols)

  if (height === Infinity) {
    const cols = n <= 2 ? 1 : n <= 6 ? 2 : 3
    const tileWidth = cellWidth(cols)
    const tileHeight = Math.round(tileWidth * (cols === 1 ? 9 / 16 : 3 / 4))
    return { mode: 'grid', cols, rows: Math.ceil(n / cols), tileWidth, tileHeight, scroll: false, orientation }
  }

  const minAspect = orientation === 'portrait' ? MIN_ASPECT_PORTRAIT : MIN_ASPECT_LANDSCAPE
  let best: { cols: number; rows: number; tileWidth: number; tileHeight: number; area: number } | null = null
  // A phone held upright never goes past two across: three columns there are slivers.
  const maxCols = orientation === 'portrait' && width < 600 ? 2 : n
  for (let cols = 1; cols <= Math.min(n, maxCols); cols++) {
    const rows = Math.ceil(n / cols)
    // A column count that leaves a whole row empty is the same grid as a smaller one.
    if (cols > 1 && Math.ceil(n / (cols - 1)) === rows) continue
    const cw = cellWidth(cols)
    const ch = Math.floor((height - (rows - 1) * gap) / rows)
    if (cw <= 0 || ch <= 0) continue
    let tileWidth = cw
    let tileHeight = ch
    if (cw / ch > MAX_ASPECT) tileWidth = Math.floor(ch * MAX_ASPECT)
    else if (cw / ch < minAspect) tileHeight = Math.floor(cw / minAspect)
    const area = tileWidth * tileHeight
    // On a tall stage, within a few percent of the same area, the tile closer to a camera's 4:3 reads better than a sliver.
    const better = !best
      ? true
      : orientation === 'portrait'
        ? area > best.area * 1.05 || (area >= best.area * 0.95 && Math.abs(Math.log(tileWidth / tileHeight / (4 / 3))) < Math.abs(Math.log(best.tileWidth / best.tileHeight / (4 / 3))))
        : area > best.area
    if (better) best = { cols, rows, tileWidth, tileHeight, area }
  }

  if (best && best.tileHeight >= MIN_TILE_PX) {
    return { mode: 'grid', cols: best.cols, rows: best.rows, tileWidth: best.tileWidth, tileHeight: best.tileHeight, scroll: false, orientation }
  }

  // Too many to fit at a readable size: a grid that scrolls, two across on a narrow stage.
  const cols = width < 600 ? 2 : Math.max(2, Math.min(best?.cols ?? 2, Math.floor((width + gap) / (220 + gap))))
  const tileWidth = cellWidth(cols)
  const tileHeight = Math.max(MIN_TILE_PX, Math.round(tileWidth * 3 / 4))
  const rows = Math.ceil(n / cols)
  return { mode: 'grid', cols, rows, tileWidth, tileHeight, scroll: rows * tileHeight + (rows - 1) * gap > height, orientation }
}
