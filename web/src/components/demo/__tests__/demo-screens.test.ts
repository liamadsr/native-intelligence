import { existsSync, readFileSync } from 'node:fs'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { DEMO_SCREENS, DEMO_WINDOWS } from '../demo-screens'

// Every screen a page can frame has what the recorder writes for it
// (scripts/record-demo-screens.ts): the answers the app is drawn from, and the
// picture that stands in for it. A screen added to the list without a
// recording would leave a frame with nothing under it.
describe('the demo screens', () => {
  it.each(DEMO_SCREENS)('%s has a recording, loaded by the demo, and a picture in the shape of its window', async (screen) => {
    expect(existsSync(`src/lib/demo/snapshots/app/${screen}.json`)).toBe(true)
    expect(readFileSync('src/components/demo/demo-shell.tsx', 'utf8')).toContain(`snapshots/app/${screen}.json`)
    expect(readFileSync('scripts/record-demo-screens.ts', 'utf8')).toMatch(new RegExp(`^  ${screen}: \\{`, 'm'))
    const picture = await sharp(`public/screens/demo/${screen}.webp`).metadata()
    const window = DEMO_WINDOWS[screen]
    expect((picture.width ?? 0) / (picture.height ?? 1)).toBeCloseTo(window.width / window.height, 2)
  })

  it('a recording that presses a control after opening names it, and holds no address outside the made-up ones', () => {
    const transcript = JSON.parse(readFileSync('src/lib/demo/snapshots/app/transcript.json', 'utf8')) as { then?: string[] }
    expect(transcript.then).toEqual(['Transcripts'])
    for (const screen of DEMO_SCREENS) {
      const text = readFileSync(`src/lib/demo/snapshots/app/${screen}.json`, 'utf8')
      const real = (text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []).filter((address) => !/\.(test|example)$/i.test(address))
      expect(real).toEqual([])
    }
  })
})
