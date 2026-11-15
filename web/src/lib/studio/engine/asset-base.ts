// Where an asset's bytes are fetched from in the browser preview. An asset is named by its `file`
// ("assets/<sha256>.<ext>"); the page that shows the preview says which address serves those names (the Studio
// sets it to its workspace's file route when it opens). A render never asks: it stages the files beside the
// bundle and reads them from there (composition.tsx, staticFile).
//
// A file can also be served from the computer the preview runs on: the Mac app opens a take at Stop from its own
// files while the Studio files them (components/studio/record/provisional.ts), and keeps playing them from there.
let base = '/';
const local = new Map<string, string>();
export const setAssetBase = (next: string) => { base = next.endsWith('/') ? next : `${next}/`; };
/** Serve `file` from `href` in the preview (null: from the Studio again). */
export const setLocalAsset = (file: string, href: string | null) => { if (href) local.set(file, href); else local.delete(file); };
export const assetHref = (file: string) => local.get(file) ?? `${base}${file}`;
