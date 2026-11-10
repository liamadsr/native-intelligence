/**
 * Instructions that send a person to a list in macOS System Settings name the
 * app as that list shows it. Builds from before the rename are listed as
 * Dial8, so until they are gone every such instruction names both.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { APP_IN_SYSTEM_SETTINGS } from '../desktop-app-name'
import { voiceRefusalMessage } from '../voice/messages'

const FILES_THAT_POINT_AT_SYSTEM_SETTINGS = [
  'src/components/desktop/audio-permissions-panel.tsx',
  'src/app/account/onboarding/permissions-step.tsx',
  'src/hooks/use-recording.ts',
  'src/components/capture/system-audio-warning.tsx',
  'src/app/hud/dictate/dictate-panel.tsx',
  'src/app/account/settings/voice/read-anywhere-section.tsx',
  'src/lib/voice/messages.ts',
]

/** A sentence, on one line, that tells a person to switch the app on in one of macOS's lists. */
const POINTS_AT_A_LIST = /(turn on|enable|allow|flip the toggle for) Native Intelligence\b(?! \(listed as)[^.\n]*(System Settings|Accessibility|Screen & System Audio Recording|Privacy & Security)/i

describe('the app as System Settings lists it', () => {
  it('names the current name and the one older builds are listed under', () => {
    expect(APP_IN_SYSTEM_SETTINGS).toBe('Native Intelligence (listed as Dial8 in older versions)')
    expect(voiceRefusalMessage('mic_denied')).toContain(APP_IN_SYSTEM_SETTINGS)
  })

  it.each(FILES_THAT_POINT_AT_SYSTEM_SETTINGS)('%s takes it from the one constant', (file) => {
    const source = readFileSync(join(process.cwd(), file), 'utf8')
    expect(source).toContain('APP_IN_SYSTEM_SETTINGS')
    expect(source).not.toMatch(POINTS_AT_A_LIST)
  })
})
