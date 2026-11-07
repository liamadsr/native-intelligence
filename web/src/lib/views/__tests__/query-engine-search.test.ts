import { describe, it, expect, vi } from 'vitest'
import { applySearch } from '@/lib/views/query-engine'

function makeQuery() {
  const q = {
    or: vi.fn().mockReturnThis(),
    ilike: vi.fn().mockReturnThis(),
  }
  return q
}

describe('applySearch', () => {
  it('applies OR filter on full_name and email for contacts', () => {
    const q = makeQuery()
    applySearch(q as never, 'contact', 'alice')
    expect(q.or).toHaveBeenCalledWith('full_name.ilike.%alice%,email.ilike.%alice%')
    expect(q.ilike).not.toHaveBeenCalled()
  })

  it('strips .or() filter syntax from a contact search (no 400 on "Smith, John")', () => {
    const q = makeQuery()
    applySearch(q as never, 'contact', 'Smith, (John)')
    expect(q.or).toHaveBeenCalledWith('full_name.ilike.%Smith John%,email.ilike.%Smith John%')
  })

  it('strips .or() filter syntax from a prospect list search', () => {
    const q = makeQuery()
    applySearch(q as never, 'prospect_list', 'x,id.not.is.null')
    expect(q.or).toHaveBeenCalledWith('name.ilike.%xid.not.is.null%,description.ilike.%xid.not.is.null%')
  })

  it('applies ilike on name for companies', () => {
    const q = makeQuery()
    applySearch(q as never, 'company', 'acme')
    expect(q.ilike).toHaveBeenCalledWith('name', '%acme%')
    expect(q.or).not.toHaveBeenCalled()
  })

  it('applies ilike on title for actions', () => {
    const q = makeQuery()
    applySearch(q as never, 'action', 'deploy')
    expect(q.ilike).toHaveBeenCalledWith('title', '%deploy%')
  })

  it('applies ilike on title for captures', () => {
    const q = makeQuery()
    applySearch(q as never, 'capture', 'sprint')
    expect(q.ilike).toHaveBeenCalledWith('title', '%sprint%')
  })

  it('applies ilike on title for documents', () => {
    const q = makeQuery()
    applySearch(q as never, 'document', 'spec')
    expect(q.ilike).toHaveBeenCalledWith('title', '%spec%')
  })

  it('does nothing for empty string', () => {
    const q = makeQuery()
    applySearch(q as never, 'contact', '')
    expect(q.or).not.toHaveBeenCalled()
    expect(q.ilike).not.toHaveBeenCalled()
  })

  it('trims whitespace before applying', () => {
    const q = makeQuery()
    applySearch(q as never, 'contact', '  bob  ')
    expect(q.or).toHaveBeenCalledWith('full_name.ilike.%bob%,email.ilike.%bob%')
  })

  it('does nothing for whitespace-only search', () => {
    const q = makeQuery()
    applySearch(q as never, 'contact', '   ')
    expect(q.or).not.toHaveBeenCalled()
    expect(q.ilike).not.toHaveBeenCalled()
  })

  it('does not apply search for email_thread entity type', () => {
    const q = makeQuery()
    applySearch(q as never, 'email_thread', 'test')
    expect(q.or).not.toHaveBeenCalled()
    expect(q.ilike).not.toHaveBeenCalled()
  })
})
