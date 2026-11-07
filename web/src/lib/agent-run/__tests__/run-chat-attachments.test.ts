/**
 * The note a run chat's message carries per attached file (bots v4,
 * run-chat-attachments.ts): written by the turn builder, read back by the
 * replay as a chip. One line, its name made safe, its type from the
 * extension, and only a well-formed note reads as one.
 */
import { describe, it, expect } from 'vitest'
import { attachedFileMediaType, attachedFileNote, parseAttachedFileNote, ATTACHED_FILE_NOTE_PREFIX } from '../run-chat-attachments'

describe('the attached-file note', () => {
  it('round-trips a file’s name and type (the storage path stays in the note, out of the chip)', () => {
    const note = attachedFileNote({ fileName: 'Q3 notes.md', mediaType: 'text/markdown', storagePath: 'u1/chat-uploads/a.md' })
    expect(note).toBe('[attached file] "Q3 notes.md" (text/markdown) storage_path: u1/chat-uploads/a.md')
    expect(note.startsWith(ATTACHED_FILE_NOTE_PREFIX)).toBe(true)
    expect(parseAttachedFileNote(note)).toEqual({ filename: 'Q3 notes.md', mediaType: 'text/markdown' })
  })

  it('keeps a name to one safe line: no line breaks, quotes or angle brackets', () => {
    const note = attachedFileNote({ fileName: 'a\n"b" <c>.txt', mediaType: 'text/plain', storagePath: 'u1/chat-uploads/a.txt' })
    expect(note).toBe('[attached file] "a ’b’ ‹c›.txt" (text/plain) storage_path: u1/chat-uploads/a.txt')
    expect(note).not.toContain('\n')
    expect(parseAttachedFileNote(note)).toEqual({ filename: 'a ’b’ ‹c›.txt', mediaType: 'text/plain' })
  })

  it('only a well-formed note reads as one', () => {
    expect(parseAttachedFileNote('[attached file] "a.md"')).toBeNull()
    expect(parseAttachedFileNote('attached file "a.md" (text/markdown)')).toBeNull()
    expect(parseAttachedFileNote('[attached file] "a.md" (text/markdown) and more')).toBeNull()
    expect(parseAttachedFileNote('[attached file] "a.md" (text/markdown)')).toEqual({ filename: 'a.md', mediaType: 'text/markdown' })
  })

  it('names the type from the extension', () => {
    expect(attachedFileMediaType('md')).toBe('text/markdown')
    expect(attachedFileMediaType('CSV')).toBe('text/csv')
    expect(attachedFileMediaType('json')).toBe('application/json')
    expect(attachedFileMediaType('py')).toBe('text/plain')
  })
})
