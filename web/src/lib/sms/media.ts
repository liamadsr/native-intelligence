/**
 * Files the owner texts their agent (roadmap track G1): a spreadsheet (CSV,
 * Excel) or phone contacts (vCard) sent as an MMS. Pictures are still not
 * read. A contact file is fetched from Twilio once, as the webhook handles the
 * text, and saved to the person's own chat-uploads folder, the same place a
 * chat upload lands; the text the agent reads then names it by its
 * storage_path, and the import tools read it from there.
 *
 * Only Twilio's own media URLs are fetched (https, api.twilio.com, this
 * account's messages), with the account's credentials; the redirect to the
 * file itself drops them (a cross-origin redirect). At most 10 MB a file and
 * three files a text.
 */
import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { MAX_CHAT_UPLOAD_BYTES } from '@/lib/chat/upload-allowlist'
import { twilioConfig } from '@/lib/twilio/config'

export interface InboundMedia {
  url: string
  contentType: string
}

/** The media of a Twilio webhook's form: MediaUrl0, MediaContentType0, … */
export function mediaFromParams(params: Record<string, string>, numMedia: number): InboundMedia[] {
  const out: InboundMedia[] = []
  for (let i = 0; i < Math.min(numMedia, 10); i++) {
    const url = params[`MediaUrl${i}`]
    if (url) out.push({ url, contentType: (params[`MediaContentType${i}`] ?? '').toLowerCase().split(';')[0].trim() })
  }
  return out
}

/** Content types a contacts file arrives as, and the extension each is stored under ('sniff': read the bytes). */
const CONTACT_FILE_TYPES: Record<string, 'csv' | 'tsv' | 'xlsx' | 'vcf' | 'sniff'> = {
  'text/vcard': 'vcf',
  'text/x-vcard': 'vcf',
  'text/directory': 'vcf',
  'text/csv': 'csv',
  'text/comma-separated-values': 'csv',
  'application/csv': 'csv',
  'text/tab-separated-values': 'tsv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  // Windows names a CSV this, and so does the old .xls: the bytes say which.
  'application/vnd.ms-excel': 'sniff',
  'application/octet-stream': 'sniff',
  'text/plain': 'sniff',
}

/** True when a text's media item may be a contacts file (not a picture). */
export function isContactFileMedia(media: InboundMedia): boolean {
  return media.contentType in CONTACT_FILE_TYPES
}

/** What a file is from its first bytes: a zip (xlsx), an old Office file (xls), a vCard, or text (csv). */
export function sniffExtension(bytes: Uint8Array): 'xlsx' | 'xls' | 'vcf' | 'csv' {
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return 'xlsx'
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) return 'xls'
  const head = new TextDecoder('utf-8').decode(bytes.slice(0, 200))
  return /^\s*(﻿)?BEGIN:VCARD/i.test(head) ? 'vcf' : 'csv'
}

/** Only this account's Twilio media URLs are fetched. */
export function isTwilioMediaUrl(url: string, accountSid: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && u.hostname === 'api.twilio.com' && u.pathname.startsWith(`/2010-04-01/Accounts/${accountSid}/Messages/`)
  } catch {
    return false
  }
}

export interface SavedTextedFile {
  storagePath: string
  extension: 'csv' | 'tsv' | 'xlsx' | 'xls' | 'vcf'
}

/** Seams for the tests. */
export interface TextedFileDeps {
  fetch?: typeof fetch
  accountSid?: string
  authToken?: string
}

/**
 * Fetch a text's contact files and save them to the person's chat-uploads
 * folder. A file that can't be fetched or saved is left out (logged, never
 * thrown): the text still reaches the agent.
 */
export async function saveTextedFiles(supabase: SupabaseClient, args: { userId: string; media: InboundMedia[] }, deps: TextedFileDeps = {}): Promise<SavedTextedFile[]> {
  const files = args.media.filter(isContactFileMedia).slice(0, 3)
  if (files.length === 0) return []
  const config = twilioConfig()
  const accountSid = deps.accountSid ?? config?.accountSid
  const authToken = deps.authToken ?? config?.authToken
  if (!accountSid || !authToken) return []
  const doFetch = deps.fetch ?? fetch
  const saved: SavedTextedFile[] = []
  for (const media of files) {
    if (!isTwilioMediaUrl(media.url, accountSid)) continue
    try {
      const res = await doFetch(media.url, { headers: { Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}` } })
      if (!res.ok) throw new Error(`media fetch ${res.status}`)
      const declared = Number(res.headers.get('content-length') ?? '0')
      if (declared > MAX_CHAT_UPLOAD_BYTES) throw new Error('media over 10 MB')
      const bytes = new Uint8Array(await res.arrayBuffer())
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_CHAT_UPLOAD_BYTES) throw new Error('media empty or over 10 MB')
      const typed = CONTACT_FILE_TYPES[media.contentType]
      const extension = typed === 'sniff' ? sniffExtension(bytes) : typed
      const storagePath = `${args.userId}/chat-uploads/${randomUUID()}.${extension}`
      const { error } = await supabase.storage.from('attachments').upload(storagePath, bytes, { contentType: media.contentType || 'application/octet-stream', upsert: false })
      if (error) throw new Error(`storage upload failed: ${error.message}`)
      saved.push({ storagePath, extension })
    } catch (err) {
      console.warn('[sms-media] a texted file was not saved:', err instanceof Error ? err.message : err)
    }
  }
  return saved
}

const KIND_WORDS: Record<SavedTextedFile['extension'], string> = {
  csv: 'a spreadsheet (CSV)',
  tsv: 'a spreadsheet (TSV)',
  xlsx: 'a spreadsheet (Excel)',
  xls: 'an old Excel file (.xls)',
  vcf: 'phone contacts (vCard)',
}

/** The lines the agent reads for the files a text carried. */
export function textedFilesNote(files: readonly SavedTextedFile[]): string {
  return files.map((f) => `[They texted ${KIND_WORDS[f.extension]}: storage_path ${f.storagePath}]`).join('\n')
}
