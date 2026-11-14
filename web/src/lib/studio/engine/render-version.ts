/**
 * The version of what draws an export or makes its sound, compared between the Studio on the server and the engine the
 * desktop app bundles (an export run on the person's own computer, job-contract.ts `local-export`): the server refuses a
 * local export whose version is not its own, and that video is exported on the server instead.
 *
 * What it covers (__tests__/render-version.test.ts, RENDER_ROOTS): every file the render's entry point (remotion.tsx)
 * reaches, and the worker's export path (its Chrome render, its composition without the browser, its sound, fonts,
 * scenes and mastering) with every file they reach through relative and `@/` imports and `require`, less the encoders
 * (a different encoder on a computer is not a different render); and the `remotion` and `@remotion/*` versions both
 * lockfiles resolve. Their contents, line ends made LF, hash to `sources`.
 *
 * A ledger, never edited, only added to: when what it covers changes, the test fails and prints the line to add (a NEW
 * version, the new hash, its chain). `chain` is the hash of the line before's chain, this version and these sources,
 * so an earlier line edited breaks every chain after it. Constants only: the desktop app's bundle reads this file as it is.
 */
export const RENDER_LEDGER: readonly { version: string; sources: string; chain: string }[] = [
  { version: '2026-11-13.1', sources: '7fd1abe8aa525f7845d98849e621217ed56ecadf423064ded4a5daa5b4d14eca', chain: '4c195adea127766191597565ca278e04e2e80b534aac41761431a1a56dc3723a' },
  { version: '2026-11-13.2', sources: '8dc5de3dab78479fc1672f053e39ad29d31c0a606dc40ebc58f5d08a509e6e1b', chain: 'c6b6e0818e67ca28195340bb906336d4d9f426144158837abc0364b20439b786' },
  { version: '2026-11-13.3', sources: 'c7718ec862ffdbda7f0357890ab975d112fe4c2a0c81085e373bed6e3db8ddad', chain: '08d69a13412d03f2b25a97c8edee7e756e2bf8c39d5f4aa72d229a391ccda366' },
  { version: '2026-11-13.4', sources: '6d3fde2d8cb4005b55dd72360842c3751e33c33c6df7e8ca6b06a9310b7e5228', chain: 'fd1c3e92b9ebf9b026b24e6f6c9ebc9751d148c59679cf35c002efc0930cb927' },
  { version: '2026-11-14.1', sources: 'c3ba46c5e0028affc217384b63e1e3a6c0e22e562e541326558968471f9a2232', chain: '75ac91e9ab7f781baeedb263e22d9a09200bddefb539b0d83da83d7067f2c0ca' },
  { version: '2026-11-14.2', sources: 'a975c2bc4fdef2831b16791b99f271d675e680d0deeaa03dde7ad289291804a3', chain: '8c60d789b78b6e10f7275f0d9fbbb714301ee446f1983db71e892213ef751f29' },
  { version: '2026-11-14.3', sources: 'fd8f085c6f0f3dfdfd14ac1ae46333fd66164a1d1d6e6e71f65421a6d0c90e59', chain: '5e8e97e450136168f9f73fa1a3629b849765df47a6f7468b7fdc65706b7a18cb' },
  { version: '2026-11-14.4', sources: 'bb6085ee5cd770191ff25ecafbd5f73712db3b54291b898818e9b87808b0d858', chain: 'cc3d3e1958ac6e78eca3476a49c810bb3742735fdf84cbac2bb2b957d19db1df' },]

/** The version in force: the ledger's last line. */
export const STUDIO_RENDER_VERSION = RENDER_LEDGER[RENDER_LEDGER.length - 1]!.version
