/**
 * A message's link preview (../link-preview.ts): the first public http(s)
 * link in the words, asked for once (its event id dedupes a retry of the same
 * words), fetched by the SSRF-safe fetcher out of the request path, and
 * written only while the message is as it was read (an edit in between asks
 * again; a deleted message gets none). A page that says nothing, isn't HTML or
 * was refused leaves no preview. Only an https image the page names is kept.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'
import { PublicFetchError, type PublicPage } from '@/lib/link-preview/safe-fetch'

vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))

import { firstLink, linkPreviewEvent, previewOfPage, requestLinkPreview, TEAM_CHAT_LINK_PREVIEW_EVENT, writeLinkPreview } from '../link-preview'

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function page(html: string, over: Partial<PublicPage> = {}): PublicPage {
  return { url: 'https://news.example.test/story', status: 200, contentType: 'text/html', charset: 'utf-8', body: new TextEncoder().encode(html), truncated: false, ...over }
}
const HTML = `<html><head>
  <meta property="og:title" content="Fernhill opens a second studio" />
  <meta property="og:description" content="The design shop adds a space downtown." />
  <meta property="og:image" content="/img/studio.jpg" />
  <meta property="og:site_name" content="Example News" />
</head></html>`

describe('which link', () => {
  it('the first public http(s) link, without the sentence’s punctuation; none for a private one', () => {
    expect(firstLink('see https://news.example.test/story.')).toBe('https://news.example.test/story')
    expect(firstLink('(https://news.example.test/a_(b)) and http://other.example.test')).toBe('https://news.example.test/a_(b)')
    expect(firstLink('no links here')).toBeNull()
    expect(firstLink('http://169.254.169.254/latest then https://news.example.test/ok')).toBe('https://news.example.test/ok')
    expect(firstLink('ftp://news.example.test/file')).toBeNull()
  })

  it('asks once per version of the words: the event carries the message id only', async () => {
    const message = { id: ID, body: 'https://news.example.test/story', created_at: '2026-11-09T10:00:00Z', edited_at: null, link_preview: null }
    expect(linkPreviewEvent(message)).toEqual({ name: TEAM_CHAT_LINK_PREVIEW_EVENT, id: `team-chat-preview-${ID}-${Date.parse('2026-11-09T10:00:00Z')}`, data: { messageId: ID } })
    const send = vi.fn(async () => undefined)
    expect(await requestLinkPreview(message, { send })).toBe(true)
    expect(await requestLinkPreview({ ...message, body: 'no link' }, { send })).toBe(false)
    // An edit that took the link out still asks (its old preview goes).
    expect(await requestLinkPreview({ ...message, body: 'no link', link_preview: { url: 'x', site: 'x', title: 'x', description: null, image: null } }, { send })).toBe(true)
    expect(send).toHaveBeenCalledTimes(2)
  })
})

describe('the page as a preview', () => {
  it('its title, description, site and image (made absolute, https only)', () => {
    expect(previewOfPage('https://news.example.test/story', page(HTML))).toEqual({
      url: 'https://news.example.test/story',
      site: 'Example News',
      title: 'Fernhill opens a second studio',
      description: 'The design shop adds a space downtown.',
      image: 'https://news.example.test/img/studio.jpg',
    })
    const insecure = HTML.replace('/img/studio.jpg', 'http://news.example.test/i.jpg')
    expect(previewOfPage('https://news.example.test/story', page(insecure))?.image).toBeNull()
    const internal = HTML.replace('/img/studio.jpg', 'https://10.0.0.5/i.jpg')
    expect(previewOfPage('https://news.example.test/story', page(internal))?.image).toBeNull()
  })

  it('none for a page that isn’t HTML, failed, or says nothing about itself', () => {
    expect(previewOfPage('https://x.example.test', page(HTML, { contentType: 'application/pdf' }))).toBeNull()
    expect(previewOfPage('https://x.example.test', page(HTML, { status: 404 }))).toBeNull()
    expect(previewOfPage('https://x.example.test', page('<html><body>hi</body></html>'))).toBeNull()
  })
})

describe('writing it', () => {
  function db(row: Record<string, unknown>) {
    const tables = { team_chat_message: [{ id: ID, body: 'look https://news.example.test/story', deleted_at: null, link_preview: null, ...row }] }
    return { tables, svc: memoryDb(tables) as unknown as SupabaseClient }
  }

  it('fetches the first link and stores the preview on the message', async () => {
    const { tables, svc } = db({})
    const fetch = vi.fn(async () => page(HTML))
    expect(await writeLinkPreview(svc, ID, { fetch })).toBe('written')
    expect(fetch).toHaveBeenCalledWith('https://news.example.test/story')
    expect(tables.team_chat_message[0].link_preview).toMatchObject({ title: 'Fernhill opens a second studio', site: 'Example News' })
  })

  it('a refused or unreadable page leaves no preview; a deleted message is left alone', async () => {
    const refused = db({})
    expect(await writeLinkPreview(refused.svc, ID, { fetch: async () => Promise.reject(new PublicFetchError('resolves to an address that is not public')) })).toBe('unreadable')
    expect(refused.tables.team_chat_message[0].link_preview).toBeNull()
    const gone = db({ deleted_at: '2026-11-09T11:00:00Z' })
    const fetch = vi.fn(async () => page(HTML))
    expect(await writeLinkPreview(gone.svc, ID, { fetch })).toBe('gone')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('words that no longer hold a link lose their old preview', async () => {
    const { tables, svc } = db({ body: 'never mind', link_preview: { url: 'https://news.example.test/story', site: 's', title: 't', description: null, image: null } })
    expect(await writeLinkPreview(svc, ID, { fetch: vi.fn() })).toBe('cleared')
    expect(tables.team_chat_message[0].link_preview).toBeNull()
  })

  it('an edit while the page was being read: nothing written (the edit asks again)', async () => {
    const { tables, svc } = db({})
    const fetch = vi.fn(async () => {
      tables.team_chat_message[0].body = 'edited: https://other.example.test'
      return page(HTML)
    })
    expect(await writeLinkPreview(svc, ID, { fetch })).toBe('changed')
    expect(tables.team_chat_message[0].link_preview).toBeNull()
  })
})
