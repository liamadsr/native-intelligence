import { describe, it, expect } from 'vitest'
import { dragHasFiles, filesFromTransfer, readAttachmentsCaptureId } from '../dropped-files'

function transfer(init: { types?: string[]; files?: File[]; items?: { kind: string; file: File | null }[] }): DataTransfer {
  return {
    types: init.types ?? ['Files'],
    files: init.files ?? [],
    items: (init.items ?? []).map((i) => ({ kind: i.kind, getAsFile: () => i.file })),
  } as unknown as DataTransfer
}

describe('dragHasFiles', () => {
  it('is true only for a drag that carries files', () => {
    expect(dragHasFiles(transfer({ types: ['Files'] }))).toBe(true)
    expect(dragHasFiles(transfer({ types: ['text/plain', 'text/uri-list'] }))).toBe(false)
    expect(dragHasFiles(null)).toBe(false)
  })
})

describe('filesFromTransfer', () => {
  it('takes the files list as it is', () => {
    const shot = new File(['x'], 'Screenshot 2026-10-27 at 3.14.15 PM.png', { type: 'image/png' })
    expect(filesFromTransfer(transfer({ files: [shot] }))).toEqual([shot])
  })

  it('reads the items when the files list is empty (a screenshot thumbnail drag)', () => {
    const shot = new File(['x'], 'shot.png', { type: 'image/png' })
    const files = filesFromTransfer(
      transfer({ items: [{ kind: 'string', file: null }, { kind: 'file', file: shot }, { kind: 'file', file: null }] }),
    )
    expect(files).toEqual([shot])
  })

  it('names a nameless file after its type, so it keeps an extension', () => {
    const [png, svg] = filesFromTransfer(
      transfer({ files: [new File(['x'], '', { type: 'image/png' }), new File(['<svg/>'], '', { type: 'image/svg+xml' })] }),
    )
    expect(png.name).toMatch(/^screenshot-\d+\.png$/)
    expect(svg.name).toMatch(/^screenshot-\d+-1\.svg$/)
    expect(svg.type).toBe('image/svg+xml')
  })

  it('is empty without a transfer', () => {
    expect(filesFromTransfer(null)).toEqual([])
    expect(filesFromTransfer(transfer({}))).toEqual([])
  })
})

describe('readAttachmentsCaptureId', () => {
  it('reads a capture id, and nothing else', () => {
    expect(readAttachmentsCaptureId({ captureId: 'cap-1' })).toBe('cap-1')
    expect(readAttachmentsCaptureId({ captureId: '' })).toBeNull()
    expect(readAttachmentsCaptureId({ captureId: 4 })).toBeNull()
    expect(readAttachmentsCaptureId(null)).toBeNull()
  })
})
