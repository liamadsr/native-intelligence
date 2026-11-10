/**
 * Inline script, first in <head>: every localStorage and sessionStorage key
 * saved under the old product prefix (`dial8:…`, `dial8-…`, `dial8.…`,
 * `dial8_…`) is copied to the same key under `ni`, before anything reads
 * storage.
 *
 * Copied, not moved: the desktop app's windows (the main one, the HUD, the
 * pop-outs) and a browser's tabs share one localStorage, and for a while after
 * a deploy some of them still run the build that reads the old keys. Taking
 * the keys away would send those back to their defaults.
 *
 * Once per storage (it leaves a mark): after the copy the `ni` keys are the
 * ones this build keeps up to date, so a later load must not bring back a
 * value the person has since changed or cleared from the old key beside it. A
 * key that already exists under the new name is left as it is for the same
 * reason. The mark is written before the copies, while there is room for it:
 * the copies can fill the storage, and a copy that could not be marked done
 * would run again on every load. Where even the mark does not fit, keys are
 * moved, which leaves nothing beside them to bring back.
 *
 * A value too large to hold twice (a custom background image) is moved
 * instead, so this build keeps it.
 *
 * A sweep that deletes keys by name takes the old copy with it
 * (lib/storage-key-rename.ts), and so does the sign-out wipe (state-wipe.ts).
 */
// TODO(rename-compat): one release after the rename, delete the old keys, then remove this script.
export const STORAGE_RENAME_MARK = 'ni:storage-renamed'
export const STORAGE_RENAME_SCRIPT = `
(function () {
  var old = /^dial8([:._-])/;
  var mark = '${STORAGE_RENAME_MARK}';
  function copy(storage) {
    if (storage.getItem(mark) !== null) return;
    var keys = [];
    for (var i = 0; i < storage.length; i++) {
      var key = storage.key(i);
      if (key && old.test(key)) keys.push(key);
    }
    var marked = true;
    try { storage.setItem(mark, '1'); } catch (_) { marked = false; }
    for (var j = 0; j < keys.length; j++) {
      try {
        var next = keys[j].replace(old, 'ni$1');
        if (storage.getItem(next) !== null) continue;
        var value = storage.getItem(keys[j]);
        if (value === null) continue;
        if (!marked) storage.removeItem(keys[j]);
        try {
          storage.setItem(next, value);
        } catch (_) {
          storage.removeItem(keys[j]);
          storage.setItem(next, value);
        }
      } catch (_) {}
    }
  }
  try { copy(window.localStorage); } catch (_) {}
  try { copy(window.sessionStorage); } catch (_) {}
})();
`

export function StorageRenameScript() {
  return <script dangerouslySetInnerHTML={{ __html: STORAGE_RENAME_SCRIPT }} />
}
