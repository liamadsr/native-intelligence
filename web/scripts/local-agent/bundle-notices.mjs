#!/usr/bin/env node
// The two files bundle.sh writes about a local-agent bundle (plain Node; the
// agent-packages pass loads the repo's esbuild):
//
//   node bundle-notices.mjs --agent-packages <repo> <agent-dir> <out-file>
//     the npm packages the agent's own code imports, from esbuild's import
//     graph of the staged copy (every source file outside lib/, which eve
//     discovers, and what they import). eve inlines that code into its
//     server chunk without the bundlers' module comments, so a package only
//     the agent imports (a local model's provider, say) would leave no trace
//     for the scan below. One `node_modules/<name>` path per line.
//
//   node bundle-notices.mjs <repo> <licenses-dir> [<agent-packages-file>]
//     licenses/NOTICES.txt: every npm package the bundle carries, found by the
//     module paths the bundlers leave in it (rolldown's `//#region <path>` and
//     esbuild's `// <path>` comments) and in the agent-packages file, in the
//     desktop's notices format, with each package's license files in
//     licenses/<name>-<version>/. The packages installed whole in the bundle's
//     acp/node_modules (the workers' agent adapters, install-agents.sh) are
//     listed from there, by their own package.json, and that folder is not
//     scanned for module comments (they name the packages' own sources). The
//     desktop stages it with the app's other third-party notices.
//
//   node bundle-notices.mjs --stamp <repo> <out-dir> <web-commit> <dirty> [<capabilities>]
//     BUNDLE.json: the web commit it came from, eve's version, the Node major
//     the launcher is written for, the capabilities (a comma list: "local-model",
//     "workers"; the desktop refuses a feature the bundle doesn't declare), and
//     a SHA-256 per file.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const NODE_MAJOR = 24
/** What a bundle may declare (desktop: src-tauri/src/local_agent/workers.rs bundle_caps). */
const CAPABILITIES = new Set(['local-model', 'workers'])

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

function stamp(repo, outDir, commit, dirty, caps = '') {
  const capabilities = caps.split(',').filter(Boolean)
  for (const c of capabilities) if (!CAPABILITIES.has(c)) throw new Error(`unknown capability ${JSON.stringify(c)}`)
  const eve = JSON.parse(readFileSync(join(outDir, '.output', 'eve-cache.json'), 'utf8')).eveVersion ?? null
  const files = {}
  for (const p of walk(outDir)) {
    const rel = relative(outDir, p)
    if (rel === 'BUNDLE.json') continue
    files[rel] = createHash('sha256').update(readFileSync(p)).digest('hex')
  }
  const bundle = { webCommit: commit, webDirty: dirty === 'true', eveVersion: eve, nodeMajor: NODE_MAJOR, capabilities: [...new Set(capabilities)].sort(), files }
  writeFileSync(join(outDir, 'BUNDLE.json'), JSON.stringify(bundle, null, 2) + '\n')
}

// `…/node_modules/a/node_modules/@b/c/dist/x.js` → `node_modules/a/node_modules/@b/c`.
const PKG_PATH = /(?:^|[\s/])(node_modules\/(?:(?:@[^/\s]+\/)?[^/\s]+\/node_modules\/)*(?:@[^/\s]+\/)?[^/\s]+)\//g

/** The installed packages folder a bundle carries whole (mac-body.sh build_workers). */
const INSTALLED = join('acp', 'node_modules')

function packagesIn(dir) {
  const found = new Set()
  const installed = join(dir, INSTALLED) + '/'
  for (const p of walk(dir)) {
    if (p.startsWith(installed)) continue
    if (!/\.(mjs|js|cjs)$/.test(p)) continue
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (!line.startsWith('//')) continue
      for (const m of line.matchAll(PKG_PATH)) found.add(m[1])
    }
  }
  return [...found].sort()
}

/** The packages the agent's own code imports (see the file comment): esbuild's graph, eve and Node's builtins left out. */
async function agentPackages(repo, agentDir, outFile) {
  // This file runs from <repo>/scripts/local-agent, so this resolves the
  // repo's own esbuild. A literal import keeps the eve-everywhere tripwire
  // able to see what loads (it refuses createRequire).
  const { build } = await import('esbuild')
  const entries = walk(agentDir).filter((p) => {
    const rel = relative(agentDir, p)
    return /\.(ts|mts|js|mjs)$/.test(rel) && !/(^|\/)(lib|node_modules|__tests__|\.[^/]*)\//.test(rel) && !rel.startsWith('.')
  })
  const result = await build({
    entryPoints: entries,
    absWorkingDir: agentDir,
    bundle: true,
    write: false,
    metafile: true,
    platform: 'node',
    format: 'esm',
    outdir: join(agentDir, '.agent-packages'),
    external: ['eve', 'eve/*', 'node:*'],
    logLevel: 'silent',
  })
  const found = new Set()
  // `../../<checkout>/node_modules/a/node_modules/@b/c/x.js` → `node_modules/a/node_modules/@b/c`, as the repo holds it.
  for (const input of Object.keys(result.metafile.inputs)) for (const m of `/${input}`.matchAll(PKG_PATH)) found.add(m[1])
  writeFileSync(outFile, [...found].sort().join('\n') + '\n')
}

const LICENSE_FILE = /^(licen[cs]e|notice|copying)(\.|-|$)/i

/** Every package folder under an installed node_modules, nested ones too (`@scope/name`, `a/node_modules/b`). */
function installedPackages(nodeModules) {
  const out = []
  if (!existsSync(nodeModules)) return out
  for (const name of readdirSync(nodeModules).sort()) {
    if (name.startsWith('.')) continue
    const p = join(nodeModules, name)
    if (!statSync(p).isDirectory()) continue
    const dirs = name.startsWith('@') ? readdirSync(p).sort().map((n) => join(p, n)).filter((d) => statSync(d).isDirectory()) : [p]
    for (const d of dirs) {
      if (existsSync(join(d, 'package.json'))) out.push(d)
      out.push(...installedPackages(join(d, 'node_modules')))
    }
  }
  return out
}

function repoUrl(pkg) {
  const r = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
  const url = (r ?? pkg.homepage ?? '').replace(/^git\+/, '').replace(/\.git$/, '').replace(/^git:\/\//, 'https://')
  return url.startsWith('github:') ? `https://github.com/${url.slice(7)}` : url
}

function copyrightOf(texts) {
  for (const t of texts) {
    const line = t.split('\n').find((l) => /^\s*copyright\s+(\(c\)|©|\d)/i.test(l))
    if (line) return line.trim()
  }
  return null
}

// The desktop's notices format (scripts/licenses.sh there): NOTICES.txt names
// each component, and its license files sit beside it, one folder per package.
function notices(repo, licensesDir, agentPackagesFile) {
  const out = join(licensesDir, '..')
  const lines = [
    'Local agent (Native Intelligence\'s agent that works in folders on this Mac)',
    '',
    'Ships as:',
    '  Contents/Resources/local-agent/ (JavaScript, run by the Node.js the app',
    '  downloads from nodejs.org on first use; Node.js is not part of the app)',
    '',
    'These files contain the open-source components below, bundled into the',
    'agent\'s JavaScript or installed as they are in acp/node_modules. License',
    'paths are relative to this folder.',
    '',
  ]
  // Pass 1: every package, its license files copied beside NOTICES.txt.
  const pkgs = []
  const seen = new Set()
  const agentOwn = agentPackagesFile ? readFileSync(agentPackagesFile, 'utf8').split('\n').filter(Boolean) : []
  const dirs = [
    ...[...new Set([...packagesIn(out), ...agentOwn])].sort().map((rel) => join(repo, rel)),
    ...installedPackages(join(out, INSTALLED)),
  ]
  for (const dir of dirs) {
    const pj = join(dir, 'package.json')
    if (!existsSync(pj)) throw new Error(`bundled package ${dir} has no package.json`)
    const pkg = JSON.parse(readFileSync(pj, 'utf8'))
    const key = `${pkg.name}@${pkg.version}`
    if (seen.has(key)) continue
    seen.add(key)
    const folder = `${pkg.name.replace('/', '__')}-${pkg.version}`
    const files = readdirSync(dir).filter((f) => LICENSE_FILE.test(f) && statSync(join(dir, f)).isFile()).sort()
    const texts = files.map((f) => {
      const text = readFileSync(join(dir, f), 'utf8')
      mkdirSync(join(licensesDir, folder), { recursive: true })
      writeFileSync(join(licensesDir, folder, f), text)
      return text
    })
    const lic = typeof pkg.license === 'string' ? pkg.license : null
    pkgs.push({ pkg, key, folder, files, texts, lic })
  }
  // Pass 2: the list. A package that ships no license file (some publish only
  // the `license` field) cites the same license's text from another bundled
  // package, and says so.
  for (const p of pkgs) {
    if (p.files.length === 0 && !p.lic) throw new Error(`${p.key}: no license field or file`)
    lines.push(`${p.pkg.name} ${p.pkg.version}`)
    const url = repoUrl(p.pkg)
    if (url) lines.push(`  ${url}`)
    const copyright = copyrightOf(p.texts)
    if (copyright) lines.push(`  ${copyright}`)
    if (p.files.length > 0) {
      lines.push(`  License: ${p.lic ?? 'see the license file'} (${p.files.map((f) => `${p.folder}/${f}`).join(', ')})`)
    } else {
      const donor = pkgs.find((d) => d.lic === p.lic && d.files.some((f) => /^licen[cs]e/i.test(f)))
      if (!donor) throw new Error(`${p.key}: ships no license file, and no other bundled ${p.lic} package has the text`)
      const text = donor.files.find((f) => /^licen[cs]e/i.test(f))
      lines.push(`  License: ${p.lic}. The package ships no license file; the ${p.lic} text is in ${donor.folder}/${text}.`)
    }
    lines.push('')
  }
  writeFileSync(join(licensesDir, 'NOTICES.txt'), lines.join('\n'))
}

// The bundlers' module comments name where each module was read from, which
// is this Mac's checkout (node_modules is a symlink into it). Make them
// relative, then refuse a bundle that names a path here anywhere else: the
// app must not ship one, and code that reads one would only work here.
function scrub(outDir, roots) {
  // Longest first, so the checkout goes before the home folder holding it.
  const prefixes = [...new Set(roots.filter(Boolean).map((r) => r.replace(/\/+$/, '') + '/'))].sort((a, b) => b.length - a.length)
  for (const p of walk(outDir)) {
    if (!/\.(mjs|js|cjs|json)$/.test(p)) continue
    const text = readFileSync(p, 'utf8')
    if (!prefixes.some((x) => text.includes(x) || text.includes(x.slice(0, -1)))) continue
    // A comment can reach the checkout as `../../../..` + its absolute path
    // (relative from where the agent was built): both parts go.
    const lines = text.split('\n').map((line) => {
      if (!line.trimStart().startsWith('//')) return line
      return prefixes.reduce((l, x) => l.replace(new RegExp(`(?:\\.\\./)*(?:\\.\\.)?${x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g'), ''), line)
    })
    const left = lines.find((l) => prefixes.some((x) => l.includes(x) || l.includes(x.slice(0, -1))))
    if (left !== undefined) throw new Error(`${relative(outDir, p)} names a path on this Mac outside a comment: ${left.trim().slice(0, 160)}`)
    writeFileSync(p, lines.join('\n'))
  }
}

const args = process.argv.slice(2)
if (args[0] === '--stamp') stamp(args[1], args[2], args[3], args[4], args[5])
else if (args[0] === '--scrub') scrub(args[1], args.slice(2))
else if (args[0] === '--agent-packages' && args.length === 4) await agentPackages(args[1], args[2], args[3])
else if (args.length === 2 || args.length === 3) notices(args[0], args[1], args[2])
else {
  console.error('usage: bundle-notices.mjs <repo> <licenses-dir> [<agent-packages-file>] | --agent-packages <repo> <agent-dir> <out-file> | --scrub <out-dir> <root>... | --stamp <repo> <out-dir> <commit> <dirty> [<capabilities>]')
  process.exit(2)
}
