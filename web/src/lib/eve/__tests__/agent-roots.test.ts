/**
 * Layout guards for the eve agent roots under agents/.
 *
 * 1. NO agent-local package.json / lockfile. eve 0.66 resolves an agent's
 *    project by walking up to the NEAREST package.json, so a stray
 *    agents/<name>/package.json makes `eve dev`/`eve build` fail with "No eve
 *    project contains agents/<name>" and silently drops the agent from
 *    workspace auto-discovery. These files appeared once already: eve's dev
 *    server auto-installs a missing optional sandbox engine with
 *    `npm install --save-dev <pkg>` in the AGENT directory
 *    (internal/application/optional-package-install.js), which creates one.
 *
 * 2. microsandbox is a ROOT devDependency at exactly the version eve installs,
 *    so it resolves from the root node_modules and eve never auto-installs it
 *    (which is what created those files). Local-dev egress narrowing for the
 *    coding-agent depends on it (agents/coding-agent/sandbox.ts).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(__dirname, '../../../..')
const agentsDir = join(repoRoot, 'agents')
const agentNames = readdirSync(agentsDir).filter((n) => statSync(join(agentsDir, n)).isDirectory())

describe('eve agent roots', () => {
  it('finds the agent roots', () => {
    expect(agentNames.length).toBeGreaterThanOrEqual(6)
  })

  it.each(agentNames)('agents/%s has no package.json or lockfile of its own', (name) => {
    for (const file of ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock']) {
      expect(existsSync(join(agentsDir, name, file)), `agents/${name}/${file} must not exist`).toBe(false)
    }
  })

  it('microsandbox is a root devDependency pinned to the exact version eve auto-installs', () => {
    const rootPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      devDependencies?: Record<string, string>
    }
    const eveRoot = dirname(createRequire(import.meta.url).resolve('eve/package.json'))
    const runtime = readFileSync(
      join(eveRoot, 'dist/src/execution/sandbox/bindings/microsandbox-runtime.js'),
      'utf8',
    )
    const specifier = runtime.match(/MICROSANDBOX_INSTALL_SPECIFIER=`\$\{MICROSANDBOX_PACKAGE_NAME\}@([^`]+)`/)
    expect(specifier, 'eve changed how it pins microsandbox — re-check this guard').not.toBeNull()
    expect(rootPkg.devDependencies?.microsandbox).toBe(specifier![1])
  })
})
