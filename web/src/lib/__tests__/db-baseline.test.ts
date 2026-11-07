/**
 * The database baseline's rule (supabase/baseline/CUT): schema.sql and seed.sql are the
 * database as of the cut, and scripts/db-bootstrap.sh applies every migration numbered
 * after it. So a new migration is always numbered after the cut, and the baseline is only
 * ever regenerated (scripts/db-baseline-regenerate.mjs), never edited.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const BASE = path.join(ROOT, 'supabase/baseline')
const read = (file: string) => readFileSync(path.join(BASE, file), 'utf8')

const cut = Number(
  read('CUT')
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('#'))
    .join('')
    .trim(),
)
const migrations = readdirSync(path.join(ROOT, 'supabase/migrations'))
  .filter((f) => f.endsWith('.sql'))
  .sort()
const atOrBelow = migrations.filter((f) => Number.parseInt(f, 10) <= cut)

describe('database baseline', () => {
  it('has a cut that names a migration', () => {
    expect(Number.isInteger(cut)).toBe(true)
    expect(migrations.some((f) => Number.parseInt(f, 10) === cut)).toBe(true)
  })

  it('every migration is named <number>_<name>.sql, so the bootstrap can order it against the cut', () => {
    expect(migrations.filter((f) => !/^\d+_[^/]+\.sql$/.test(f))).toEqual([])
  })

  it('no migration was added at or below the cut (number it after the cut, or regenerate the baseline)', () => {
    const header = read('schema.sql').split('\n').slice(0, 4).join('\n')
    const m = header.match(/^-- Cut: migration (\d+) \((\d+) migration files, the last (\S+)\)\.$/m)
    expect(m, 'schema.sql header names its cut').not.toBeNull()
    const [, headerCut, count, last] = m!
    expect(Number(headerCut)).toBe(cut)
    expect({ count: atOrBelow.length, last: atOrBelow[atOrBelow.length - 1] }).toEqual({ count: Number(count), last })
  })

  it('seed.sql was generated at the same cut', () => {
    expect(read('seed.sql')).toMatch(new RegExp(`^-- Cut: migration ${cut}\\.`, 'm'))
  })

  it('seed.sql holds no email address or phone number', () => {
    const seed = read('seed.sql')
    expect(seed.match(/[\w.%+-]+@[\w-]+(\.[\w-]+)*\.[a-z]{2,}/gi) ?? []).toEqual([])
    expect(seed.match(/\+\d{10,}|\(?\b\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/g) ?? []).toEqual([])
  })

  // The name list is export-ignored: this runs in the private repo only.
  const denylistFile = path.join(ROOT, 'scripts/open-source/denylist.txt')
  it.runIf(existsSync(denylistFile))('names no one on the open-source denylist', () => {
    const patterns = readFileSync(denylistFile, 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(#|$)/.test(l))
      .map((p) => new RegExp(p, 'iu'))
    const hits: string[] = []
    for (const file of ['schema.sql', 'seed.sql']) {
      read(file)
        .split('\n')
        .forEach((line, i) => {
          for (const re of patterns) if (re.test(line)) hits.push(`${file}:${i + 1} ${re.source}`)
        })
    }
    expect(hits).toEqual([])
  })
})
