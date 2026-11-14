/**
 * The person's toolchains, for an agent whose HOME is private. Tools that
 * find themselves through HOME would see an empty home, so each toolchain
 * root of the folder fence's list (seatbelt.ts HOME_TOOLCHAIN_ALLOWLIST, which
 * the agent profile makes readable) that exists gets the variable that points
 * its tool at the person's own, READ-ONLY copy:
 *   - rustup: RUSTUP_HOME (its toolchains and settings). CARGO_HOME is NOT
 *     pointed there: cargo writes its registry and git caches, so it keeps its
 *     private default (`<home>/.cargo`), while the person's `~/.cargo/bin`
 *     stays on the tool PATH and readable;
 *   - nvm: NVM_DIR; volta: VOLTA_HOME; pyenv: PYENV_ROOT.
 * Go and bun need nothing: their binaries come from the tool PATH, and their
 * caches (GOPATH, GOMODCACHE, bun's install cache) belong in the private home,
 * where they are writable. Nothing of the real home becomes writable.
 */
import { join } from 'node:path'

/** Each variable, the folder (relative to HOME) it points at, and the folder that must exist for it to be set. */
const TOOLCHAIN_VARS = [
  { name: 'RUSTUP_HOME', root: '.rustup', present: '.rustup/toolchains' },
  { name: 'NVM_DIR', root: '.nvm', present: '.nvm' },
  { name: 'VOLTA_HOME', root: '.volta', present: '.volta' },
  { name: 'PYENV_ROOT', root: '.pyenv', present: '.pyenv' },
] as const

export function toolchainEnv(realHome: string, exists: (p: string) => boolean): Record<string, string> {
  const env: Record<string, string> = {}
  for (const v of TOOLCHAIN_VARS) if (exists(join(realHome, v.present))) env[v.name] = join(realHome, v.root)
  return env
}
