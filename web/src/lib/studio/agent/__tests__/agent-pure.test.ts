/**
 * The Studio agent's pure parts: the script's text form (./script-text.ts),
 * the frames sheet's layout (./stills-sheet.ts) and how a Studio error reads
 * to the agent (./access.ts). Made-up words.
 */
import { describe, expect, it } from 'vitest'
import { StudioError, digestConflict, notFoundError, notSetUpError } from '@/lib/studio/server/errors'
import { studioRefusal } from '../access'
import { parseScriptText, scriptSeconds, scriptText } from '../script-text'
import { sheetColumns, sheetLayout } from '../stills-sheet'

describe('the script text form', () => {
  it('reads blocks, each with an optional [5s] length and Label: name, on one line or the label on its own', () => {
    const parsed = parseScriptText('[3s] Hook: Your inbox, finally quiet.\n\nProof:\nEvery reply drafted\nbefore you open it.\n\n[2.5 sec] Try it today.')
    expect(parsed).toEqual({
      ok: true,
      beats: [
        { text: 'Your inbox, finally quiet.', seconds: 3, label: 'Hook' },
        { text: 'Every reply drafted before you open it.', label: 'Proof' },
        { text: 'Try it today.', seconds: 2.5 },
      ],
    })
  })

  it('keeps a sentence with a colon in it as words, and writes beats back the same way', () => {
    const parsed = parseScriptText('This is the thing we kept hearing from customers: it just works.')
    expect(parsed).toEqual({ ok: true, beats: [{ text: 'This is the thing we kept hearing from customers: it just works.' }] })
    const beats = [{ text: 'Your inbox, finally quiet.', seconds: 3, label: 'Hook' }, { text: 'Try it today.' }]
    expect(scriptText(beats)).toBe('[3s] Hook: Your inbox, finally quiet.\n\nTry it today.')
    expect(parseScriptText(scriptText(beats))).toEqual({ ok: true, beats })
  })

  it('refuses an empty script, a beat with no words, an impossible length, or too many beats', () => {
    expect(parseScriptText('  \n\n ')).toMatchObject({ ok: false })
    expect(parseScriptText('[2s]')).toMatchObject({ ok: false, error: expect.stringContaining('Beat 1 has no words') })
    expect(parseScriptText('[0s] Too short')).toMatchObject({ ok: false, error: expect.stringContaining('[0s]') })
    expect(parseScriptText(Array.from({ length: 101 }, (_, i) => `Line ${i}`).join('\n\n'))).toMatchObject({ ok: false, error: expect.stringContaining('at most 100') })
  })

  it('times a script by its beats, else its words at the speaking pace', () => {
    expect(scriptSeconds([{ text: 'a b c', seconds: 4 }, { text: 'one two three four five six seven eight nine ten eleven twelve thirteen' }])).toBe(9)
  })
})

describe('the frames sheet', () => {
  it('lays frames out in rows within the edge a model reads', () => {
    expect([1, 2, 3, 4, 5, 9, 10, 12].map(sheetColumns)).toEqual([1, 2, 2, 2, 3, 3, 4, 4])
    const wide = sheetLayout(4, 16 / 9, 1568)
    expect(wide.width).toBeLessThanOrEqual(1568)
    expect(wide.height).toBeLessThanOrEqual(1568)
    expect(wide.at).toEqual([
      { left: 0, top: 0 },
      { left: wide.cell.width + 8, top: 0 },
      { left: 0, top: wide.cell.height + 8 },
      { left: wide.cell.width + 8, top: wide.cell.height + 8 },
    ])
    // Tall frames: the height binds.
    const tall = sheetLayout(12, 9 / 16, 1568)
    expect(tall.height).toBeLessThanOrEqual(1568)
    expect(tall.cell.width / tall.cell.height).toBeCloseTo(9 / 16, 1)
  })
})

describe('a Studio error as the agent reads it', () => {
  it('names a missing thing in the agent’s words, explains a stale digest, and passes the Studio’s own sentence through', () => {
    expect(studioRefusal(notFoundError('Project not found'))).toEqual({ success: false, code: 'NOT_FOUND', error: expect.stringContaining('No such video') })
    expect(studioRefusal(notFoundError('Project not found'), 'studio_project').error).toContain('No such Studio project')
    expect(studioRefusal(digestConflict())).toMatchObject({ code: 'DIGEST_CONFLICT', error: expect.stringContaining('get_studio_video') })
    expect(studioRefusal(new StudioError('File this video in a project to give it a status'))).toEqual({ success: false, code: 'INVALID', error: 'File this video in a project to give it a status' })
    // The engine's own refusal (a locked beat) reaches the agent as it is.
    expect(studioRefusal(new Error('Step 1 (update_beat): Beat Hook is locked by the person; ask them before changing it'))).toEqual({
      success: false,
      code: 'INVALID',
      error: 'Step 1 (update_beat): Beat Hook is locked by the person; ask them before changing it',
    })
    expect(studioRefusal('?')).toMatchObject({ code: 'INTERNAL' })
  })
})

describe('the frames sheet, drawn', () => {
  it('lays several frames on one JPEG and shows one frame on its own', async () => {
    const { default: sharp } = await import('sharp')
    const frame = (color: string) => sharp({ create: { width: 320, height: 180, channels: 3, background: color } }).png().toBuffer()
    const { stillsSheet } = await import('../stills-sheet')
    const sheet = await stillsSheet([await frame('#204060'), await frame('#c08040'), await frame('#40a060')])
    expect(sheet).toMatchObject({ mediaType: 'image/jpeg' })
    // Three 16:9 frames, two columns, the width binding: the sheet is wider than tall.
    expect(sheet!.width).toBeGreaterThan(sheet!.height)
    const one = await stillsSheet([await frame('#204060')])
    expect(one).toMatchObject({ mediaType: 'image/jpeg', width: 320, height: 180 })
    expect(await stillsSheet([Buffer.from('not an image')])).toBeNull()
  })
})

describe('a Studio that is not set up on the server', () => {
  it('reads to the agent as a refusal that says so and says not to retry', () => {
    const answer = studioRefusal(notSetUpError())
    expect(answer).toMatchObject({ success: false, code: 'STUDIO_NOT_SET_UP' })
    expect(answer.error).toMatch(/not set up on this server/)
    expect(answer.error).toMatch(/Do not retry/)
    expect(answer.error).not.toMatch(/Try again/)
  })
})
