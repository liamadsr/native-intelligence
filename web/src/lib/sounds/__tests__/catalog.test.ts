import { describe, it, expect } from 'vitest'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { PRELOADED_SOUND_NAMES, SOUND_NAMES, isSoundName, soundUrl } from '../catalog'

const SOUNDS_DIR = path.resolve(__dirname, '../../../../public/sounds')

describe('sound catalog', () => {
  const files = readdirSync(SOUNDS_DIR).filter((f) => !f.startsWith('.'))

  it('every name has a public/sounds/<name>.m4a', () => {
    for (const name of SOUND_NAMES) expect(files).toContain(`${name}.m4a`)
  })

  it('every file in public/sounds has a name', () => {
    for (const file of files) {
      expect(file.endsWith('.m4a'), `${file} is not an .m4a`).toBe(true)
      expect(isSoundName(file.replace(/\.m4a$/, '')), `${file} has no entry in SOUND_NAMES`).toBe(true)
    }
  })

  it("preloads the teammate arrival sounds, now that something plays them", () => {
    for (const name of ['agent-alert-arivel', 'agent-alert-hopful', 'agent-alert-questions'] as const) {
      expect(PRELOADED_SOUND_NAMES).toContain(name)
    }
  })

  it('serves each sound from /sounds', () => {
    expect(soundUrl('agent-alert')).toBe('/sounds/agent-alert.m4a')
    expect(isSoundName('agent-compete')).toBe(false)
  })
})
