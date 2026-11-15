/**
 * The files a form takes (../files.ts): a kind is decided by the name's
 * extension, the declared type and the leading bytes together, so a page, a
 * picture or a program in disguise is refused; names are cleaned; the limits
 * hold; and where a file is stored is never the sender's choice.
 */
import { describe, expect, it } from 'vitest'
import { checkFormFiles, cleanFileName, decideFileKind, formFilePath, OFFICE_RELS_MAX, OFFICE_UNPACKED_MAX, zipEntries, zipEntryNames, type UploadedPart } from '../files'
import { FORM_FILE_EXTENSIONS, FORM_FILE_LIMITS, FORM_FILES_KEY } from '../types'
import { bytesOf, DOCX, GIF, HEIC, JPEG, PDF, PNG, PPTX, WEBP, XLSX, zipOf, zipWith, type ZipFixtureEntry } from './zip-fixture'

const FIELD = { key: FORM_FILES_KEY, label: 'Photos', required: false }
const part = (name: string, type: string, bytes: Uint8Array): UploadedPart => ({ name, type, size: bytes.length, bytes })

describe('the kinds a form takes', () => {
  it.each([
    ['rug.png', 'image/png', PNG, 'image/png', 'image'],
    ['rug.JPG', 'image/jpeg', JPEG, 'image/jpeg', 'image'],
    ['rug.jpeg', '', JPEG, 'image/jpeg', 'image'],
    ['rug.gif', 'image/gif', GIF, 'image/gif', 'image'],
    ['rug.webp', 'image/webp', WEBP, 'image/webp', 'image'],
    ['rug.heic', 'application/octet-stream', HEIC, 'image/heic', 'image'],
    ['quote.pdf', 'application/pdf', PDF, 'application/pdf', 'document'],
    ['notes.txt', 'text/plain', bytesOf('Two rugs, one stained.\n'), 'text/plain', 'document'],
    ['sizes.csv', 'application/vnd.ms-excel', bytesOf('room,width\nhall,2.5\n'), 'text/csv', 'document'],
    ['brief.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', DOCX, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'document'],
    ['sheet.xlsx', 'application/zip', XLSX, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'document'],
    ['deck.pptx', '', PPTX, 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'document'],
  ])('%s (%s) is taken, stored as its kind’s own type', (name, declared, bytes, mime, category) => {
    expect(decideFileKind(name, declared, bytes)).toEqual({ ok: true, ext: name.split('.').pop()!.toLowerCase(), mime, category })
  })

  it('a .png that is really a web page is refused, whatever it declares', () => {
    const page = bytesOf('<!doctype html><script>alert(1)</script>')
    expect(decideFileKind('rug.png', 'image/png', page)).toEqual({ ok: false, error: '"rug.png" isn\'t what its name says it is.' })
    expect(decideFileKind('rug.png', '', page).ok).toBe(false)
  })

  it('a real picture that declares itself a page is refused', () => {
    expect(decideFileKind('rug.png', 'text/html', PNG).ok).toBe(false)
    expect(decideFileKind('rug.png', 'image/svg+xml', PNG).ok).toBe(false)
  })

  it.each(['drawing.svg', 'page.html', 'page.htm', 'script.js', 'run.exe', 'all.zip', 'doc.docm', 'old.doc', 'shell.sh', 'noext', 'data.json', 'page.xml'])('%s is not a kind a form takes', (name) => {
    const result = decideFileKind(name, 'application/octet-stream', bytesOf('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("isn't a kind of file this form takes")
  })

  it('an SVG named .png is refused (it is markup, not a picture)', () => {
    expect(decideFileKind('logo.png', 'image/png', bytesOf('<svg onload="alert(1)"/>')).ok).toBe(false)
  })

  it('text that starts like a page, holds control characters or is not UTF-8 is refused', () => {
    expect(decideFileKind('notes.txt', 'text/plain', bytesOf('  \n<html><body>hi</body></html>')).ok).toBe(false)
    expect(decideFileKind('notes.txt', 'text/plain', bytesOf([0xef, 0xbb, 0xbf], '<script>x</script>')).ok).toBe(false)
    expect(decideFileKind('notes.txt', 'text/plain', bytesOf('a', [0], 'b')).ok).toBe(false)
    expect(decideFileKind('notes.txt', 'text/plain', bytesOf([0xff, 0xfe, 0x41])).ok).toBe(false)
    expect(decideFileKind('notes.txt', 'text/plain', bytesOf('Tabs\tand\r\nlines are text.')).ok).toBe(true)
  })

  it('a zip named .docx without Word’s own parts is refused, and so is one with VBA code or a program in it', () => {
    expect(decideFileKind('brief.docx', '', zipOf(['readme.txt'])).ok).toBe(false)
    expect(decideFileKind('brief.docx', '', XLSX).ok).toBe(false)
    expect(decideFileKind('brief.docx', '', zipOf(['[Content_Types].xml', 'word/document.xml', 'word/vbaProject.bin'])).ok).toBe(false)
    expect(decideFileKind('brief.docx', '', zipOf(['[Content_Types].xml', 'word/document.xml', 'word/embeddings/setup.exe'])).ok).toBe(false)
    expect(decideFileKind('brief.docx', '', zipOf(['[Content_Types].xml', 'word/document.xml', '../evil.xml'])).ok).toBe(false)
    expect(decideFileKind('brief.docx', '', zipOf(['[Content_Types].xml', 'word/document.xml'], { encrypted: true })).ok).toBe(false)
    expect(decideFileKind('brief.docx', '', PDF).ok).toBe(false)
  })

  it('reads a zip’s directory, and nothing that is not one', () => {
    expect(zipEntryNames(DOCX)).toEqual(['[Content_Types].xml', '_rels/.rels', 'word/document.xml'])
    expect(zipEntryNames(PNG)).toBeNull()
    expect(zipEntryNames(DOCX.slice(0, DOCX.length - 10))).toBeNull()
  })

  it('every extension the page offers is one the server knows', () => {
    for (const ext of FORM_FILE_EXTENSIONS) {
      const result = decideFileKind(`x.${ext}`, '', new Uint8Array(0))
      // Nothing passes on no bytes, but none is refused as an unknown kind.
      if (!result.ok) expect(result.error).not.toContain("isn't a kind")
    }
  })
})

describe('a file’s name', () => {
  it.each([
    ['../../etc/passwd.png', 'passwd.png'],
    ['C:\\Users\\sam\\Desktop\\rug.jpg', 'rug.jpg'],
    ['...hidden.png', 'hidden.png'],
    ['  rug\u0000 photo\u202e.png  ', 'rug photo.png'],
    ['bad"name;<x>.pdf', 'bad_name__x_.pdf'],
    ['line\nbreak.txt', 'line break.txt'],
  ])('%j is stored as %j', (raw, clean) => {
    expect(cleanFileName(raw)).toBe(clean)
  })

  it('is clipped with its extension kept, and nothing at all is no name', () => {
    const long = `${'a'.repeat(300)}.pdf`
    const clipped = cleanFileName(long)!
    expect(clipped.length).toBeLessThanOrEqual(FORM_FILE_LIMITS.name)
    expect(clipped.endsWith('.pdf')).toBe(true)
    expect(cleanFileName('../..')).toBeNull()
    expect(cleanFileName('   ')).toBeNull()
    expect(cleanFileName(42)).toBeNull()
  })
})

describe('a submission’s files', () => {
  it('passes good files with their cleaned names', () => {
    const out = checkFormFiles(FIELD, [part('../rug.png', 'image/png', PNG), part('quote.pdf', 'application/pdf', PDF)])
    expect(out).toMatchObject({ ok: true, files: [{ name: 'rug.png', ext: 'png', mime: 'image/png', size: PNG.length }, { name: 'quote.pdf', mime: 'application/pdf' }] })
  })

  it('none is fine unless the field is required', () => {
    expect(checkFormFiles(FIELD, [])).toEqual({ ok: true, files: [] })
    expect(checkFormFiles({ ...FIELD, required: true }, [])).toEqual({ ok: false, error: 'Photos is required.' })
  })

  it('refuses more than the most a submission takes', () => {
    const six = Array.from({ length: FORM_FILE_LIMITS.maxFiles + 1 }, (_, i) => part(`rug-${i}.png`, 'image/png', PNG))
    expect(checkFormFiles(FIELD, six)).toEqual({ ok: false, error: `Send at most ${FORM_FILE_LIMITS.maxFiles} files.` })
  })

  it('refuses an empty file and one over the size a file may be', () => {
    expect(checkFormFiles(FIELD, [part('empty.png', 'image/png', new Uint8Array(0))])).toEqual({ ok: false, error: '"empty.png" is empty.' })
    expect(checkFormFiles(FIELD, [{ name: 'huge.png', type: 'image/png', size: FORM_FILE_LIMITS.maxBytes + 1, bytes: null }])).toEqual({ ok: false, error: '"huge.png" is larger than 10 MB.' })
  })

  it('refuses the whole submission when one file is wrong', () => {
    const out = checkFormFiles(FIELD, [part('rug.png', 'image/png', PNG), part('rug2.png', 'image/png', bytesOf('<html>'))])
    expect(out.ok).toBe(false)
  })

  it('a file with no name left is refused', () => {
    expect(checkFormFiles(FIELD, [part('/', 'image/png', PNG)])).toEqual({ ok: false, error: 'Each file needs a name.' })
  })
})

describe('where a file is stored', () => {
  it('under forms/, by workspace and form, named by a random id and its kind’s extension, never the sender’s name', () => {
    expect(formFilePath('ws-1', 'form-1', '0f1e2d3c-0000-4000-8000-000000000001', 'png')).toBe('forms/ws-1/form-1/0f1e2d3c-0000-4000-8000-000000000001.png')
  })
})

describe('Word, Excel and PowerPoint files that run or reach out', () => {
  const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
  const rels = (target: string, mode = '') => `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/attachedTemplate" Target="${target}"${mode}/></Relationships>`
  const docx = (more: ZipFixtureEntry[] = []) =>
    zipWith([{ name: '[Content_Types].xml', data: '<Types/>', deflate: true }, { name: '_rels/.rels', data: rels('word/document.xml'), deflate: true }, { name: 'word/document.xml', data: '<w:document/>', deflate: true }, ...more])
  const decide = (bytes: Uint8Array) => decideFileKind('brief.docx', '', bytes)

  it('a plain document with inside relationships passes', () => {
    expect(decide(docx([{ name: 'word/_rels/document.xml.rels', data: rels('styles.xml'), deflate: true }])).ok).toBe(true)
    expect(decide(docx([{ name: 'word/_rels/document.xml.rels', data: rels('styles.xml') }])).ok).toBe(true)
  })

  it.each([
    ['anything under embeddings/', 'word/embeddings/oleObject1.xlsx'],
    ['anything under activeX/', 'word/activeX/activeX1.xml'],
    ['an ActiveX control in another case', 'xl/ActiveX/activeX1.xml'],
    ['any binary part', 'word/printerSettings/printerSettings1.bin'],
    ['VBA code', 'word/vbaProject.bin'],
  ])('%s is refused, saying why', (_, name) => {
    const result = decide(docx([{ name, data: 'x' }]))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('macros, embedded objects or links to outside files')
  })

  it('a relationship to an outside target is refused: stored or deflated, quoted either way, or disguised by character references', () => {
    for (const mode of [' TargetMode="External"', " TargetMode='External'", ' TargetMode = "External"', ' TargetMode="&#69;xternal"', ' TargetMode="&#x45;xternal"']) {
      for (const deflate of [true, false]) {
        const bytes = docx([{ name: 'word/_rels/settings.xml.rels', data: rels('https://templates.example/evil.dotm', mode), deflate }])
        expect(decide(bytes).ok, `${mode} ${deflate}`).toBe(false)
      }
    }
  })

  it('an ordinary link a reader clicks is fine (a web or mail address in a hyperlink relationship); any other outside target beside it is not', () => {
    const rel = (type: string, target: string) => `<Relationship Id="r" Type="${REL}/${type}" Target="${target}" TargetMode="External"/>`
    const file = (...inner: string[]) => docx([{ name: 'word/_rels/document.xml.rels', data: `<Relationships>${inner.join('')}</Relationships>`, deflate: true }])
    expect(decide(file(rel('hyperlink', 'https://brightweave.example'))).ok).toBe(true)
    expect(decide(file(rel('hyperlink', 'mailto:sam@brightweave.example'), rel('hyperlink', 'http://brightweave.example/cv'))).ok).toBe(true)
    // A hyperlink to a file or another scheme, a remote template, a linked image, or a link beside one of those.
    expect(decide(file(rel('hyperlink', 'file:///C:/Windows/System32/calc.exe'))).ok).toBe(false)
    expect(decide(file(rel('hyperlink', 'ms-msdt:/id PCWDiagnostic'))).ok).toBe(false)
    expect(decide(file(rel('attachedTemplate', 'https://templates.example/evil.dotm'))).ok).toBe(false)
    expect(decide(file(rel('image', 'https://tracker.example/pixel.png'))).ok).toBe(false)
    expect(decide(file(rel('oleObject', 'https://brightweave.example/x'))).ok).toBe(false)
    expect(decide(file(rel('hyperlink', 'https://brightweave.example'), rel('attachedTemplate', 'https://templates.example/evil.dotm'))).ok).toBe(false)
  })

  it('a _rels part that can not be read as small UTF-8 text is refused (UTF-16, too large, damaged)', () => {
    const utf16 = new Uint8Array([0xff, 0xfe, ...[...rels('x', ' TargetMode="External"')].flatMap((c) => [c.charCodeAt(0), 0])])
    expect(decide(docx([{ name: 'word/_rels/document.xml.rels', data: utf16 }])).ok).toBe(false)
    expect(decide(docx([{ name: 'word/_rels/document.xml.rels', data: 'x'.repeat(OFFICE_RELS_MAX + 1), deflate: true }])).ok).toBe(false)
    // Declared deflated, but its bytes are no deflate stream.
    expect(decide(docx([{ name: 'word/_rels/document.xml.rels', data: 'not a deflate stream', method: 8 }])).ok).toBe(false)
    // A method this can't read.
    expect(decide(docx([{ name: 'word/_rels/document.xml.rels', data: rels('styles.xml'), method: 12 }])).ok).toBe(false)
  })

  it('a zip whose directory declares more unpacked than a document can be is refused before anything opens it', () => {
    const bomb = docx([{ name: 'word/media/image1.png', data: 'x', declaredSize: OFFICE_UNPACKED_MAX }])
    const result = decide(bomb)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('larger unpacked')
  })

  it('reads each entry with its declared sizes and method', () => {
    const entries = zipEntries(docx())!
    expect(entries.map((e) => [e.name, e.method, e.size])).toEqual([
      ['[Content_Types].xml', 8, 8],
      ['_rels/.rels', 8, rels('word/document.xml').length],
      ['word/document.xml', 8, 13],
    ])
  })
})

describe('a text file read in pieces', () => {
  it('a character split across pieces is still text, and a control character or markup after whitespace in any piece is not', () => {
    const big = 64 * 1024
    const split = bytesOf('a'.repeat(big - 1), '€ and more')
    expect(decideFileKind('notes.txt', 'text/plain', split).ok).toBe(true)
    expect(decideFileKind('notes.txt', 'text/plain', bytesOf('a'.repeat(big * 2), [0x01])).ok).toBe(false)
    expect(decideFileKind('notes.txt', 'text/plain', bytesOf(' '.repeat(big + 10), '<html>')).ok).toBe(false)
    expect(decideFileKind('notes.txt', 'text/plain', bytesOf('a'.repeat(big - 1), [0xe2, 0x82])).ok).toBe(false)
  })
})
