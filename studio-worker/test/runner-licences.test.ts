/**
 * The local runner's notices (scripts/runner-licences.ts): each shipped package's own licence files, copied byte for
 * byte, and a NOTICES.txt the desktop's release accepts. Every package here is made up.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installedPackages, isLicenceFile, licenceFilesIn, packageDirOf, packagesInSourceMaps, writeRunnerLicences } from '../scripts/runner-licences.ts'

const MIT = 'MIT License\n\nCopyright (c) 2020 Maple Example\n\nPermission is hereby granted.\n'

function pkg(root: string, name: string, json: Record<string, unknown>, files: Record<string, string | Buffer> = {}): string {
  const dir = join(root, 'node_modules', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, ...json }))
  for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text)
  return dir
}

const scratch = () => mkdtempSync(join(tmpdir(), 'runner-licences-'))

test('a package folder is found in a module path, the innermost one', () => {
  assert.equal(packageDirOf('node_modules/zod/v4/index.js'), './node_modules/zod')
  assert.equal(packageDirOf('../web/node_modules/@scope/kit/dist/a.js'), '../web/node_modules/@scope/kit')
  assert.equal(packageDirOf('./node_modules/a/node_modules/@b/c/x.js'), './node_modules/a/node_modules/@b/c')
  assert.equal(packageDirOf('C:\\w\\node_modules\\a\\x.js'), 'C:\\w\\node_modules\\a')
  assert.equal(packageDirOf('../web/src/lib/studio/engine/a.ts'), null)
  assert.equal(packageDirOf('webpack/bootstrap'), null)
})

test("a package's licence files are copied byte for byte and cited", () => {
  const root = scratch()
  // CRLF and a byte that is not UTF-8: the copy is the file, not a re-encoding of it.
  const odd = Buffer.concat([Buffer.from('Copyright (c) 2019 Fern\r\nApache text\r\n'), Buffer.from([0xe9])])
  const a = pkg(root, 'maple', { version: '1.2.3', license: 'MIT', repository: { url: 'git+https://example.com/maple.git' } }, { LICENSE: MIT, 'README.md': 'no' })
  const b = pkg(root, '@fern/core', { version: '0.1.0', license: 'Apache-2.0', repository: 'github:fern/core' }, { 'LICENSE.txt': odd, NOTICE: 'Fern notice\n' })
  const out = join(root, 'licenses')
  const listed = writeRunnerLicences(out, [{ dir: a, place: 'runner/node_modules' }, { dir: b, place: 'the render bundle' }, { dir: a, place: 'runner/runner.cjs' }], [])
  assert.deepEqual(listed, ['@fern/core@0.1.0', 'maple@1.2.3'])
  assert.equal(readFileSync(join(out, 'maple-1.2.3', 'LICENSE'), 'utf8'), MIT)
  assert.deepEqual(readFileSync(join(out, '@fern__core-0.1.0', 'LICENSE.txt')), odd)
  assert.deepEqual(readdirSync(join(out, '@fern__core-0.1.0')).sort(), ['LICENSE.txt', 'NOTICE'])
  assert.ok(!existsSync(join(out, 'maple-1.2.3', 'README.md')))
  const notices = readFileSync(join(out, 'NOTICES.txt'), 'utf8')
  assert.match(notices, /^Studio runner \(/)
  assert.ok(notices.includes('\nmaple 1.2.3\n  https://example.com/maple\n  Copyright (c) 2020 Maple Example\n  In: runner/node_modules, runner/runner.cjs\n  License: MIT (maple-1.2.3/LICENSE)\n'))
  assert.ok(notices.includes('\n@fern/core 0.1.0\n  https://github.com/fern/core\n  Copyright (c) 2019 Fern\n  In: the render bundle\n  License: Apache-2.0 (@fern__core-0.1.0/LICENSE.txt, @fern__core-0.1.0/NOTICE)\n'))
})

test('two versions of a package are two entries, each with its own text', () => {
  const root = scratch()
  const a = pkg(join(root, 'a'), 'maple', { version: '1.0.0', license: 'MIT' }, { LICENSE: MIT })
  const b = pkg(join(root, 'b'), 'maple', { version: '10.0.0', license: 'MIT' }, { LICENSE: MIT + 'more\n' })
  const c = pkg(join(root, 'c'), 'maple', { version: '2.0.0', license: 'MIT' }, { LICENSE: MIT })
  const listed = writeRunnerLicences(join(root, 'licenses'), [b, c, a].map((dir) => ({ dir, place: 'runner/node_modules' as const })), [])
  assert.deepEqual(listed, ['maple@1.0.0', 'maple@2.0.0', 'maple@10.0.0'])
  assert.equal(readFileSync(join(root, 'licenses', 'maple-10.0.0', 'LICENSE'), 'utf8'), MIT + 'more\n')
})

test('a package with no licence file cites the same licence in another listed package', () => {
  const root = scratch()
  const a = pkg(root, 'maple', { version: '1.0.0', license: 'MIT' }, { LICENSE: MIT })
  const b = pkg(root, 'birch', { version: '2.0.0', license: 'MIT' })
  const out = join(root, 'licenses')
  writeRunnerLicences(out, [{ dir: a, place: 'runner/node_modules' }, { dir: b, place: 'runner/node_modules' }], [])
  assert.ok(readFileSync(join(out, 'NOTICES.txt'), 'utf8').includes('\nbirch 2.0.0\n  In: runner/node_modules\n  License: MIT. The package ships no license file; the MIT text is in maple-1.0.0/LICENSE.\n'))
  assert.ok(!existsSync(join(out, 'birch-2.0.0')))
})

test("the cited text comes from the package's own repository when a listed package there has it", () => {
  const root = scratch()
  const other = pkg(root, 'aspen', { version: '1.0.0', license: 'MIT', repository: 'aspen-co/aspen' }, { LICENSE: MIT })
  const sibling = pkg(root, '@oak/utils', { version: '3.0.0', license: 'MIT', repository: { url: 'https://github.com/oak-co/oak/tree/main/packages/utils' } }, { 'LICENSE.md': 'MIT\n\nCopyright (c) 2021 Oak Example\n' })
  const bare = pkg(root, '@oak/fonts', { version: '3.0.0', license: 'MIT', repository: { url: 'git+ssh://git@github.com/oak-co/oak.git' } })
  const out = join(root, 'licenses')
  writeRunnerLicences(out, [other, sibling, bare].map((dir) => ({ dir, place: 'the render bundle' as const })), [])
  const notices = readFileSync(join(out, 'NOTICES.txt'), 'utf8')
  assert.ok(notices.includes('\n@oak/fonts 3.0.0\n  https://github.com/oak-co/oak\n  In: the render bundle\n  License: MIT. The package ships no license file; the MIT text is in @oak__utils-3.0.0/LICENSE.md.\n'))
  // npm's shorthand is written out as the address it stands for.
  assert.ok(notices.includes('\naspen 1.0.0\n  https://github.com/aspen-co/aspen\n'))
})

test('a package with no text anywhere stops the build', () => {
  const root = scratch()
  const a = pkg(root, 'maple', { version: '1.0.0', license: 'MIT' }, { LICENSE: MIT })
  const isc = pkg(root, 'birch', { version: '2.0.0', license: 'ISC' })
  const none = pkg(root, 'cedar', { version: '3.0.0' })
  const empty = pkg(root, 'elm', { version: '4.0.0', license: 'MIT' }, { LICENSE: '' })
  const at = (dir: string) => ({ dir, place: 'runner/node_modules' as const })
  assert.throws(() => writeRunnerLicences(join(root, 'l1'), [at(a), at(isc)], []), /birch@2\.0\.0: ships no license file, and no other listed ISC package has the text/)
  assert.throws(() => writeRunnerLicences(join(root, 'l2'), [at(a), at(none)], []), /cedar@3\.0\.0: no license field or file/)
  assert.throws(() => writeRunnerLicences(join(root, 'l3'), [at(a), at(empty)], []), /elm@4\.0\.0: LICENSE is empty/)
  assert.throws(() => writeRunnerLicences(join(root, 'l4'), [at(join(root, 'node_modules', 'gone'))], []), /has no package\.json/)
  assert.throws(() => writeRunnerLicences(join(root, 'l5'), [], []), /no third-party package/)
})

test('Remotion is named as the Remotion License, and its packages without a file cite the text at their own version', () => {
  const root = scratch()
  const text = '# Remotion License\n\nDepending on the type of your legal entity.\n'
  const core = pkg(root, 'remotion', { version: '4.0.534', license: 'SEE LICENSE IN LICENSE.md' }, { 'LICENSE.md': text, 'THIRD_PARTY_LICENSES.md': 'others\n' })
  const media = pkg(root, '@remotion/media', { version: '4.0.534' })
  const sdk = pkg(root, '@remotion/sdk', { version: '4.0.534', license: 'Remotion License' })
  const fonts = pkg(root, '@remotion/fonts', { version: '4.0.534', license: 'MIT' })
  const mit = pkg(root, 'maple', { version: '1.0.0', license: 'MIT' }, { LICENSE: MIT })
  const at = (dir: string) => ({ dir, place: 'the render bundle' as const })
  const out = join(root, 'licenses')
  writeRunnerLicences(out, [core, media, sdk, fonts, mit].map(at), ['@remotion/compositor-darwin-arm64'])
  const notices = readFileSync(join(out, 'NOTICES.txt'), 'utf8')
  assert.ok(notices.includes('\nremotion 4.0.534\n  In: the render bundle\n  License: Remotion License (remotion-4.0.534/LICENSE.md, remotion-4.0.534/THIRD_PARTY_LICENSES.md)\n'))
  for (const name of ['@remotion/media', '@remotion/sdk']) {
    assert.ok(notices.includes(`\n${name} 4.0.534\n  In: the render bundle\n  License: Remotion License. The package ships no license file; its repository's license is in remotion-4.0.534/LICENSE.md.\n`), name)
  }
  // What a package declares is what is said of it: MIT here, with an MIT text.
  assert.ok(notices.includes('\n@remotion/fonts 4.0.534\n  In: the render bundle\n  License: MIT. The package ships no license file; the MIT text is in maple-1.0.0/LICENSE.\n'))
  assert.match(notices, /\nLeft out of the runner:\n  @remotion\/compositor-darwin-arm64: /)
  // Another version of remotion is not this package's licence.
  const other = pkg(join(root, 'x'), '@remotion/media', { version: '4.0.999' })
  assert.throws(() => writeRunnerLicences(join(root, 'l2'), [core, other].map(at), []), /@remotion\/media@4\.0\.999: ships no license file, and remotion 4\.0\.999 is not listed/)
})

test("a webpack bundle's packages are read from its source maps, and no map is an error", () => {
  const root = scratch()
  const bundle = join(root, 'bundle')
  mkdirSync(join(bundle, 'deep'), { recursive: true })
  writeFileSync(join(bundle, 'a.bundle.js.map'), JSON.stringify({ sources: ['webpack://x/./node_modules/react/index.js', '../web/node_modules/@scope/kit/a.js', 'webpack/bootstrap', '../web/src/a.ts'] }))
  writeFileSync(join(bundle, 'deep', 'b.bundle.js.map'), JSON.stringify({ sources: ['ignored|/somewhere/node_modules/@left/out', './node_modules/react/jsx-runtime.js'] }))
  const base = join(root, 'worker')
  assert.deepEqual(packagesInSourceMaps(bundle, base), [join(root, 'web/node_modules/@scope/kit'), join(base, 'node_modules/react')].sort())
  const bare = join(root, 'bare')
  mkdirSync(bare)
  writeFileSync(join(bare, 'index.html'), '')
  assert.throws(() => packagesInSourceMaps(bare, base), /no source maps/)
  writeFileSync(join(bare, 'a.bundle.js.map'), JSON.stringify({ version: 3 }))
  assert.throws(() => packagesInSourceMaps(bare, base), /no sources list/)
})

test('a script in the bundle with no map of its own is an error, outside the folders named', () => {
  const root = scratch()
  const bundle = join(root, 'bundle')
  mkdirSync(join(bundle, 'public', 'scene'), { recursive: true })
  writeFileSync(join(bundle, 'a.bundle.js'), '')
  writeFileSync(join(bundle, 'a.bundle.js.map'), JSON.stringify({ sources: ['./node_modules/react/index.js'] }))
  writeFileSync(join(bundle, 'public', 'scene', 'runtime.js'), '')
  assert.throws(() => packagesInSourceMaps(bundle, root), /runtime\.js has no source map/)
  assert.deepEqual(packagesInSourceMaps(bundle, root, ['public']), [join(root, 'node_modules/react')])
  writeFileSync(join(bundle, 'b.bundle.js'), '')
  assert.throws(() => packagesInSourceMaps(bundle, root, ['public']), /b\.bundle\.js has no source map/)
})

test('licence and notice files are told from code by name', () => {
  for (const name of ['LICENSE', 'license', 'LICENCE.md', 'License.txt', 'LICENSE-MIT', 'LICENSE_APACHE', 'LICENSE.MIT.txt', 'LICENSES', 'MIT-LICENSE', 'MIT-LICENSE.txt',
    'UNLICENSE', 'COPYING', 'COPYING.LESSER', 'COPYRIGHT', 'NOTICE', 'NOTICE.md', 'NOTICES.txt', 'ThirdPartyNotices.txt', 'THIRD-PARTY-NOTICES.txt', 'THIRD_PARTY_LICENSES.md', 'ThirdPartyNoticeText.txt']) {
    assert.ok(isLicenceFile(name), name)
  }
  for (const name of ['license.js', 'license-key.js', 'notice.ts', 'LICENSE.json', 'license.d.ts', 'README.md', 'licensing.md', 'package.json', 'copyright.py', 'notices.html']) {
    assert.ok(!isLicenceFile(name), name)
  }
})

test('code a package vendors keeps its licence: files below the top are copied at their path and cited apart', () => {
  const root = scratch()
  const dir = pkg(root, 'maple', { version: '1.0.0', license: 'MIT' }, { LICENSE: MIT })
  mkdirSync(join(dir, 'vendor', 'reed-patched'), { recursive: true })
  writeFileSync(join(dir, 'vendor', 'reed-patched', 'LICENSE'), 'MIT\n\nCopyright (c) 2014 Reed Example\n')
  writeFileSync(join(dir, 'vendor', 'reed-patched', 'index.js'), '')
  // A package nested in its node_modules is its own package, not this one's file.
  mkdirSync(join(dir, 'node_modules', 'inner'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'inner', 'LICENSE'), 'inner\n')
  assert.deepEqual(licenceFilesIn(dir), ['LICENSE', 'vendor/reed-patched/LICENSE'])
  const out = join(root, 'licenses')
  writeRunnerLicences(out, [{ dir, place: 'runner/node_modules' }], [])
  assert.equal(readFileSync(join(out, 'maple-1.0.0', 'vendor', 'reed-patched', 'LICENSE'), 'utf8'), 'MIT\n\nCopyright (c) 2014 Reed Example\n')
  assert.ok(readFileSync(join(out, 'NOTICES.txt'), 'utf8').includes('  License: MIT (maple-1.0.0/LICENSE)\n  Code it carries from elsewhere, under its own terms: maple-1.0.0/vendor/reed-patched/LICENSE\n'))
  // A vendored text is not the package's own: with none at its top, the package still has to cite one.
  const only = pkg(join(root, 'b'), 'birch', { version: '1.0.0', license: 'ISC' })
  mkdirSync(join(only, 'vendor'))
  writeFileSync(join(only, 'vendor', 'LICENSE'), 'ISC of someone else\n')
  assert.throws(() => writeRunnerLicences(join(root, 'l2'), [{ dir: only, place: 'runner/node_modules' }], []), /birch@1\.0\.0: ships no license file/)
})

test('an installed folder is listed whole: scoped packages and the ones npm nested inside another', () => {
  const root = scratch()
  pkg(root, 'maple', { version: '1.0.0' })
  pkg(root, '@fern/core', { version: '1.0.0' })
  pkg(join(root, 'node_modules', 'maple'), 'ws', { version: '7.0.0' })
  pkg(join(root, 'node_modules', '@fern', 'core'), '@oak/utils', { version: '2.0.0' })
  mkdirSync(join(root, 'node_modules', '.bin'))
  const nm = join(root, 'node_modules')
  assert.deepEqual(installedPackages(nm), [join(nm, '@fern/core'), join(nm, '@fern/core/node_modules/@oak/utils'), join(nm, 'maple'), join(nm, 'maple/node_modules/ws')])
  assert.deepEqual(installedPackages(join(root, 'none')), [])
})
