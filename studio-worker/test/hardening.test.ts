import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fenceInputs, PROTOCOL_WHITELIST } from '../src/media.ts'
import { LOCKED_PROFILE, lockedProfile, sofficeArgs } from '../src/jobs/slides.ts'

test('every FFmpeg input, and ffprobe’s one, may open local files and pipes only', () => {
  const fence = ['-protocol_whitelist', PROTOCOL_WHITELIST]
  assert.equal(PROTOCOL_WHITELIST, 'file,pipe')
  assert.deepEqual(fenceInputs('ffprobe', ['-v', 'error', '-show_format', 'upload.mp4']), [...fence, '-v', 'error', '-show_format', 'upload.mp4'])
  assert.deepEqual(
    fenceInputs('/opt/homebrew/bin/ffmpeg', ['-v', 'error', '-ss', '2', '-i', 'a.mp4', '-f', 'lavfi', '-i', 'color=c=black', 'out.mp4']),
    ['-v', 'error', '-ss', '2', ...fence, '-i', 'a.mp4', '-f', 'lavfi', ...fence, '-i', 'color=c=black', 'out.mp4'],
  )
  // A caller's own fence is kept, never doubled; other tools are untouched.
  assert.deepEqual(fenceInputs('ffmpeg', [...fence, '-i', 'a.mp4']), [...fence, '-i', 'a.mp4'])
  assert.deepEqual(fenceInputs('ffprobe', [...fence, 'a.mp4']), [...fence, 'a.mp4'])
  assert.deepEqual(fenceInputs('pdftoppm', ['-png', '-i', 'x']), ['-png', '-i', 'x'])
})

test('LibreOffice converts in a fresh profile that runs no macros and follows no untrusted links', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-lo-'))
  try {
    const url = await lockedProfile(join(dir, 'profile'))
    assert.ok(url.startsWith('file:///'))
    const written = await readFile(join(dir, 'profile', 'user', 'registrymodifications.xcu'), 'utf8')
    assert.equal(written, LOCKED_PROFILE)
    for (const setting of ['DisableMacrosExecution', 'BlockUntrustedRefererLinks', 'MacroSecurityLevel']) assert.ok(written.includes(setting), setting)
    const args = sofficeArgs(url, '/scratch', '/scratch/source.pptx')
    assert.equal(args[0], `-env:UserInstallation=${url}`)
    for (const flag of ['--headless', '--norestore', '--nolockcheck', '--nodefault']) assert.ok(args.includes(flag), flag)
    assert.deepEqual(args.slice(-5), ['--convert-to', 'pdf', '--outdir', '/scratch', '/scratch/source.pptx'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
