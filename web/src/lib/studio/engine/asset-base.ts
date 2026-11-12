// Where an asset's bytes are fetched from in the browser preview. An asset is named by its `file`
// ("assets/<sha256>.<ext>"); the page that shows the preview says which address serves those names (the Studio
// sets it to its workspace's file route when it opens). A render never asks: it stages the files beside the
// bundle and reads them from there (composition.tsx, staticFile).
let base = '/';
export const setAssetBase = (next: string) => { base = next.endsWith('/') ? next : `${next}/`; };
export const assetHref = (file: string) => `${base}${file}`;
