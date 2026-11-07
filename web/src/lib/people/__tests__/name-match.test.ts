/**
 * Tests for the tiered fuzzy person-name matcher.
 *
 * Root cause (observed live 2026-07-01): capture extraction proposed actions
 * with assignee_name "Cat" but assignee_member_id null even though
 * "Katrina Rae" is a workspace member — the old exact → first-name →
 * substring match cannot bridge a nickname with a different spelling
 * ("Cat" is not a substring of "Katrina"). The shared matcher adds
 * nickname/sound-alike and transcription-tolerant tiers.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  resolveContactIdByName,
  findBestNameMatch,
  givenNamesMatch,
  nameTrigramSimilarity,
} from '../name-match'

const members = (...names: string[]) =>
  names.map((name, i) => ({ id: `m${i + 1}`, name }))

describe('findBestNameMatch', () => {
  it('resolves the live bug: "Cat" → "Katrina Rae"', () => {
    const list = members('Liam Alizadeh', 'Katrina Rae')
    expect(findBestNameMatch(list, 'Cat')?.name).toBe('Katrina Rae')
  })

  it('resolves "Cat" case-insensitively and with surrounding whitespace', () => {
    const list = members('Katrina Rae')
    expect(findBestNameMatch(list, '  cat ')?.id).toBe('m1')
  })

  it('matches an exact full name first, even when a fuzzier candidate comes earlier', () => {
    const list = members('Catalina Jones', 'Cat Smith')
    expect(findBestNameMatch(list, 'Cat Smith')?.name).toBe('Cat Smith')
  })

  it('prefers an exact first-name match over a nickname/prefix match', () => {
    const list = members('Samantha Adams', 'Sam Jones')
    expect(findBestNameMatch(list, 'Sam')?.name).toBe('Sam Jones')
  })

  it('matches bare first names (pre-existing behavior)', () => {
    const list = members('Liam Alizadeh', 'Katrina Rae')
    expect(findBestNameMatch(list, 'Liam')?.name).toBe('Liam Alizadeh')
  })

  it('matches substrings (pre-existing behavior)', () => {
    const list = members('Dr. Liam Alizadeh')
    expect(findBestNameMatch(list, 'Liam Alizadeh')?.id).toBe('m1')
  })

  it('resolves irregular nicknames: "Bill" → "William", "Liz" → "Elizabeth"', () => {
    const list = members('William Chen', 'Elizabeth Ortiz')
    expect(findBestNameMatch(list, 'Bill')?.name).toBe('William Chen')
    expect(findBestNameMatch(list, 'Liz')?.name).toBe('Elizabeth Ortiz')
  })

  it('resolves short forms: "Sam" → "Samantha", "Alex" → "Alexandra"', () => {
    expect(findBestNameMatch(members('Samantha Adams'), 'Sam')?.id).toBe('m1')
    expect(findBestNameMatch(members('Alexandra Kim'), 'Alex')?.id).toBe('m1')
  })

  it('tolerates transcription respellings: "Katrena Ray" → "Katrina Rae"', () => {
    const list = members('Liam Alizadeh', 'Katrina Rae')
    expect(findBestNameMatch(list, 'Katrena Ray')?.name).toBe('Katrina Rae')
  })

  it('does not cross surnames: "Cat Smith" never matches "Katrina Rae"', () => {
    const list = members('Katrina Rae')
    expect(findBestNameMatch(list, 'Cat Smith')).toBeNull()
  })

  it('does not equate distinct short names ("Dan" vs "Don")', () => {
    const list = members('Don Draper')
    expect(findBestNameMatch(list, 'Dan')).toBeNull()
  })

  it('returns null when nothing plausibly matches', () => {
    const list = members('Liam Alizadeh', 'Katrina Rae')
    expect(findBestNameMatch(list, 'Rumpelstiltskin')).toBeNull()
  })

  it('returns null for empty input and skips null names', () => {
    expect(findBestNameMatch(members('Liam'), '   ')).toBeNull()
    expect(
      findBestNameMatch([{ id: 'x', name: null }, { id: 'y', name: 'Cat' }], 'Cat')?.id,
    ).toBe('y')
  })

  it('is deterministic: first candidate in list order wins within a tier', () => {
    const twins = [
      { id: 'older', name: 'Katrina Rae' },
      { id: 'newer', name: 'Katrina Rae' },
    ]
    expect(findBestNameMatch(twins, 'Cat')?.id).toBe('older')
  })

  it('handles accents: "José" matches "Jose Garcia"', () => {
    expect(findBestNameMatch(members('Jose Garcia'), 'José')?.id).toBe('m1')
  })
})

describe('givenNamesMatch', () => {
  it('bridges hard/soft spellings via the phonetic key', () => {
    expect(givenNamesMatch('cat', 'katrina')).toBe(true)
    expect(givenNamesMatch('catherine', 'katherine')).toBe(true)
  })

  it('rejects unrelated names', () => {
    expect(givenNamesMatch('sarah', 'steve')).toBe(false)
  })

  it('does not let bare initials match everyone', () => {
    expect(givenNamesMatch('k', 'katrina')).toBe(false)
  })
})

describe('nameTrigramSimilarity', () => {
  it('is 1 for identical names and 0 for empty input', () => {
    expect(nameTrigramSimilarity('Katrina Rae', 'Katrina Rae')).toBe(1)
    expect(nameTrigramSimilarity('', 'Katrina Rae')).toBe(0)
  })

  it('scores respellings above unrelated names', () => {
    const close = nameTrigramSimilarity('Katrinna Rae', 'Katrina Rae')
    const far = nameTrigramSimilarity('Bob Odenkirk', 'Katrina Rae')
    expect(close).toBeGreaterThan(0.65)
    expect(far).toBeLessThan(0.2)
  })
})

describe('findBestNameMatch — requireUnambiguous (assignment callers)', () => {
  it('returns null for a bare first name matching two members', () => {
    // The same-first-name-teammate case: a bare "Liam" must not silently land
    // on whichever member is older — assignment demands an unambiguous person.
    const list = members('Liam Alizadeh', 'Liam Chen')
    expect(findBestNameMatch(list, 'Liam', { requireUnambiguous: true })).toBeNull()
  })

  it('keeps pick-first behavior without the flag (display callers)', () => {
    const list = members('Liam Alizadeh', 'Liam Chen')
    expect(findBestNameMatch(list, 'Liam')?.name).toBe('Liam Alizadeh')
  })

  it('a full name that hits exactly one member still resolves under the flag', () => {
    const list = members('Liam Alizadeh', 'Liam Chen')
    expect(findBestNameMatch(list, 'Liam Chen', { requireUnambiguous: true })?.name).toBe('Liam Chen')
  })

  it('surname disambiguates a first-name tier collision', () => {
    // "Liam A" carries surname evidence — only one candidate is compatible.
    const list = members('Liam Alizadeh', 'Liam Chen')
    expect(findBestNameMatch(list, 'Liam Alizadeh', { requireUnambiguous: true })?.id).toBe('m1')
  })

  it('an ambiguous tier is a dead end, not a fall-through to looser tiers', () => {
    // Both candidates share the first name; the substring/trigram tiers would
    // also match one of them — falling through would defeat the guard.
    const list = members('Sam Adams', 'Sam Jones')
    expect(findBestNameMatch(list, 'Sam', { requireUnambiguous: true })).toBeNull()
  })

  it('two identical display names are ambiguous even at the exact tier', () => {
    const list = members('Liam Alizadeh', 'Liam Alizadeh')
    expect(findBestNameMatch(list, 'Liam Alizadeh', { requireUnambiguous: true })).toBeNull()
  })
})

describe("resolveContactIdByName — another member's private contact never resolves (service role: contact_visible_to)", () => {
  const USER = 'user-1'
  /** Substring query → `substring` rows; the full-roster query → `roster` rows. */
  function db(opts: { substring: Array<{ id: string; full_name: string }>; roster: Array<{ id: string; full_name: string }>; hidden: string[] }) {
    const rpcArgs: Array<{ p_contact_id: string; p_user_id: string }> = []
    const from = () => {
      let isSubstring = false
      const c: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'is', 'order', 'limit', 'range']) c[m] = () => c
      c.or = () => {
        isSubstring = true
        return c
      }
      c.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: isSubstring ? opts.substring : opts.roster, error: null }).then(resolve)
      return c
    }
    const rpc = vi.fn(async (_fn: string, args: { p_contact_id: string; p_user_id: string }) => {
      rpcArgs.push(args)
      return { data: !opts.hidden.includes(args.p_contact_id), error: null }
    })
    return { client: { from, rpc } as never, rpcArgs }
  }

  it('skips a hidden substring hit for the first visible one', async () => {
    const { client, rpcArgs } = db({
      substring: [
        { id: 'ct-private', full_name: 'Sarah Private' },
        { id: 'ct-shared', full_name: 'Sarah Shared' },
      ],
      roster: [],
      hidden: ['ct-private'],
    })
    expect(await resolveContactIdByName(client, 'ws-1', 'Sarah', USER)).toBe('ct-shared')
    expect(new Set(rpcArgs.map((a) => a.p_user_id))).toEqual(new Set([USER]))
  })

  it('skips a hidden fuzzy best match and takes the next visible one', async () => {
    const { client } = db({
      substring: [],
      roster: [
        { id: 'ct-private', full_name: 'Katherine Private' },
        { id: 'ct-shared', full_name: 'Katherine Shared' },
      ],
      hidden: ['ct-private'],
    })
    expect(await resolveContactIdByName(client, 'ws-1', 'Katherine', USER)).toBe('ct-shared')
  })

  it('resolves nobody when every match is hidden (fails closed)', async () => {
    const { client } = db({
      substring: [{ id: 'ct-private', full_name: 'Sarah Private' }],
      roster: [{ id: 'ct-private', full_name: 'Sarah Private' }],
      hidden: ['ct-private'],
    })
    expect(await resolveContactIdByName(client, 'ws-1', 'Sarah', USER)).toBeNull()
  })
})

describe('resolveContactIdByName — a merged (tombstoned) contact never resolves', () => {
  it('both the substring and the roster query exclude merged contacts', async () => {
    const isCalls: Array<[string, unknown]> = []
    const from = () => {
      const c: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'order', 'limit', 'or', 'range']) c[m] = () => c
      c.is = (col: string, v: unknown) => {
        isCalls.push([col, v])
        return c
      }
      c.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve)
      return c
    }
    const client = { from, rpc: vi.fn(async () => ({ data: true, error: null })) } as never
    expect(await resolveContactIdByName(client, 'ws-1', 'Sarah', 'user-1')).toBeNull()
    expect(isCalls).toEqual([
      ['merged_into_contact_id', null],
      ['merged_into_contact_id', null],
    ])
  })
})

describe('resolveContactIdByName — the model-supplied name cannot rewrite the .or() filter', () => {
  function recordingDb() {
    const orFilters: string[] = []
    const from = () => {
      const c: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'is', 'order', 'limit', 'range']) c[m] = () => c
      c.or = (f: string) => {
        orFilters.push(f)
        return c
      }
      c.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve)
      return c
    }
    return { client: { from, rpc: vi.fn(async () => ({ data: true, error: null })) } as never, orFilters }
  }

  it('strips commas, parentheses, quotes and wildcards: one ilike condition, nothing else', async () => {
    const { client, orFilters } = recordingDb()
    await resolveContactIdByName(client, 'ws-1', 'Sarah%,id.neq.0),or(email.ilike.*"', 'user-1')
    expect(orFilters).toEqual(['full_name.ilike.%Sarahid.neq.0oremail.ilike.%'])
    // Exactly one condition: no separator or group left to add another.
    expect(orFilters[0]).not.toMatch(/[,()"*]/)
    expect(orFilters[0].slice('full_name.ilike.%'.length, -1)).not.toContain('%')
  })

  it('a name that is nothing but metacharacters skips the substring query (no match-all "%%")', async () => {
    const { client, orFilters } = recordingDb()
    expect(await resolveContactIdByName(client, 'ws-1', '%', 'user-1')).toBeNull()
    expect(orFilters).toEqual([])
  })

  it('an ordinary name is unchanged', async () => {
    const { client, orFilters } = recordingDb()
    await resolveContactIdByName(client, 'ws-1', 'J. Smith', 'user-1')
    expect(orFilters).toEqual(['full_name.ilike.%J. Smith%'])
  })
})
