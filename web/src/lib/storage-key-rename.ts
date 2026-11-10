// TODO(rename-compat): remove with components/storage-rename-script.tsx, once the old keys are deleted.
/**
 * A storage key as it is named since the rename: `dial8-x` becomes `ni-x` (the
 * four prefix forms the storage rename script copies), any other key is
 * returned unchanged.
 *
 * The script leaves each old key beside its copy for a release. A sweep that
 * deletes keys by name tests the name through this and removes the key it
 * walked, so the copy under the old name goes too: otherwise what the sweep
 * meant to delete would stay in storage.
 */
export function storageKeyAfterRename(key: string): string {
  return key.replace(/^dial8([:._-])/, 'ni$1')
}
