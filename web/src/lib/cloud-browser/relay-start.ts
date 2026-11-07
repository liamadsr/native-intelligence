import { CLOUD_BROWSER } from './config'
import { RELAY_MARK_HEADER } from './relay-token'

/**
 * Fetch and start the relay for this app build, unless it already runs (C2);
 * with a viewer key, also the two VNC servers the hub gates (C3): one
 * view-only, one that takes input. Both listen on unix sockets in a 0700
 * directory, never TCP, with no password: only the hub reaches them (a page in
 * Chrome can reach a loopback port, never a socket file). The script serializes itself.
 *
 * Run by host.ts `startRelay` with: origin, build, dir, hub port, sandbox,
 * viewer key, and the exit mode its browser had (C4: a new relay starts in it);
 * and by scripts/cloud-browser/live-check on a test sandbox.
 */
export const RELAY_START = `set -u
ORIGIN="$1"; BUILD="$2"; DIR="$3"; HUB_PORT="$4"; SANDBOX="$5"; VIEWER_KEY="$6"; EXIT_MODE="\${7:-cloud}"
exec 9>/tmp/cloud-browser-relay.lock
flock -w 30 9 || exit 1
if [ -n "$VIEWER_KEY" ]; then
  mkdir -p ${CLOUD_BROWSER.vncDir} && chmod 700 ${CLOUD_BROWSER.vncDir}
  # Never a VNC server on a TCP port, whatever started it.
  pkill -f "^x11vnc -display :99 -localhost"
  # No TCP listener at all: -rfbport 0 drops IPv4, and IPv6 needs -rfbportv6 0 too (else [::]:5900). A socket left by a crashed server is removed first.
  pgrep -f "^x11vnc -display :99 -unixsock ${CLOUD_BROWSER.vncViewSocket} " >/dev/null || { rm -f ${CLOUD_BROWSER.vncViewSocket};
    x11vnc -display :99 -unixsock ${CLOUD_BROWSER.vncViewSocket} -rfbport 0 -rfbportv6 0 -noipv6 -viewonly -shared -forever -nopw -noprimary -quiet -bg -o /tmp/x11vnc-view.log 9>&- >/dev/null 2>&1; }
  pgrep -f "^x11vnc -display :99 -unixsock ${CLOUD_BROWSER.vncControlSocket} " >/dev/null || { rm -f ${CLOUD_BROWSER.vncControlSocket};
    x11vnc -display :99 -unixsock ${CLOUD_BROWSER.vncControlSocket} -rfbport 0 -rfbportv6 0 -noipv6 -shared -forever -nopw -noprimary -quiet -bg -o /tmp/x11vnc-control.log 9>&- >/dev/null 2>&1; }
fi
if [ "$(cat "$DIR/build" 2>/dev/null)" = "$BUILD" ] && pgrep -f "^node $DIR/relay.mjs" >/dev/null; then exit 0; fi
# The old relay frees the hub's port as it exits; never start beside it.
pkill -f "^node $DIR/relay.mjs"
for _ in $(seq 30); do pgrep -f "^node $DIR/relay.mjs" >/dev/null || break; sleep 0.1; done
pkill -9 -f "^node $DIR/relay.mjs"
mkdir -p "$DIR"; rm -f "$DIR/build"
for f in relay.mjs agent_runtime.js; do
  # Only a 200 is the file: a redirect's body ("Redirecting...") would run as the relay.
  code=$(curl -sS --retry 2 -m 20 -H '${RELAY_MARK_HEADER}: 1' "$ORIGIN/cloud-browser/$f?b=$BUILD" -o "$DIR/$f.new" -w '%{http_code}') || code=error
  [ "$code" = 200 ] || { echo "fetch $f failed ($code)" > "$DIR/failed"; exit 1; }
  mv "$DIR/$f.new" "$DIR/$f"
done
rm -f "$DIR/failed"; echo "$BUILD" > "$DIR/build"
if [ -n "$VIEWER_KEY" ]; then HUB="--hub-port $HUB_PORT --sandbox $SANDBOX --viewer-key $VIEWER_KEY"; else HUB=""; fi
setsid node "$DIR/relay.mjs" --origin "$ORIGIN" --exit-mode "$EXIT_MODE" $HUB </dev/null >>/tmp/cloud-browser-relay.log 2>&1 9>&- &`

/**
 * What startRelay reads back after RELAY_START: one `key=value` line each, so
 * a file that ends in a newline (the build file does) never shifts the rest.
 * `hub` only when the relay runs the live view's hub.
 */
export function relayProbeScript(dir: string, hubPort: number | null): string {
  return [
    `printf 'build=%s\\n' "$(cat ${dir}/build 2>/dev/null)"`,
    `pgrep -f '^node ${dir}/relay.mjs' >/dev/null && echo up=1`,
    `printf 'failed=%s\\n' "$(head -c 200 ${dir}/failed 2>/dev/null | tr '\\n' ' ')"`,
    hubPort ? `printf 'hub=%s\\n' "$(curl -s -m 1 -o /dev/null -w '%{http_code}' 127.0.0.1:${hubPort}/health)"` : '',
  ].filter(Boolean).join('; ')
}

export interface RelayProbe { build: string; up: boolean; failed: string; hub: string | null }

export function readRelayProbe(stdout: string): RelayProbe {
  const fields = new Map(stdout.split('\n').filter(line => line.includes('=')).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1).trim()]))
  return { build: fields.get('build') ?? '', up: fields.get('up') === '1', failed: fields.get('failed') ?? '', hub: fields.get('hub') ?? null }
}
