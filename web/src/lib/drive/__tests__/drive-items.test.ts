import { describe, expect, it } from 'vitest'
import { driveTypeOf, itemFromChat, itemFromMail, itemFromUpload, mergeReady, sortDriveItems, type DriveItem } from '../drive-items'

const item = (key: string, createdAt: string, extra: Partial<DriveItem> = {}): DriveItem => ({
  key,
  source: 'upload',
  name: key,
  mimeType: null,
  size: null,
  type: 'other',
  createdAt,
  modifiedAt: createdAt,
  where: '',
  creator: {},
  ...extra,
})

describe('driveTypeOf', () => {
  it.each([
    ['a.pdf', 'pdf'],
    ['a.docx', 'document'],
    ['a.doc', 'document'],
    ['a.md', 'document'],
    ['a.xlsx', 'sheet'],
    ['a.xls', 'sheet'],
    ['a.pptx', 'slides'],
    ['a.key', 'slides'],
    ['a.png', 'image'],
    ['a.heic', 'image'],
    ['a.mp4', 'video'],
    ['a.mp3', 'audio'],
    ['a.zip', 'other'],
  ] as const)('%s → %s', (name, type) => expect(driveTypeOf(name)).toBe(type))
})

describe('the sources as items', () => {
  it('says where each file lives and who put it there', () => {
    const up = itemFromUpload({
      id: 'f1',
      file_name: 'Plan.pdf',
      file_size_bytes: 10,
      mime_type: 'application/pdf',
      file_extension: 'pdf',
      file_category: 'document',
      storage_path: 'u/p.pdf',
      thumbnail_path: null,
      created_at: '2026-11-20T10:00:00Z',
      parent: { type: 'project', id: 'p1', label: 'Website refresh' },
      user_id: 'u1',
    })
    expect(up).toMatchObject({ key: 'upload:f1', type: 'pdf', where: 'Project · Website refresh', creator: { userId: 'u1' } })
    const base = up.upload!
    expect(itemFromUpload({ ...base, parent: { type: 'drive', id: 'f1', label: 'Drive' } }).where).toBe('Drive · only you')
    expect(itemFromUpload({ ...base, parent: { type: 'drive', id: 'f1', label: 'Plans', folder: { id: 'fo', name: 'Plans' } } }).where).toBe('Folder · Plans')
    const chat = itemFromChat({ key: 'c/u/a.png', name: 'a.png', size: 1, mimeType: 'image/png', createdAt: '2026-11-21T10:00:00Z', messageId: 'm', authorMemberId: 'mem1', channel: { id: 'c', kind: 'channel', name: 'design' } })
    expect(chat).toMatchObject({ source: 'team_chat', where: '#design', creator: { memberId: 'mem1' }, type: 'image' })
    expect(itemFromChat({ ...chat.chat!, channel: { id: 'c', kind: 'dm', name: null } }).where).toBe('Direct message')
    const mail = itemFromMail({
      key: 'a:m:x.xlsx',
      accountId: 'a',
      provider: 'google',
      threadId: 't',
      messageId: 'm',
      name: 'x.xlsx',
      mimeType: 'application/octet-stream',
      size: 5,
      subject: ' ',
      fromName: null,
      fromEmail: 'bo@example.com',
      date: '2026-11-22T10:00:00Z',
      href: '/x',
    })
    expect(mail).toMatchObject({ source: 'email', where: '(no subject)', creator: { label: 'bo@example.com' }, type: 'sheet' })
  })
})

describe('sortDriveItems', () => {
  const items = [item('b', '2026-11-20T00:00:00Z', { size: 5 }), item('a', '2026-11-22T00:00:00Z', { size: 1 }), item('c10', '2026-11-21T00:00:00Z'), item('c9', '2026-11-21T00:00:00Z', { size: 9 })]
  it('sorts newest first, by name (numbers in order), or largest first', () => {
    expect(sortDriveItems(items, 'created').map((i) => i.key)).toEqual(['a', 'c10', 'c9', 'b'])
    expect(sortDriveItems(items, 'name').map((i) => i.key)).toEqual(['a', 'b', 'c9', 'c10'])
    expect(sortDriveItems(items, 'size').map((i) => i.key)).toEqual(['c9', 'b', 'a', 'c10'])
  })

  it('sorts by last change, and by last opened with never-opened files after', () => {
    const changed = [item('x', '2026-11-01T00:00:00Z', { modifiedAt: '2026-11-30T00:00:00Z' }), item('y', '2026-11-20T00:00:00Z')]
    expect(sortDriveItems(changed, 'modified').map((i) => i.key)).toEqual(['x', 'y'])
    const opened = [item('p', '2026-11-22T00:00:00Z'), item('q', '2026-11-01T00:00:00Z', { openedAt: '2026-11-23T00:00:00Z' }), item('r', '2026-11-02T00:00:00Z', { openedAt: '2026-11-21T00:00:00Z' })]
    expect(sortDriveItems(opened, 'opened').map((i) => i.key)).toEqual(['q', 'r', 'p'])
  })
})

describe('mergeReady', () => {
  it('shows only what no source’s next page could come before', () => {
    const uploads = { items: [item('u1', '2026-11-22T00:00:00Z'), item('u2', '2026-11-10T00:00:00Z')], more: false }
    const chat = { items: [item('c1', '2026-11-21T00:00:00Z'), item('c2', '2026-11-15T00:00:00Z')], more: true }
    const { ready, held } = mergeReady([uploads, chat])
    expect(ready.map((i) => i.key)).toEqual(['u1', 'c1', 'c2'])
    expect(held.map((i) => i.key)).toEqual(['u2'])
  })

  it('with nothing more to read, shows everything; a source with more but nothing yet holds all', () => {
    expect(mergeReady([{ items: [item('x', '2026-11-01T00:00:00Z')], more: false }]).ready).toHaveLength(1)
    expect(mergeReady([{ items: [item('x', '2026-11-01T00:00:00Z')], more: false }, { items: [], more: true }]).ready).toHaveLength(0)
  })
})
