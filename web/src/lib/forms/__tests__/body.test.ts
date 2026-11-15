/**
 * A form submission's body (../body.ts): capped before and while it is read
 * (the read stops at the cap, so no more is ever held), JSON and form
 * encoding at the quote intake's 32 KB, multipart bigger only for a form that
 * takes files, file parts kept with their names, types and bytes, and a
 * name posted twice read as a list.
 */
import { describe, expect, it } from 'vitest'
import { BODY_TOO_LARGE_FILES, BODY_TOO_LARGE_TEXT, BODY_UNREADABLE, boundaryOf, declaredLength, FORM_TEXT_BODY_MAX, FORM_UPLOAD_BODY_MAX, MULTIPART_PARTS_MAX, parseMultipart, readFormSubmission } from '../body'
import { FORM_FILE_LIMITS } from '../types'
import { PNG } from './zip-fixture'

const URL_ = 'https://nativeintelligence.dev/api/intake/forms/x'

/** A body that streams `chunks` chunks of `size` bytes with no Content-Length, counting how many were pulled. */
function streamed(chunks: number, size: number, type = 'application/json') {
  const pulled = { count: 0 }
  let sent = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= chunks) {
        controller.close()
        return
      }
      sent++
      pulled.count++
      controller.enqueue(new Uint8Array(size).fill(0x61))
    },
    cancel() {
      sent = chunks
    },
  })
  const request = new Request(URL_, { method: 'POST', headers: { 'content-type': type }, body, duplex: 'half' } as RequestInit)
  return { request, pulled }
}

const multipart = (form: FormData) => new Request(URL_, { method: 'POST', body: form })
/** The same body as plain bytes (a body the read stops part way through: as a server's request is, not a FormData stream). */
async function multipartBytes(form: FormData) {
  const encoded = new Response(form)
  const type = encoded.headers.get('content-type') ?? ''
  return new Request(URL_, { method: 'POST', headers: { 'content-type': type }, body: await encoded.arrayBuffer() })
}

describe('JSON and form encoding', () => {
  it('reads a JSON object, and refuses anything else as unreadable', async () => {
    const ok = await readFormSubmission(new Request(URL_, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'sam@rivera.example' }) }), { files: true })
    expect(ok).toEqual({ ok: true, fields: { email: 'sam@rivera.example' }, files: [], fileBytes: 0 })
    const list = await readFormSubmission(new Request(URL_, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '[1,2]' }), { files: false })
    expect(list).toMatchObject({ ok: false, status: 400 })
    const plain = await readFormSubmission(new Request(URL_, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'hi' }), { files: false })
    expect(plain).toMatchObject({ ok: false, status: 400 })
  })

  it('refuses a declared length over the cap before reading anything', async () => {
    const request = new Request(URL_, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(FORM_TEXT_BODY_MAX + 1) }, body: '{}' })
    expect(await readFormSubmission(request, { files: true })).toEqual({ ok: false, status: 413, error: BODY_TOO_LARGE_TEXT })
  })

  it('stops reading a body with no length the moment it passes the cap', async () => {
    const { request, pulled } = streamed(1000, 1024)
    expect(await readFormSubmission(request, { files: true })).toMatchObject({ ok: false, status: 413 })
    // 32 KB is 32 chunks of 1 KB: the read stopped right after, never near the 1000 sent.
    expect(pulled.count).toBeLessThan(40)
  })

  it('reads a name posted twice (a multi-select) as a list', async () => {
    const request = new Request(URL_, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'rooms=Kitchen&rooms=Hall&email=sam%40rivera.example' })
    expect(await readFormSubmission(request, { files: false })).toMatchObject({ ok: true, fields: { rooms: ['Kitchen', 'Hall'], email: 'sam@rivera.example' } })
  })
})

describe('multipart', () => {
  it('a form that takes files: its fields and its files, each with its name, declared type and bytes', async () => {
    const form = new FormData()
    form.append('email', 'sam@rivera.example')
    form.append('files', new File([PNG], 'rug.png', { type: 'image/png' }))
    form.append('files', new File([PNG], 'rug-2.png', { type: 'image/png' }))
    // A file input left empty sends a nameless empty part: not a file.
    form.append('files', new File([], '', { type: 'application/octet-stream' }))
    const read = await readFormSubmission(multipart(form), { files: true })
    expect(read).toMatchObject({ ok: true, fields: { email: 'sam@rivera.example' }, fileBytes: PNG.length * 2 })
    if (!read.ok) throw new Error('unread')
    expect(read.files.map((f) => [f.name, f.type, f.size])).toEqual([
      ['rug.png', 'image/png', PNG.length],
      ['rug-2.png', 'image/png', PNG.length],
    ])
    expect(Array.from(read.files[0].bytes!)).toEqual(Array.from(PNG))
  })

  it('a form without a files field ignores file parts, and keeps the 32 KB cap', async () => {
    const small = new FormData()
    small.append('email', 'sam@rivera.example')
    small.append('files', new File([PNG], 'rug.png', { type: 'image/png' }))
    expect(await readFormSubmission(multipart(small), { files: false })).toEqual({ ok: true, fields: { email: 'sam@rivera.example' }, files: [], fileBytes: 0 })
    const big = new FormData()
    big.append('email', 'sam@rivera.example')
    big.append('files', new File([new Uint8Array(FORM_TEXT_BODY_MAX + 10)], 'big.png', { type: 'image/png' }))
    expect(await readFormSubmission(await multipartBytes(big), { files: false })).toEqual({ ok: false, status: 413, error: BODY_TOO_LARGE_TEXT })
  })

  it('a file over a file’s limit is kept by its size alone, for the check to name it', async () => {
    const form = new FormData()
    form.append('files', new File([new Uint8Array(FORM_FILE_LIMITS.maxBytes + 1)], 'huge.png', { type: 'image/png' }))
    const read = await readFormSubmission(multipart(form), { files: true })
    expect(read).toMatchObject({ ok: true, files: [{ name: 'huge.png', size: FORM_FILE_LIMITS.maxBytes + 1, bytes: null }] })
  })

  it('refuses text parts over 32 KB even on a form that takes files', async () => {
    const form = new FormData()
    form.append('message', 'a'.repeat(FORM_TEXT_BODY_MAX + 1))
    expect(await readFormSubmission(multipart(form), { files: true })).toMatchObject({ ok: false, status: 413 })
  })

  it('refuses a body over every file at its largest, before reading, and while streaming', async () => {
    const declared = new Request(URL_, { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=x', 'content-length': String(FORM_UPLOAD_BODY_MAX + 1) }, body: '--x--' })
    expect(await readFormSubmission(declared, { files: true })).toEqual({ ok: false, status: 413, error: BODY_TOO_LARGE_FILES })
    const { request, pulled } = streamed(200, 1024 * 1024, 'multipart/form-data; boundary=x')
    expect(await readFormSubmission(request, { files: true })).toMatchObject({ ok: false, status: 413 })
    expect(pulled.count).toBeLessThan(60)
  })

  it('a damaged multipart body is unreadable', async () => {
    const request = new Request(URL_, { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=x' }, body: 'not a multipart body' })
    expect(await readFormSubmission(request, { files: true })).toMatchObject({ ok: false, status: 400 })
  })
})

describe('the multipart parse (../body.ts parseMultipart): what a browser sends, read without copying', () => {
  const encode = async (form: FormData) => {
    const encoded = new Request(URL_, { method: 'POST', body: form })
    return { bytes: new Uint8Array(await encoded.arrayBuffer()), type: encoded.headers.get('content-type') ?? '' }
  }

  it('reads names, values, file names (quotes, accents, other scripts) and types as the platform encodes them', async () => {
    const form = new FormData()
    form.append('name', 'Zoë Brontë')
    form.append('notes', 'line one\r\nline two "quoted"')
    form.append('size', 'S')
    form.append('size', 'M')
    form.append('files', new File([PNG], 'rug "front" é 地毯.png', { type: 'image/png' }))
    const { bytes, type } = await encode(form)
    const parts = parseMultipart(bytes, boundaryOf(type)!)!
    expect(parts.map((p) => [p.name, p.filename, p.type])).toEqual([
      ['name', null, ''],
      ['notes', null, ''],
      ['size', null, ''],
      ['size', null, ''],
      ['files', 'rug "front" é 地毯.png', 'image/png'],
    ])
    expect(new TextDecoder().decode(parts[1].body)).toBe('line one\r\nline two "quoted"')
    expect([...parts[4].body]).toEqual([...PNG])
    // A view into the one buffer, never a copy.
    expect(parts[4].body.buffer).toBe(bytes.buffer)
  })

  it('a file input left empty, a preamble, and an extended filename are read as browsers and RFC 7578 mean them', () => {
    const b = 'x-boundary-1'
    const raw =
      `ignored preamble\r\n--${b}\r\nContent-Disposition: form-data; name="files"; filename=""\r\nContent-Type: application/octet-stream\r\n\r\n\r\n` +
      `--${b}\r\nContent-Disposition: form-data; name="files"; filename="fallback.png"; filename*=utf-8''%E5%9C%B0%E6%AF%AF.png\r\nContent-Type: image/png\r\n\r\nPNG\r\n` +
      `--${b}--\r\nepilogue`
    const parts = parseMultipart(new TextEncoder().encode(raw), b)!
    expect(parts.map((p) => [p.filename, p.body.length])).toEqual([
      ['', 0],
      ['地毯.png', 3],
    ])
  })

  it('a body cut short, a part with no name, or more parts than a form takes is not read', () => {
    const b = 'x-boundary-2'
    const enc = new TextEncoder()
    expect(parseMultipart(enc.encode(`--${b}\r\nContent-Disposition: form-data; name="a"\r\n\r\nvalue`), b)).toBeNull()
    expect(parseMultipart(enc.encode(`--${b}\r\nContent-Disposition: form-data\r\n\r\nv\r\n--${b}--`), b)).toBeNull()
    expect(parseMultipart(enc.encode(`--${b}\r\nContent-Type: text/plain\r\n\r\nv\r\n--${b}--`), b)).toBeNull()
    const many = Array.from({ length: 4 }, (_, i) => `--${b}\r\nContent-Disposition: form-data; name="f${i}"\r\n\r\nv\r\n`).join('') + `--${b}--`
    expect(parseMultipart(enc.encode(many), b, 3)).toBeNull()
    expect(parseMultipart(enc.encode(many), b, 4)).toHaveLength(4)
  })

  it('a multipart body with no boundary is unreadable, and one with too many parts is refused', async () => {
    const noBoundary = new Request(URL_, { method: 'POST', headers: { 'content-type': 'multipart/form-data' }, body: 'x' })
    expect(await readFormSubmission(noBoundary, { files: true })).toEqual({ ok: false, status: 400, error: BODY_UNREADABLE })
    const form = new FormData()
    for (let i = 0; i <= MULTIPART_PARTS_MAX; i++) form.append('f', '')
    const { bytes, type } = await encode(form)
    const req = new Request(URL_, { method: 'POST', headers: { 'content-type': type, 'content-length': String(bytes.length) }, body: bytes })
    expect((await readFormSubmission(req, { files: true })).ok).toBe(false)
  })

  it("with a declared length the body fills one buffer of it; more bytes than it declared are refused, and the read stops", async () => {
    const form = new FormData()
    form.append('name', 'Sam')
    form.append('files', new File([PNG], 'rug.png', { type: 'image/png' }))
    const { bytes, type } = await encode(form)
    const ok = await readFormSubmission(new Request(URL_, { method: 'POST', headers: { 'content-type': type, 'content-length': String(bytes.length) }, body: bytes }), { files: true })
    expect(ok.ok && ok.files.map((f) => [f.name, f.size])).toEqual([['rug.png', PNG.length]])
    const pulled = { count: 0 }
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled.count++
        controller.enqueue(bytes)
        if (pulled.count > 50) controller.close()
      },
    })
    const lying = new Request(URL_, { method: 'POST', headers: { 'content-type': type, 'content-length': String(bytes.length) }, body, duplex: 'half' } as RequestInit)
    expect(await readFormSubmission(lying, { files: true })).toEqual({ ok: false, status: 413, error: BODY_TOO_LARGE_FILES })
    expect(pulled.count).toBeLessThan(5)
  })

  it('the declared length is read only when it is a plain number', () => {
    const at = (v: string | null) => declaredLength(new Request(URL_, { method: 'POST', headers: v === null ? {} : { 'content-length': v }, body: 'x' }))
    expect(at('120')).toBe(120)
    expect(at(null)).toBeNull()
    expect(at('12, 12')).toBeNull()
    expect(at('-1')).toBeNull()
  })
})
