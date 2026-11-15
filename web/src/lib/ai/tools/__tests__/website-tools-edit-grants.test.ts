/**
 * The website tools get the same edit-grants answer the table tools do
 * (createTools, ../index.ts): wire_website_form's form_id takes a table
 * reached only by an edit grant on the person's own attended turn, never on
 * a guest's or a linked agent's turn (omitGrants) or an unattended one.
 */
import { describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({ website: vi.fn(), tables: vi.fn() }))
vi.mock('../website', async (importOriginal) => {
  const real = await importOriginal<typeof import('../website')>()
  return {
    ...real,
    createWebsiteTools: (...args: Parameters<typeof real.createWebsiteTools>) => {
      hoisted.website(...args)
      return real.createWebsiteTools(...args)
    },
  }
})
vi.mock('../tables', async (importOriginal) => {
  const real = await importOriginal<typeof import('../tables')>()
  return {
    ...real,
    createTableTools: (...args: Parameters<typeof real.createTableTools>) => {
      hoisted.tables(...args)
      return real.createTableTools(...args)
    },
  }
})

import { createTools } from '../index'

/** The editGrants each family got on the last assembly: the website tools' option, the table tools' sixth argument. */
function grantsGiven(options: Record<string, unknown>) {
  hoisted.website.mockClear()
  hoisted.tables.mockClear()
  createTools('u-1', {} as never, 'ws-1', undefined, options as never)
  const website = hoisted.website.mock.calls.at(-1)?.[3] as { editGrants?: boolean } | undefined
  const tables = hoisted.tables.mock.calls.at(-1)?.[5] as boolean | undefined
  return { website: website?.editGrants, tables }
}

describe("the website tools' edit grants", () => {
  it("are the table tools': on for the person's attended turn, off for a guest's or a linked agent's, and off unattended", () => {
    expect(grantsGiven({})).toEqual({ website: true, tables: true })
    expect(grantsGiven({ omitGrants: true })).toEqual({ website: false, tables: false })
    expect(grantsGiven({ unattended: true })).toEqual({ website: false, tables: false })
  })
})
