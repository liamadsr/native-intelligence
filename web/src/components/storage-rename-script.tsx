/**
 * Inline script, first in <head>: every localStorage and sessionStorage key
 * saved under the old product prefix (`dial8:…`, `dial8-…`, `dial8.…`,
 * `dial8_…`) moves to the same key under `ni`, before anything reads storage.
 * A key that already exists under the new name wins; the old one is dropped.
 *
 * It removes before it writes, so a large value (a custom background image)
 * never has to fit in storage twice.
 */
// TODO(rename-compat): remove once browsers that opened the app before the rename have all loaded this once.
export const STORAGE_RENAME_SCRIPT = `
(function () {
  var old = /^dial8([:._-])/;
  function move(storage) {
    var keys = [];
    for (var i = 0; i < storage.length; i++) {
      var key = storage.key(i);
      if (key && old.test(key)) keys.push(key);
    }
    for (var j = 0; j < keys.length; j++) {
      try {
        var next = keys[j].replace(old, 'ni$1');
        var value = storage.getItem(keys[j]);
        storage.removeItem(keys[j]);
        if (value !== null && storage.getItem(next) === null) storage.setItem(next, value);
      } catch (_) {}
    }
  }
  try { move(window.localStorage); } catch (_) {}
  try { move(window.sessionStorage); } catch (_) {}
})();
`

export function StorageRenameScript() {
  return <script dangerouslySetInnerHTML={{ __html: STORAGE_RENAME_SCRIPT }} />
}
