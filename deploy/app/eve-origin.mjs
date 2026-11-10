#!/usr/bin/env node
// Prints the origin the web role sends /eve/<name>/v1/* to.
//
// `next build` writes it into .next/routes-manifest.json: eve's withEve turns
// EVE_NEXT_PRODUCTION_ORIGIN into one rewrite per agent,
//   /eve/<name>/v1/:path+  ->  <origin>/_eve_internal/eve/<name>/eve/v1/:path+
// and `next start` routes by that file, whatever EVE_NEXT_PRODUCTION_ORIGIN holds
// then. So the manifest is the one true answer. The Dockerfile checks it against
// the build argument, and entrypoint.sh against the container's environment.
//
// Exits 1 unless every agent rewrite points at the same absolute origin (a build on
// Vercel, or with no origin set, does not).
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const manifestPath = join(here, '..', '..', 'web', '.next', 'routes-manifest.json')

function fail(message) {
  console.error(`eve-origin: ${message}`)
  process.exit(1)
}

let manifest
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
} catch (error) {
  fail(`cannot read ${manifestPath}: ${error.message}`)
}
const rewrites = Array.isArray(manifest.rewrites)
  ? manifest.rewrites
  : [...(manifest.rewrites?.beforeFiles ?? []), ...(manifest.rewrites?.afterFiles ?? []), ...(manifest.rewrites?.fallback ?? [])]
const agents = rewrites.filter(rewrite => /^\/eve\/[a-z][a-z-]*\/v1\//.test(rewrite.source))
if (agents.length === 0) fail('the build has no /eve/<name>/v1/* rewrites')

const origins = new Set(
  agents.map(rewrite => {
    const url = URL.parse(rewrite.destination)
    if (!url) fail(`${rewrite.source} goes to ${rewrite.destination}, not to an origin: was this built on Vercel?`)
    return url.origin
  }),
)
if (origins.size !== 1) fail(`the agent rewrites point at ${origins.size} origins: ${[...origins].join(', ')}`)
console.log([...origins][0])
