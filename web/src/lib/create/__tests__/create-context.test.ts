import { describe, it, expect } from 'vitest'
import { containerApplies, containerLabel, contextDefaults } from '../create-context'

const project = { kind: 'project' as const, id: 'p-1', name: 'Website relaunch' }
const company = { kind: 'company' as const, id: 'c-1', name: 'Acme Test Co' }
const deal = { kind: 'deal' as const, id: 'r-1', name: 'Acme renewal' }

describe('what a place gives a new record', () => {
  it('in a project: an action belongs to it, a doc lands in it', () => {
    expect(contextDefaults('action', { container: project })).toEqual({ projectId: 'p-1' })
    expect(contextDefaults('document', { container: project })).toEqual({ projectId: 'p-1' })
  })

  it('on a company: a contact works there, an action is about it', () => {
    expect(contextDefaults('contact', { container: company })).toEqual({ companyId: 'c-1' })
    expect(contextDefaults('action', { container: company })).toEqual({ about: { type: 'company', id: 'c-1' } })
  })

  it('on a deal: an action is about its pipeline row', () => {
    expect(contextDefaults('action', { container: deal })).toEqual({ about: { type: 'data_row', id: 'r-1' } })
  })

  it('in an initiative: a project belongs to it', () => {
    expect(contextDefaults('project', { container: { kind: 'initiative', id: 'i-1', name: 'Growth' } })).toEqual({ initiativeId: 'i-1' })
  })

  it('a task from an email or a message links back to it, in a project too', () => {
    const source = { type: 'email_thread' as const, id: 'e-1', title: 'Follow up: Quote' }
    expect(contextDefaults('action', { source })).toEqual({ about: { type: 'email_thread', id: 'e-1' } })
    expect(contextDefaults('action', { source, container: project })).toEqual({ about: { type: 'email_thread', id: 'e-1' }, projectId: 'p-1' })
  })

  it('gives nothing where nothing links, and the chip shows only where it does', () => {
    expect(contextDefaults('table', { container: company })).toEqual({})
    expect(contextDefaults('action', null)).toEqual({})
    expect(containerApplies('table', { container: company })).toBe(false)
    expect(containerApplies('contact', { container: company })).toBe(true)
    expect(containerApplies('contact', {})).toBe(false)
  })

  it('names the place', () => {
    expect(containerLabel(project)).toBe('Create in Website relaunch')
    expect(containerLabel({ ...project, name: ' ' })).toBe('Create in this project')
  })
})

describe('in a folder (Drive folders, migration 690)', () => {
  const folder = { kind: 'folder' as const, id: 'f-1', name: 'Clients' }
  it('a doc, table, spreadsheet, canvas or folder lands in it; nothing else does', () => {
    for (const type of ['document', 'table', 'spreadsheet', 'canvas', 'folder'] as const) {
      expect(contextDefaults(type, { container: folder }), type).toEqual({ folderId: 'f-1' })
      expect(containerApplies(type, { container: folder }), type).toBe(true)
    }
    for (const type of ['action', 'project', 'contact', 'company', 'channel'] as const) {
      expect(containerApplies(type, { container: folder }), type).toBe(false)
    }
    expect(containerLabel(folder)).toBe('Create in Clients')
  })
})

