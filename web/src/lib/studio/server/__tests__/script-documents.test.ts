/**
 * Scripts and documents (script-documents.ts): a document becomes a script word for word, one beat per paragraph,
 * a heading naming the beat after it, only when the person may read it; a script becomes a new document named after
 * its video, indexed for search and linked to the video. Over the in-memory tables; the documents library's access
 * rule is stood in for by its contract (a private document is its creator's alone). Made-up words.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const indexed = vi.hoisted(() => [] as Array<{ id: string; content: string }>)
vi.mock('@/lib/ai/embeddings', () => ({
  indexDocument: vi.fn(async (_db: unknown, id: string, _user: string, _project: unknown, content: string) => void indexed.push({ id, content })),
}))
vi.mock('@/lib/documents/access', () => ({
  // loadDocumentAccess's contract: a document of the workspace, a private one only for its creator.
  loadDocumentAccess: vi.fn(async (db: { from: (t: string) => any }, workspaceId: string, userId: string, docId: string) => {
    const { data: member } = await db.from('member').select('id').eq('workspace_id', workspaceId).eq('user_id', userId).maybeSingle()
    const { data: doc } = await db.from('document').select('*').eq('workspace_id', workspaceId).eq('id', docId).maybeSingle()
    if (!doc) return { access: null, error: null }
    if (doc.visibility === 'private' && doc.created_by !== member?.id) return { access: null, error: null }
    return { access: { role: 'member', memberId: member?.id ?? null, row: doc, isProductDoc: false }, error: null }
  }),
}))

import { createBlankVideo } from '../blank'
import { getScript, saveScript } from '../scripts'
import { beatsFromMarkdown, plainWords, scriptFromDocument, scriptToDocument } from '../script-documents'
import { AVA, fakeContext, WS } from './fake'

const DOC = 'd0d0d0d0-1111-4222-8333-888888888888'
const PRIVATE_DOC = 'd0d0d0d0-1111-4222-8333-999999999999'
const OTHER_MEMBER = 'm2m2m2m2-1111-4222-8333-000000000002'

let env: ReturnType<typeof fakeContext>
beforeEach(() => {
  indexed.length = 0
  env = fakeContext({
    member: [{ id: 'member-ava', workspace_id: WS, user_id: AVA, role: 'member' }],
    document: [
      {
        id: DOC,
        workspace_id: WS,
        title: 'Spring launch notes',
        visibility: 'workspace',
        status: 'active',
        created_by: OTHER_MEMBER,
        content: '# Hook\n\nYour inbox, **finally** quiet.\n\n- Every reply drafted before you [open it](https://app.example).\n\n---\n\n[5s] Close:\nTry it free.',
      },
      { id: PRIVATE_DOC, workspace_id: WS, title: 'Someone else’s draft', visibility: 'private', status: 'active', created_by: OTHER_MEMBER, content: 'Not yours.' },
    ],
  })
})

describe('a document as beats', () => {
  it('keeps the words, drops the markup, names a beat after its heading, keeps a written length', () => {
    expect(plainWords('- **Bold** and [a link](https://x.example) and `code`')).toBe('Bold and a link and code')
    expect(beatsFromMarkdown('# Hook\n\nYour inbox, **finally** quiet.\n\n- Every reply drafted.\n\n---\n\n[5s] Close:\nTry it free.')).toEqual([
      { text: 'Your inbox, finally quiet.', label: 'Hook' },
      { text: 'Every reply drafted.' },
      { text: 'Try it free.', seconds: 5, label: 'Close' },
    ])
  })

  it('cuts a paragraph too long for one beat at a sentence end, and refuses an empty or too-long document', () => {
    const long = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} says a few more words here.`).join(' ')
    const beats = beatsFromMarkdown(long)
    expect(beats.length).toBeGreaterThan(1)
    expect(beats.every((b) => b.text.length <= 2000 && /\.$/.test(b.text))).toBe(true)
    expect(beats.map((b) => b.text).join(' ')).toBe(long)
    expect(() => beatsFromMarkdown('# Only a heading')).toThrow('no paragraphs')
    expect(() => beatsFromMarkdown(Array.from({ length: 101 }, (_, i) => `Line ${i}.`).join('\n\n'))).toThrow('at most 100')
  })
})

describe('scripts and documents', () => {
  it('writes a video’s script from a document the person may read, titled after it', async () => {
    const video = await createBlankVideo(env.ctx, { title: 'Spring teaser', seconds: 2, fps: 30 })
    const { script, document } = await scriptFromDocument(env.ctx, video.id, DOC)
    expect(document).toEqual({ id: DOC, title: 'Spring launch notes' })
    expect(script.title).toBe('Spring launch notes')
    expect((await getScript(env.ctx, video.id))!.beats.map((b) => b.text)).toEqual(['Your inbox, finally quiet.', 'Every reply drafted before you open it.', 'Try it free.'])
  })

  it('refuses a private document of someone else’s, one of another workspace, and a non-id', async () => {
    const video = await createBlankVideo(env.ctx, { title: 'Spring teaser', seconds: 2, fps: 30 })
    await expect(scriptFromDocument(env.ctx, video.id, PRIVATE_DOC)).rejects.toThrow('No such document')
    await expect(scriptFromDocument({ ...env.ctx, workspaceId: '0c0c0c0c-1111-4222-8333-555555555555' }, video.id, DOC)).rejects.toThrow()
    await expect(scriptFromDocument(env.ctx, video.id, 'not-an-id')).rejects.toThrow('No such document')
    expect(await getScript(env.ctx, video.id)).toBeNull()
  })

  it('puts a video’s script in a new document named after the video, indexed and linked to it', async () => {
    const video = await createBlankVideo(env.ctx, { title: 'Spring teaser', seconds: 2, fps: 30 })
    await expect(scriptToDocument(env.ctx, video.id)).rejects.toThrow('no script yet')
    await saveScript(env.ctx, video.id, { text: '[3s] Hook:\nYour inbox, finally quiet.\n\nEvery reply drafted.' })
    const made = await scriptToDocument(env.ctx, video.id)
    expect(made).toMatchObject({ document: { title: 'Spring teaser: script' }, linked: true })
    const doc = env.tables.document!.find((d) => d.id === made.document.id)!
    expect(doc).toMatchObject({ workspace_id: WS, created_by: 'member-ava', last_edited_by: 'member-ava', status: 'active', content: '[3s] Hook:\nYour inbox, finally quiet.\n\nEvery reply drafted.' })
    expect(indexed).toEqual([{ id: made.document.id, content: doc.content }])
    expect(env.tables.entity_link).toEqual([
      expect.objectContaining({ workspace_id: WS, source_type: 'document', source_id: made.document.id, target_type: 'studio_video', target_id: video.id, relation: 'about', created_by: 'member-ava' }),
    ])
    // The document reads back as the same script.
    expect(beatsFromMarkdown(String(doc.content))).toEqual((await getScript(env.ctx, video.id))!.beats)
  })
})
