/**
 * A submission with files (../submit.ts, migration 663): one multipart post
 * with the fields and the files; every earlier check first, in its order;
 * the files checked whole before the row is written; the byte caps; the
 * files stored only after the row, as its attachments; and a file that can't
 * be stored after the row exists never loses the row or the answer.
 * Made-up people.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DataColumn } from '@/lib/tables/types'
import { issueChallenge, solveChallenge } from '../challenge'
import type { CheckedFile } from '../files'
import { generateFormKey } from '../store'
import { CHALLENGE_REFUSED, handleFormSubmit, UPLOAD_BUSY, type FormSubmitDeps } from '../submit'
import { __resetUploadRoomForTests, FORM_UPLOAD_BYTES_IN_FLIGHT, FORM_UPLOADS_PER_SENDER, takeUploadRoom, uploadBytesInFlight } from '../upload-room'
import { FORM_FILE_LIMITS, FORM_FILES_KEY, FORM_TITLE_KEY, type DataForm } from '../types'
import { bytesOf, PDF, PNG } from './zip-fixture'

const KEY = generateFormKey()
const SECRET = 'test-secret'
const T0 = Date.parse('2026-11-15T12:00:00Z')
const NOW = T0 + 10_000

const col = (key: string, label: string, field_type: DataColumn['field_type']): DataColumn => ({ id: `col-${key}`, table_id: 't1', key, label, field_type, options: [], config: {}, position: 0, deleted_at: null })
const COLUMNS = [col('email', 'Email', 'email'), col('message', 'Message', 'text')]

const FORM: DataForm = {
  id: 'form-1',
  workspaceId: 'ws-1',
  tableId: 't1',
  name: 'Rug repairs',
  fields: [
    { key: FORM_TITLE_KEY, label: 'Name', required: true },
    { key: 'email', label: 'Email', required: true },
    { key: 'message', label: 'Message', required: false },
    { key: FORM_FILES_KEY, label: 'Photos', required: false },
  ],
  access: 'public',
  allowedOrigins: [],
  thanks: null,
  description: null,
  submitLabel: null,
  botCheck: true,
  active: true,
  keyPrefix: 'fk_abcdef',
  createdBy: 'user-owner',
  createdAt: '',
  updatedAt: '',
  lastSubmittedAt: null,
}

function deps(form: Partial<DataForm> = {}, over: Partial<FormSubmitDeps> = {}) {
  const live = { ...FORM, ...form }
  const log: string[] = []
  const step =
    <A extends unknown[], R>(name: string, value: (...a: A) => R) =>
    (...a: A) => {
      log.push(name)
      return value(...a)
    }
  const d = {
    findForm: vi.fn(step('key', async (k: string) => (k === KEY ? live : null))),
    clientKey: vi.fn(() => 'client-a'),
    memberOf: vi.fn(async () => 'member' as const),
    openAttempt: vi.fn(step('caps', async () => 'att-1')),
    countClientAttempts: vi.fn(async () => 0),
    countFormAttempts: vi.fn(async () => 0),
    recordUploadBytes: vi.fn(step('bytes recorded', async () => {})),
    columns: vi.fn(step('columns', async () => COLUMNS as DataColumn[] | null)),
    uploadBytesSince: vi.fn(step('byte caps', async () => 0)),
    claimAttempt: vi.fn(step('repeat', async () => ({ kind: 'new' }) as Awaited<ReturnType<FormSubmitDeps['claimAttempt']>>)),
    canWrite: vi.fn(step('maker', async () => true)),
    upsertContact: vi.fn(step('contact', async () => null as string | null)),
    writeRow: vi.fn(step('row', async () => ({ ok: true }) as Awaited<ReturnType<FormSubmitDeps['writeRow']>>)),
    storeFiles: vi.fn(step('files stored', async (_f: DataForm, _r: string, files: readonly CheckedFile[]) => ({ stored: files.length, failed: 0 }))),
    markStored: vi.fn(step('marked stored', async () => {})),
    releaseAttempt: vi.fn(async () => {}),
    challengeSecret: () => SECRET,
    now: () => NOW,
    newId: vi.fn(() => 'row-1'),
    ...over,
  } satisfies FormSubmitDeps
  return { d, log }
}

function solved() {
  const { token } = issueChallenge('form-1', T0, SECRET)
  return { _challenge: token, _answer: solveChallenge(token) }
}

const GOOD = { name: 'Sarah Lindqvist', email: 'sarah@lindqvist.example', message: 'Two rugs.' }

/** A multipart post as a browser sends it: the body encoded, with its Content-Length. */
async function post(fields: Record<string, string>, files: Array<{ name: string; type: string; bytes: Uint8Array<ArrayBuffer> }> = [], headers: Record<string, string> = {}) {
  const form = new FormData()
  for (const [k, v] of Object.entries(fields)) form.append(k, v)
  for (const f of files) form.append('files', new File([f.bytes], f.name, { type: f.type }))
  const encoded = new Request('https://nativeintelligence.dev/api/intake/forms/x', { method: 'POST', body: form })
  const bytes = new Uint8Array(await encoded.arrayBuffer())
  return new Request('https://nativeintelligence.dev/api/intake/forms/x', {
    method: 'POST',
    headers: { host: 'nativeintelligence.dev', 'content-type': encoded.headers.get('content-type') ?? '', 'content-length': String(bytes.length), ...headers },
    body: bytes,
  })
}
const PHOTO = { name: 'rug.png', type: 'image/png', bytes: PNG }

describe('a submission with files', () => {
  it('runs every check first in the existing order, writes the row, then stores the files, then marks the try stored', async () => {
    const { d, log } = deps()
    const res = await handleFormSubmit(await post({ ...GOOD, ...solved() }, [PHOTO, { name: 'quote.pdf', type: 'application/pdf', bytes: PDF }]), KEY, d)
    expect(res.status).toBe(201)
    expect(log).toEqual(['key', 'caps', 'bytes recorded', 'columns', 'byte caps', 'byte caps', 'byte caps', 'repeat', 'maker', 'contact', 'row', 'files stored', 'marked stored'])
    expect(d.recordUploadBytes).toHaveBeenCalledWith('att-1', PNG.length + PDF.length)
    const [form, rowId, files] = vi.mocked(d.storeFiles).mock.calls[0]
    expect(form.id).toBe('form-1')
    expect(rowId).toBe('row-1')
    expect(files.map((f) => [f.name, f.mime, f.size])).toEqual([
      ['rug.png', 'image/png', PNG.length],
      ['quote.pdf', 'application/pdf', PDF.length],
    ])
    // Files fill no column: the row is the fields alone.
    expect(vi.mocked(d.writeRow).mock.calls[0][1]).toEqual({ id: 'row-1', title: 'Sarah Lindqvist', values: { email: 'sarah@lindqvist.example', message: 'Two rugs.' } })
  })

  it('the bot check comes before the files: a post without it is refused and stores nothing', async () => {
    const { d } = deps()
    const res = await handleFormSubmit(await post(GOOD, [PHOTO]), KEY, d)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe(CHALLENGE_REFUSED)
    expect(d.storeFiles).not.toHaveBeenCalled()
    expect(d.writeRow).not.toHaveBeenCalled()
    // Its bytes were counted all the same.
    expect(d.recordUploadBytes).toHaveBeenCalled()
  })

  it('a field that does not fit is refused before the files are looked at', async () => {
    const { d, log } = deps()
    const res = await handleFormSubmit(await post({ ...GOOD, email: 'nope', ...solved() }, [{ name: 'rug.png', type: 'image/png', bytes: bytesOf('<html>') }]), KEY, d)
    expect(res.status).toBe(400)
    expect((await res.json()).error).not.toContain('rug.png')
    expect(log).not.toContain('byte caps')
  })

  it.each([
    ['a .png that is really a page', [{ name: 'rug.png', type: 'image/png', bytes: bytesOf('<!doctype html><script>alert(1)</script>') }], '"rug.png" isn\'t what its name says it is.'],
    ['an SVG', [{ name: 'logo.svg', type: 'image/svg+xml', bytes: bytesOf('<svg/>') }], 'isn\'t a kind of file this form takes'],
    ['an empty file', [{ name: 'rug.png', type: 'image/png', bytes: new Uint8Array(0) }], '"rug.png" is empty.'],
    ['too many files', Array.from({ length: FORM_FILE_LIMITS.maxFiles + 1 }, (_, i) => ({ ...PHOTO, name: `rug-${i}.png` })), `Send at most ${FORM_FILE_LIMITS.maxFiles} files.`],
  ])('%s is refused (400, naming it) and nothing is written', async (_, files, error) => {
    const { d } = deps()
    const res = await handleFormSubmit(await post({ ...GOOD, ...solved() }, files), KEY, d)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain(error)
    expect(d.claimAttempt).not.toHaveBeenCalled()
    expect(d.writeRow).not.toHaveBeenCalled()
    expect(d.storeFiles).not.toHaveBeenCalled()
  })

  it('a required files field left empty is refused', async () => {
    const { d } = deps({ fields: FORM.fields.map((f) => (f.key === FORM_FILES_KEY ? { ...f, required: true } : f)) })
    const res = await handleFormSubmit(await post({ ...GOOD, ...solved() }), KEY, d)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Photos is required.')
  })

  it('no files on a form whose files are optional: the row is stored and nothing is uploaded', async () => {
    const { d } = deps()
    expect((await handleFormSubmit(await post({ ...GOOD, ...solved() }), KEY, d)).status).toBe(201)
    expect(d.storeFiles).not.toHaveBeenCalled()
    expect(d.recordUploadBytes).not.toHaveBeenCalled()
  })

  it('past the workspace’s bytes for the day, across all its forms, it is 429 and nothing is written', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const asked: Array<[unknown, string]> = []
    const { d } = deps({}, {
      uploadBytesSince: vi.fn(async (by, sinceIso) => {
        asked.push([by, sinceIso])
        return 'workspaceId' in by ? FORM_FILE_LIMITS.workspaceBytesPerDay + 1 : 0
      }),
    })
    const res = await handleFormSubmit(await post({ ...GOOD, ...solved() }, [PHOTO]), KEY, d)
    expect(res.status).toBe(429)
    expect(d.writeRow).not.toHaveBeenCalled()
    expect(d.claimAttempt).not.toHaveBeenCalled()
    // A day back from now, for every form of the workspace.
    expect(asked).toContainEqual([{ workspaceId: 'ws-1' }, new Date(NOW - 24 * 60 * 60_000).toISOString()])
    expect(warn.mock.calls.some((c) => String(c[0]).includes('ALERT'))).toBe(true)
    warn.mockRestore()
  })

  it('past the sender’s bytes for the hour, or the form’s, it is 429 and nothing is written', async () => {
    const sender = deps({}, { uploadBytesSince: vi.fn(async (by) => ('clientHash' in by ? FORM_FILE_LIMITS.clientBytesPerHour + 1 : 0)) })
    const res = await handleFormSubmit(await post({ ...GOOD, ...solved() }, [PHOTO]), KEY, sender.d)
    expect(res.status).toBe(429)
    expect((await res.json()).error).toBe('Too many files from you right now. Try again in a little while.')
    expect(sender.d.writeRow).not.toHaveBeenCalled()
    const busy = deps({}, { uploadBytesSince: vi.fn(async (by) => ('formId' in by ? FORM_FILE_LIMITS.formBytesPerHour + 1 : 0)) })
    expect((await handleFormSubmit(await post({ ...GOOD, ...solved() }, [PHOTO]), KEY, busy.d)).status).toBe(429)
    expect(busy.d.writeRow).not.toHaveBeenCalled()
  })

  it('a byte cap that can’t be written or read is a hold, never an open door', async () => {
    const write = deps({}, { recordUploadBytes: vi.fn(async () => { throw new Error('down') }) })
    expect((await handleFormSubmit(await post({ ...GOOD, ...solved() }, [PHOTO]), KEY, write.d)).status).toBe(500)
    expect(write.d.writeRow).not.toHaveBeenCalled()
    const read = deps({}, { uploadBytesSince: vi.fn(async () => { throw new Error('down') }) })
    expect((await handleFormSubmit(await post({ ...GOOD, ...solved() }, [PHOTO]), KEY, read.d)).status).toBe(500)
    expect(read.d.writeRow).not.toHaveBeenCalled()
  })

  it('a file that can’t be stored after the row exists: the row stays, the answer is 201, and it is an ALERT', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const partly = deps({}, { storeFiles: vi.fn(async () => ({ stored: 1, failed: 1 })) })
    expect((await handleFormSubmit(await post({ ...GOOD, ...solved() }, [PHOTO, PHOTO]), KEY, partly.d)).status).toBe(201)
    expect(partly.d.markStored).toHaveBeenCalled()
    expect(partly.d.releaseAttempt).not.toHaveBeenCalled()
    const none = deps({}, { storeFiles: vi.fn(async () => { throw new Error('storage down') }) })
    const res = await handleFormSubmit(await post({ ...GOOD, ...solved() }, [PHOTO]), KEY, none.d)
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ ok: true, id: 'row-1' })
    expect(none.d.markStored).toHaveBeenCalled()
    expect(errors.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('ALERT'))).toHaveLength(2)
    errors.mockRestore()
  })

  it('a row that is not written stores no files', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { d } = deps({}, { writeRow: vi.fn(async () => ({ ok: false, reason: 'unavailable', error: 'down' }) as const) })
    expect((await handleFormSubmit(await post({ ...GOOD, ...solved() }, [PHOTO]), KEY, d)).status).toBe(500)
    expect(d.storeFiles).not.toHaveBeenCalled()
    errors.mockRestore()
  })

  it('a repeat of a stored submission is answered with its row and stores no files again', async () => {
    const { d } = deps({}, { claimAttempt: vi.fn(async () => ({ kind: 'repeat', rowId: 'row-0' }) as const) })
    const res = await handleFormSubmit(await post({ ...GOOD, submission_id: 'sub-1', ...solved() }, [PHOTO]), KEY, d)
    expect(res.status).toBe(200)
    expect(d.storeFiles).not.toHaveBeenCalled()
  })

  it('a bot that fills the honeypot is answered as stored, and nothing is uploaded', async () => {
    const { d } = deps()
    const res = await handleFormSubmit(await post({ ...GOOD, _gotcha: 'buy now', ...solved() }, [PHOTO]), KEY, d)
    expect(res.status).toBe(201)
    expect(d.storeFiles).not.toHaveBeenCalled()
    expect(d.writeRow).not.toHaveBeenCalled()
  })

  it('a body over every file at its largest is 413 before anything else reads it', async () => {
    const { d } = deps()
    const req = new Request('https://nativeintelligence.dev/api/intake/forms/x', {
      method: 'POST',
      headers: { host: 'nativeintelligence.dev', 'content-type': 'multipart/form-data; boundary=x', 'content-length': String(200 * 1024 * 1024) },
      body: '--x--',
    })
    const res = await handleFormSubmit(req, KEY, d)
    expect(res.status).toBe(413)
    expect(d.columns).not.toHaveBeenCalled()
  })

  it('a form without a files field ignores a file posted to it, as before', async () => {
    const { d } = deps({ fields: FORM.fields.filter((f) => f.key !== FORM_FILES_KEY), botCheck: false })
    const res = await handleFormSubmit(await post(GOOD, [PHOTO]), KEY, d)
    expect(res.status).toBe(201)
    expect(d.storeFiles).not.toHaveBeenCalled()
    expect(d.recordUploadBytes).not.toHaveBeenCalled()
  })

  it('a form that takes files without a file store takes no files (a hold)', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { d } = deps({}, { storeFiles: undefined })
    expect((await handleFormSubmit(await post({ ...GOOD, ...solved() }, [PHOTO]), KEY, d)).status).toBe(500)
    expect(d.writeRow).not.toHaveBeenCalled()
    errors.mockRestore()
  })
})

describe('the room for uploads in flight (../upload-room.ts)', () => {
  beforeEach(() => __resetUploadRoomForTests())

  it('an upload that declares no length is refused (411) before a byte is read, and holds no room', async () => {
    const { d } = deps()
    const form = new FormData()
    for (const [k, v] of Object.entries({ ...GOOD, ...solved() })) form.append(k, v)
    form.append('files', new File([PHOTO.bytes], PHOTO.name, { type: PHOTO.type }))
    const res = await handleFormSubmit(new Request('https://nativeintelligence.dev/api/intake/forms/x', { method: 'POST', headers: { host: 'nativeintelligence.dev' }, body: form }), KEY, d)
    expect(res.status).toBe(411)
    expect(d.recordUploadBytes).not.toHaveBeenCalled()
    expect(d.columns).not.toHaveBeenCalled()
    expect(uploadBytesInFlight()).toBe(0)
  })

  it('holds room by the declared length while the upload is read and stored, and gives it back when the request ends', async () => {
    let during = -1
    const { d } = deps({}, {
      storeFiles: vi.fn(async (_f: DataForm, _r: string, files: readonly CheckedFile[]) => {
        during = uploadBytesInFlight()
        return { stored: files.length, failed: 0 }
      }),
    })
    const req = await post({ ...GOOD, ...solved() }, [PHOTO])
    const declared = Number(req.headers.get('content-length'))
    expect((await handleFormSubmit(req, KEY, d)).status).toBe(201)
    expect(during).toBe(declared)
    expect(uploadBytesInFlight()).toBe(0)
  })

  it('gives the room back however the request ends: refused, or thrown', async () => {
    const refused = deps()
    expect((await handleFormSubmit(await post(GOOD, [PHOTO]), KEY, refused.d)).status).toBe(400)
    expect(uploadBytesInFlight()).toBe(0)
    const thrown = deps({}, { markStored: vi.fn(async () => { throw new Error('boom') }) })
    await expect(handleFormSubmit(await post({ ...GOOD, ...solved() }, [PHOTO]), KEY, thrown.d)).rejects.toThrow('boom')
    expect(uploadBytesInFlight()).toBe(0)
  })

  it('past the server’s room it is 503 "Try again in a moment." with Retry-After, and nothing is read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const held = takeUploadRoom(FORM_UPLOAD_BYTES_IN_FLIGHT - 100, 'someone-else')
    const { d } = deps()
    const res = await handleFormSubmit(await post({ ...GOOD, ...solved() }, [PHOTO]), KEY, d)
    expect(res.status).toBe(503)
    expect(res.headers.get('Retry-After')).toBe('5')
    expect((await res.json()).error).toBe(UPLOAD_BUSY)
    expect(d.recordUploadBytes).not.toHaveBeenCalled()
    expect(d.writeRow).not.toHaveBeenCalled()
    if (held.ok) held.release()
    // With the room back, the same upload goes through.
    expect((await handleFormSubmit(await post({ ...GOOD, ...solved() }, [PHOTO]), KEY, deps().d)).status).toBe(201)
    warn.mockRestore()
  })

  it(`a sender with ${FORM_UPLOADS_PER_SENDER} uploads in flight is 429 for another; another sender is not`, async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const mine = Array.from({ length: FORM_UPLOADS_PER_SENDER }, () => takeUploadRoom(1000, 'client-a'))
    const res = await handleFormSubmit(await post({ ...GOOD, ...solved() }, [PHOTO]), KEY, deps().d)
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('5')
    const other = deps({}, { clientKey: vi.fn(() => 'client-b') })
    expect((await handleFormSubmit(await post({ ...GOOD, ...solved() }, [PHOTO]), KEY, other.d)).status).toBe(201)
    for (const r of mine) if (r.ok) r.release()
    expect(uploadBytesInFlight()).toBe(0)
    warn.mockRestore()
  })

  it('a post to a form without files, or JSON to one with files, takes no room: the text cap bounds it', async () => {
    const held = takeUploadRoom(FORM_UPLOAD_BYTES_IN_FLIGHT, 'someone-else')
    const json = deps()
    const req = new Request('https://nativeintelligence.dev/api/intake/forms/x', { method: 'POST', headers: { host: 'nativeintelligence.dev', 'content-type': 'application/json' }, body: JSON.stringify({ ...GOOD, ...solved() }) })
    expect((await handleFormSubmit(req, KEY, json.d)).status).toBe(201)
    const noFiles = deps({ fields: FORM.fields.filter((f) => f.key !== FORM_FILES_KEY), botCheck: false })
    expect((await handleFormSubmit(await post(GOOD, [PHOTO]), KEY, noFiles.d)).status).toBe(201)
    if (held.ok) held.release()
  })
})
