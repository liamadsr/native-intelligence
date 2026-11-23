import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { hasIndexableChatFiles, indexTeamChatMessageFiles } from '../chat-file-text'

const CH = 'c4a00000-0000-4000-8000-000000000001'
const MSG = '3e550000-0000-4000-8000-000000000001'

function service(message: unknown, files: Record<string, string>) {
  const log: Array<[string, ...unknown[]]> = []
  const client = {
    from: (table: string) => {
      const q: Record<string, (...a: unknown[]) => unknown> = {}
      q.select = () => q
      q.eq = (...a: unknown[]) => (log.push(['eq', table, ...a]), q)
      q.maybeSingle = async () => ({ data: message, error: null })
      q.delete = () => (log.push(['delete', table]), q)
      q.insert = async (rows: unknown) => (log.push(['insert', table, rows]), { error: null })
      // A delete's chain ends at eq: make it thenable.
      ;(q as unknown as { then: unknown }).then = (resolve: (v: unknown) => void) => resolve({ error: null })
      return q
    },
    storage: {
      from: (bucket: string) => ({
        download: async (path: string) => {
          log.push(['download', bucket, path])
          return path in files ? { data: new Blob([files[path]]), error: null } : { data: null, error: { message: 'missing' } }
        },
      }),
    },
  }
  return { client: client as unknown as SupabaseClient, log }
}

describe('indexTeamChatMessageFiles', () => {
  it('extracts each readable file of the message, chunks it, and replaces the message’s passages', async () => {
    const { client, log } = service(
      {
        id: MSG,
        channel_id: CH,
        workspace_id: 'ws1',
        deleted_at: null,
        attachments: [
          { path: `${CH}/u/brief.md`, name: 'brief.md', size: 10, type: 'text/markdown' },
          { path: `${CH}/u/shot.png`, name: 'shot.png', size: 10, type: 'image/png' },
          { path: 'other-channel/u/x.md', name: 'x.md', size: 10, type: 'text/markdown' },
        ],
      },
      { [`${CH}/u/brief.md`]: 'The Fernhill launch moves to spring.' },
    )
    const result = await indexTeamChatMessageFiles(client, MSG, { extract: async (bytes) => bytes.toString('utf8') })
    expect(result).toEqual({ indexed: 1, skipped: 2, chunks: 1 })
    expect(log.filter((l) => l[0] === 'download').map((l) => l[2])).toEqual([`${CH}/u/brief.md`])
    expect(log).toContainEqual(['download', 'team-chat-files', `${CH}/u/brief.md`])
    const deleteAt = log.findIndex((l) => l[0] === 'delete')
    const insertAt = log.findIndex((l) => l[0] === 'insert')
    expect(deleteAt).toBeGreaterThan(-1)
    expect(insertAt).toBeGreaterThan(deleteAt)
    expect(log[insertAt][2]).toEqual([
      { workspace_id: 'ws1', channel_id: CH, message_id: MSG, file_path: `${CH}/u/brief.md`, file_name: 'brief.md', chunk_index: 0, chunk_text: 'The Fernhill launch moves to spring.' },
    ])
  })

  it('does nothing for a message that is gone or deleted', async () => {
    expect(await indexTeamChatMessageFiles(service(null, {}).client, MSG)).toEqual({ indexed: 0, skipped: 0, chunks: 0, gone: true })
    const { client, log } = service({ id: MSG, channel_id: CH, workspace_id: 'ws1', deleted_at: '2026-11-23T00:00:00Z', attachments: [] }, {})
    expect((await indexTeamChatMessageFiles(client, MSG)).gone).toBe(true)
    expect(log.find((l) => l[0] === 'insert')).toBeUndefined()
  })

  it('keeps no passage for a file with no text', async () => {
    const { client, log } = service({ id: MSG, channel_id: CH, workspace_id: 'ws1', deleted_at: null, attachments: [{ path: `${CH}/u/scan.pdf`, name: 'scan.pdf', size: 1, type: 'application/pdf' }] }, { [`${CH}/u/scan.pdf`]: '%PDF' })
    expect(await indexTeamChatMessageFiles(client, MSG, { extract: async () => null })).toEqual({ indexed: 0, skipped: 1, chunks: 0 })
    expect(log.find((l) => l[0] === 'insert')).toBeUndefined()
  })

  it('says whether a message has files worth reading', () => {
    expect(hasIndexableChatFiles([{ name: 'a.png' }])).toBe(false)
    expect(hasIndexableChatFiles([{ name: 'a.png' }, { name: 'b.docx' }])).toBe(true)
    expect(hasIndexableChatFiles(null)).toBe(false)
  })
})
