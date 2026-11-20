/**
 * The app itself is heavy, so only a wide screen that has not asked to save
 * data loads it; everyone else keeps the recorder's picture of the screen.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEMO_SCREENS } from '../demo-screens'
import { demoPoster, wantsLiveDemo } from '../demo-frame'

const visitor = (innerWidth: number, saveData?: boolean) => ({ innerWidth, navigator: { connection: saveData === undefined ? undefined : { saveData } } as unknown as Navigator })

describe('wantsLiveDemo', () => {
  it('loads the app on a wide screen', () => {
    expect(wantsLiveDemo(visitor(1440))).toBe(true)
    expect(wantsLiveDemo(visitor(1024, false))).toBe(true)
  })
  it('keeps the picture on a phone or tablet, and for someone saving data', () => {
    expect(wantsLiveDemo(visitor(390))).toBe(false)
    expect(wantsLiveDemo(visitor(1023))).toBe(false)
    expect(wantsLiveDemo(visitor(1440, true))).toBe(false)
  })
})

describe('every screen has its recording and its picture', () => {
  it.each(DEMO_SCREENS)('%s', (screen) => {
    expect(existsSync(join(process.cwd(), 'src/lib/demo/snapshots/app', `${screen}.json`))).toBe(true)
    expect(existsSync(join(process.cwd(), 'public', demoPoster(screen)))).toBe(true)
  })
})

describe('the public page’s frame loads none of the app', () => {
  it('imports only React and the screens list', () => {
    const source = readFileSync(join(process.cwd(), 'src/components/demo/demo-frame.tsx'), 'utf8')
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1])
    expect(imports.sort()).toEqual(['./demo-screens', 'react'])
  })
  it('the demo page loads the app only after its own storage is in place', () => {
    const source = readFileSync(join(process.cwd(), 'src/components/demo/demo-app.tsx'), 'utf8')
    expect(source).not.toMatch(/^import .*demo-shell/m)
    expect(source.indexOf('installDemoStorage()')).toBeLessThan(source.indexOf("import('./demo-shell')"))
  })
})
