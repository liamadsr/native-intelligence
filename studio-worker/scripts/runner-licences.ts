/**
 * The local runner's third-party notices (build-local-runner.ts), in the desktop's notices format
 * (desktop/scripts/licenses.sh, as web/scripts/local-agent/bundle-notices.mjs writes the local agent's):
 *
 *   <out>/licenses/NOTICES.txt              every npm package the runner folder carries, with where it sits
 *   <out>/licenses/<name>-<version>/<file>  that package's own licence and notice files, byte for byte
 *
 * A package is listed once per version. One that ships no licence file cites the same licence's text from another
 * listed package (one from its own repository when there is one) and says so; an @remotion/* package with none cites the Remotion License of `remotion` at the same
 * version (one repository, one LICENSE.md). Anything else without a text stops the build: the desktop's release
 * refuses notices that name a licence and carry no text for it.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** A package's licence and notice files, as the local agent's notices take them (plus Remotion's THIRD_PARTY_LICENSES.md). */
export const LICENCE_FILE = /^(licen[cs]e|notice|copying|thirdpartynotices|third[-_]party[-_]licen[cs]es)(\.|-|$)/i

/** Where a package sits in the runner folder; the order they are named in. */
export const PLACES = ['runner/node_modules', 'runner/runner.cjs', 'the render bundle', "the render bundle's scene runtime"] as const
export type Place = (typeof PLACES)[number]

/** `…/node_modules/a/node_modules/@b/c/dist/x.js` → `…/node_modules/a/node_modules/@b/c` (the innermost package), or null. */
export function packageDirOf(path: string): string | null {
  const m = /^(.*[\\/]node_modules[\\/](?:@[^\\/]+[\\/])?[^\\/]+)(?:[\\/]|$)/.exec(path.startsWith('node_modules') ? `./${path}` : path)
  return m ? m[1]! : null
}

/**
 * The package folders a webpack bundle's source maps name, resolved from `base` (the folder webpack ran in). A module
 * webpack left out (`ignored|…`) is not in the bundle. Throws when there is no map to read: a bundle that cannot be
 * listed is not shipped as if it held nothing.
 */
export function packagesInSourceMaps(bundleDir: string, base: string): string[] {
  const found = new Set<string>()
  let maps = 0
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) { walk(p); continue }
      if (!name.endsWith('.js.map')) continue
      maps++
      const sources = (JSON.parse(readFileSync(p, 'utf8')) as { sources?: unknown }).sources
      if (!Array.isArray(sources)) throw new Error(`${p} has no sources list`)
      for (const s of sources) {
        if (typeof s !== 'string' || s.startsWith('ignored|')) continue
        const dir = packageDirOf(s.replace(/^webpack:\/\/[^/]*\//, ''))
        if (dir) found.add(resolve(base, dir))
      }
    }
  }
  walk(bundleDir)
  if (maps === 0) throw new Error(`${bundleDir} has no source maps: its packages cannot be listed`)
  return [...found].sort()
}

type Pkg = { name: string; version: string; licence: string | null; url: string; folder: string; files: string[]; texts: string[]; places: Set<Place> }

function repoUrl(pkg: { repository?: unknown; homepage?: unknown }): string {
  const r = typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository as { url?: unknown } | undefined)?.url
  const raw = typeof r === 'string' ? r : typeof pkg.homepage === 'string' ? pkg.homepage : ''
  const url = raw.replace(/^git\+/, '').replace(/\.git$/, '').replace(/^git:\/\//, 'https://')
    .replace(/^(?:ssh:\/\/)?git@github\.com[:/]/, 'https://github.com/').replace(/^github:/, 'https://github.com/')
  // npm's shorthand: `owner/repo` is a GitHub repository.
  return /^[\w.-]+\/[\w.-]+$/.test(url) ? `https://github.com/${url}` : url
}

/** The repository a package comes from, without the folder inside it (a monorepo's packages share it). */
const repoOf = (url: string) => /^(https:\/\/github\.com\/[^/]+\/[^/#]+)/.exec(url)?.[1] ?? null

function copyrightOf(texts: string[]): string | null {
  for (const t of texts) {
    const line = t.split('\n').find((l) => /^\s*copyright\s+(\(c\)|©|\d)/i.test(l))
    if (line) return line.trim()
  }
  return null
}

const isRemotion = (name: string) => name === 'remotion' || name.startsWith('@remotion/')
/** What package.json says when the terms are in the package's own file, not an SPDX id. */
const seeFile = (licence: string | null) => licence === null || /^see licen[cs]e/i.test(licence) || /remotion licen[cs]e/i.test(licence)

/**
 * Write `<licensesDir>/NOTICES.txt` and each package's licence files, from scratch. `shipped`: package folders (each
 * holding a package.json) with where each sits; `leftOut`: packages the runner's closure names that are not copied.
 * Returns the packages listed, as `name@version`.
 */
export function writeRunnerLicences(licensesDir: string, shipped: { dir: string; place: Place }[], leftOut: string[]): string[] {
  rmSync(licensesDir, { recursive: true, force: true })
  mkdirSync(licensesDir, { recursive: true })

  const pkgs = new Map<string, Pkg>()
  for (const { dir, place } of shipped) {
    const file = join(dir, 'package.json')
    if (!existsSync(file)) throw new Error(`shipped package ${dir} has no package.json`)
    const json = JSON.parse(readFileSync(file, 'utf8')) as { name?: unknown; version?: unknown; license?: unknown; repository?: unknown; homepage?: unknown }
    if (typeof json.name !== 'string' || typeof json.version !== 'string') throw new Error(`${file} has no name or version`)
    const key = `${json.name}@${json.version}`
    const had = pkgs.get(key)
    if (had) { had.places.add(place); continue }
    const folder = `${json.name.replace('/', '__')}-${json.version}`
    const files = readdirSync(dir).filter((f) => LICENCE_FILE.test(f) && statSync(join(dir, f)).isFile()).sort()
    const texts = files.map((f) => {
      const bytes = readFileSync(join(dir, f))
      if (bytes.length === 0) throw new Error(`${key}: ${f} is empty`)
      mkdirSync(join(licensesDir, folder), { recursive: true })
      writeFileSync(join(licensesDir, folder, f), bytes)
      return bytes.toString('utf8')
    })
    pkgs.set(key, { name: json.name, version: json.version, licence: typeof json.license === 'string' ? json.license : null, url: repoUrl(json), folder, files, texts, places: new Set([place]) })
  }
  if (pkgs.size === 0) throw new Error('the runner lists no third-party package')

  const all = [...pkgs.values()].sort((a, b) => (a.name === b.name ? a.version.localeCompare(b.version, 'en', { numeric: true }) : a.name < b.name ? -1 : 1))
  const mainText = (p: Pkg) => p.files.find((f) => /^licen[cs]e/i.test(f))
  const lines = [
    "Studio runner (the Studio's export on this computer)",
    '',
    'Ships as:',
    '  the studio-runner folder in the app\'s resources (JavaScript, run by the',
    '  Node.js the app downloads from nodejs.org on first use; Node.js, FFmpeg,',
    "  ffprobe and Chrome's headless shell are downloaded on first use too and",
    '  are not part of the app)',
    '',
    'These files contain the components below, installed as they are in',
    'runner/node_modules or compiled into runner/runner.cjs or the render bundle.',
    'License paths are relative to this folder.',
    '',
    'Remotion (remotion and the @remotion packages) is not open source: it is',
    'under the Remotion License, whose text is reproduced here.',
    '',
  ]
  for (const p of all) {
    lines.push(`${p.name} ${p.version}`)
    if (p.url) lines.push(`  ${p.url}`)
    const copyright = copyrightOf(p.texts)
    if (copyright) lines.push(`  ${copyright}`)
    lines.push(`  In: ${PLACES.filter((x) => p.places.has(x)).join(', ')}`)
    if (p.files.length > 0) {
      lines.push(`  License: ${seeFile(p.licence) ? (isRemotion(p.name) ? 'Remotion License' : 'see the license file') : p.licence} (${p.files.map((f) => `${p.folder}/${f}`).join(', ')})`)
    } else if (isRemotion(p.name) && seeFile(p.licence)) {
      // One repository, one LICENSE.md: the text `remotion` ships at this same version.
      const donor = all.find((d) => d.name === 'remotion' && d.version === p.version && mainText(d))
      if (!donor) throw new Error(`${p.name}@${p.version}: ships no license file, and remotion ${p.version} is not listed with its LICENSE.md`)
      lines.push(`  License: Remotion License. The package ships no license file; its repository's license is in ${donor.folder}/${mainText(donor)}.`)
    } else if (p.licence && !seeFile(p.licence)) {
      // The same repository's text first: it names the people who hold this package's copyright too.
      const donors = all.filter((d) => d.licence === p.licence && mainText(d))
      const donor = donors.find((d) => repoOf(d.url) !== null && repoOf(d.url) === repoOf(p.url)) ?? donors[0]
      if (!donor) throw new Error(`${p.name}@${p.version}: ships no license file, and no other listed ${p.licence} package has the text`)
      lines.push(`  License: ${p.licence}. The package ships no license file; the ${p.licence} text is in ${donor.folder}/${mainText(donor)}.`)
    } else {
      throw new Error(`${p.name}@${p.version}: no license field or file`)
    }
    lines.push('')
  }
  if (leftOut.length > 0) {
    lines.push('Left out of the runner:')
    for (const n of leftOut) lines.push(`  ${n}: Remotion's FFmpeg build (GPL, with libx264, libx265 and libfdk-aac).`)
    lines.push('')
  }
  writeFileSync(join(licensesDir, 'NOTICES.txt'), lines.join('\n'))
  return all.map((p) => `${p.name}@${p.version}`)
}
