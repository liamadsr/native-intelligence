import { defineConfig } from 'tsup'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
// Repo root is two levels up from packages/ui
const repoSrc = path.resolve(here, '../../src')

/**
 * Builds @native-intelligence/ui from the app's own source.
 *
 * The barrel (src/index.ts) re-exports the presentational components that live
 * in the Next.js app at <repo>/src/components/**. Those files import via the
 * `@/` path alias (e.g. `@/lib/utils`), so we map `@` -> <repo>/src here.
 *
 * Everything third-party is externalized: the published dist imports React,
 * Radix, lucide, etc. as bare specifiers. design-sync's esbuild pass resolves
 * them against the repo's node_modules when it bundles for claude.ai/design.
 */
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  dts: true,
  sourcemap: false,
  clean: true,
  treeshake: true,
  splitting: false,
  // Preserve the "use client" directives shadcn components carry.
  banner: { js: '"use client";' },
  esbuildOptions(options) {
    options.alias = {
      ...(options.alias ?? {}),
      '@': repoSrc,
    }
    options.jsx = 'automatic'
  },
  // Bundle nothing third-party; ship bare specifiers.
  external: [
    'react',
    'react-dom',
    'react/jsx-runtime',
    /^@radix-ui\//,
    /^@emoji-mart\//,
    'lucide-react',
    'class-variance-authority',
    'clsx',
    'tailwind-merge',
    'cmdk',
    'date-fns',
    'react-day-picker',
    'react-aria-components',
    'react-hook-form',
    'react-resizable-panels',
    'react-markdown',
    'remark-gfm',
    'remark-breaks',
    'marked',
    'shiki',
    'embla-carousel-react',
    'use-stick-to-bottom',
    'framer-motion',
  ],
})
