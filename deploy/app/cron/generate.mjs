#!/usr/bin/env node
// Turns the `crons` array in web/vercel.json into ./crontab, the schedule the cron
// role runs with supercronic. Vercel Cron and this crontab then call the same routes
// at the same times (both in UTC), each with `Authorization: Bearer $CRON_SECRET`.
//
//   node deploy/app/cron/generate.mjs           write ./crontab
//   node deploy/app/cron/generate.mjs --check   exit 1 if ./crontab is not what
//                                               web/vercel.json says
//
// The image keeps the repository's layout (/app/web, /app/deploy/app), so the same
// relative paths work in a checkout and in a container.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const vercelJsonPath = join(repoRoot, 'web', 'vercel.json')
const crontabPath = join(here, 'crontab')
// What each line runs: one authenticated GET (call.mjs), from inside the image.
const CALL = 'node /app/deploy/app/cron/call.mjs'

// One schedule field: numbers, `*`, steps, ranges and lists. Vercel accepts no names
// (MON, JAN), and neither does this.
const FIELD = /^[0-9*/,-]+$/
// The path goes into a crontab line unquoted, so it may hold nothing a shell reads.
const PATH = /^\/[A-Za-z0-9/_.~-]*$/

/** @param {unknown} vercelJson the parsed web/vercel.json */
export function renderCrontab(vercelJson) {
  const crons = vercelJson?.crons
  if (!Array.isArray(crons) || crons.length === 0) {
    throw new Error('web/vercel.json has no `crons` array')
  }
  const lines = crons.map((cron, index) => {
    const where = `crons[${index}]`
    if (typeof cron?.path !== 'string' || !PATH.test(cron.path)) {
      throw new Error(`${where}: path ${JSON.stringify(cron?.path)} must look like /api/cron/name`)
    }
    if (typeof cron.schedule !== 'string') throw new Error(`${where}: schedule is missing`)
    const fields = cron.schedule.trim().split(/\s+/)
    if (fields.length !== 5 || !fields.every(field => FIELD.test(field))) {
      throw new Error(`${where}: schedule ${JSON.stringify(cron.schedule)} must be five numeric cron fields`)
    }
    return `${fields.join(' ')} ${CALL} ${cron.path}`
  })
  return [
    '# Generated from web/vercel.json by deploy/app/cron/generate.mjs. Do not edit:',
    '# change web/vercel.json, then run `node deploy/app/cron/generate.mjs`.',
    '# Times are UTC, as on Vercel (the image sets TZ=UTC).',
    ...lines,
    '',
  ].join('\n')
}

function main() {
  const check = process.argv.includes('--check')
  const expected = renderCrontab(JSON.parse(readFileSync(vercelJsonPath, 'utf8')))
  const shown = relative(process.cwd(), crontabPath) || crontabPath
  if (!check) {
    writeFileSync(crontabPath, expected)
    console.log(`wrote ${shown} (${expected.split('\n').filter(line => line && !line.startsWith('#')).length} jobs)`)
    return
  }
  let actual = ''
  try {
    actual = readFileSync(crontabPath, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (actual === expected) {
    console.log(`${shown} matches web/vercel.json`)
    return
  }
  const want = new Set(expected.split('\n'))
  const have = new Set(actual.split('\n'))
  console.error(`${shown} does not match web/vercel.json:`)
  for (const line of want) if (!have.has(line)) console.error(`  missing: ${line}`)
  for (const line of have) if (!want.has(line)) console.error(`  extra:   ${line}`)
  if ([...want].every(line => have.has(line)) && [...have].every(line => want.has(line))) {
    console.error('  (same lines, different order)')
  }
  console.error('Run `node deploy/app/cron/generate.mjs` and commit the result.')
  process.exitCode = 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
