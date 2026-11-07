import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Where the web HUD mounts (one-chat plan, Slice 3b): once, in the dashboard
 * shell, inside AccountProviders' RecordingProvider (it reads the recording
 * context directly), beside the desktop HUD's publisher. When it shows is
 * LiveHudMount's own business (web-hud.test.tsx: only while a live capture
 * records, never in the desktop app). The shell can't be mounted in a unit
 * test, so this pins it in the source.
 */
const shell = readFileSync(join(process.cwd(), 'src/app/account/(dashboard)/dashboard-shell.tsx'), 'utf8')
const providers = readFileSync(join(process.cwd(), 'src/app/account/account-providers.tsx'), 'utf8')

describe('the web HUD in the dashboard shell', () => {
  it('is mounted exactly once, from components/live-hud/web-hud', () => {
    expect(shell).toContain("import { LiveHudMount } from '@/components/live-hud/web-hud'")
    expect(shell.match(/<LiveHudMount \/>/g)).toHaveLength(1)
  })

  it('sits beside the desktop HUD publisher, which needs the recording context too', () => {
    const at = shell.indexOf('<LiveHudMount />')
    const publisher = shell.indexOf('<VoiceIdHudPublisher />')
    expect(publisher).toBeGreaterThan(-1)
    expect(Math.abs(at - publisher)).toBeLessThan(400)
    // The shell renders inside AccountProviders, whose RecordingProvider wraps it.
    expect(providers).toContain('<RecordingProvider>')
  })
})
