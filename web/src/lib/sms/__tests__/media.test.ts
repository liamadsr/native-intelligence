/**
 * Texted contact files (roadmap track G1): a spreadsheet or vCard sent as an
 * MMS is fetched from Twilio (only this account's media URLs), saved to the
 * person's chat uploads, and named for the agent; pictures stay unread.
 */
import { describe, expect, it, vi } from 'vitest'
import { isTwilioMediaUrl, mediaFromParams, saveTextedFiles, sniffExtension, textedFilesNote } from '../media'

const SID = 'AC123'
const url = (n: number) => `https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages/MM1/Media/ME${n}`

function storage() {
  const uploads: Array<{ path: string; bytes: Uint8Array }> = []
  return {
    uploads,
    client: {
      storage: {
        from: () => ({
          upload: vi.fn(async (path: string, bytes: Uint8Array) => {
            uploads.push({ path, bytes })
            return { data: { path }, error: null }
          }),
        }),
      },
    } as never,
  }
}

const ok = (body: string | Uint8Array) => new Response(typeof body === 'string' ? body : new Blob([body as BlobPart]), { status: 200 })

describe('texted files', () => {
  it('reads the media of a webhook form', () => {
    expect(mediaFromParams({ MediaUrl0: url(0), MediaContentType0: 'text/x-vcard; charset=utf-8', MediaUrl1: url(1), MediaContentType1: 'image/jpeg' }, 2)).toEqual([
      { url: url(0), contentType: 'text/x-vcard' },
      { url: url(1), contentType: 'image/jpeg' },
    ])
  })

  it("fetches only this account's Twilio media", () => {
    expect(isTwilioMediaUrl(url(0), SID)).toBe(true)
    expect(isTwilioMediaUrl(url(0).replace(SID, 'ACother'), SID)).toBe(false)
    expect(isTwilioMediaUrl('https://evil.example/2010-04-01/Accounts/AC123/Messages/x', SID)).toBe(false)
    expect(isTwilioMediaUrl(url(0).replace('https', 'http'), SID)).toBe(false)
  })

  it('tells files apart by their bytes when the type is vague', () => {
    expect(sniffExtension(new Uint8Array([0x50, 0x4b, 3, 4]))).toBe('xlsx')
    expect(sniffExtension(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]))).toBe('xls')
    expect(sniffExtension(new TextEncoder().encode('BEGIN:VCARD\n'))).toBe('vcf')
    expect(sniffExtension(new TextEncoder().encode('name,phone\n'))).toBe('csv')
  })

  it("saves contact files to the person's chat uploads with the account's credentials, and skips pictures", async () => {
    const db = storage()
    const fetchImpl = vi.fn(async () => ok('name,phone\nAna,6265550101\n'))
    const saved = await saveTextedFiles(
      db.client,
      { userId: 'user-1', media: [{ url: url(0), contentType: 'application/vnd.ms-excel' }, { url: url(1), contentType: 'image/png' }] },
      { fetch: fetchImpl as never, accountSid: SID, authToken: 'tok' },
    )
    expect(saved).toEqual([{ storagePath: expect.stringMatching(/^user-1\/chat-uploads\/[0-9a-f-]+\.csv$/), extension: 'csv' }])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const headers = (fetchImpl.mock.calls[0] as unknown as [string, { headers: Record<string, string> }])[1].headers
    expect(headers.Authorization).toBe(`Basic ${Buffer.from(`${SID}:tok`).toString('base64')}`)
    expect(db.uploads).toHaveLength(1)
    expect(textedFilesNote(saved)).toBe(`[They texted a spreadsheet (CSV): storage_path ${saved[0].storagePath}]`)
  })

  it('a file that cannot be fetched is left out, never thrown', async () => {
    const db = storage()
    const saved = await saveTextedFiles(db.client, { userId: 'user-1', media: [{ url: url(0), contentType: 'text/csv' }] }, { fetch: (async () => new Response('', { status: 404 })) as never, accountSid: SID, authToken: 'tok' })
    expect(saved).toEqual([])
  })
})
