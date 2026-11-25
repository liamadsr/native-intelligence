import { describe, expect, it } from 'vitest'
import { archiveFailure } from '../archive-failure'
import { GMAIL_NEEDS_PERMISSION } from '../gmail-permission'

/** What the email page says when an archive or delete failed (Liam, 11-24: every Gmail archive failed, unexplained). */
describe('archiveFailure', () => {
  const answer = (body: unknown, status: number) => new Response(JSON.stringify(body), { status })

  it('Gmail without permission to change mail: the server’s words', async () => {
    expect(await archiveFailure(answer({ error: GMAIL_NEEDS_PERMISSION, code: 'gmail_needs_permission' }, 403), 'Could not archive the email')).toBe(GMAIL_NEEDS_PERMISSION)
  })

  it('any other failure, or none to read: the page’s own line (a raw provider error is not for the person)', async () => {
    expect(await archiveFailure(answer({ error: 'Gmail thread modify error: 500' }, 500), 'Could not archive the email')).toBe('Could not archive the email')
    expect(await archiveFailure(new Response('not json', { status: 502 }), 'Could not delete the email')).toBe('Could not delete the email')
    expect(await archiveFailure(null, 'Could not archive the email')).toBe('Could not archive the email')
  })
})
