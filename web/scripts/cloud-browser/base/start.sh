#!/bin/bash
# Start the cloud browser: Xvfb, then Chrome on it with CDP on 127.0.0.1:9222.
# Idempotent, and serialized: the host runs it on every ensure, and two ensures
# can race. Exits 0 once Chrome answers on CDP.
#
# The host launches this DETACHED and polls CDP itself: a sandbox command that
# leaves Chrome and Xvfb running never counts as finished to the API. A failure
# is written to $FAILED, which the host's poll reads.
set -u
FAILED=/tmp/cloud-browser-start.failed
rm -f "$FAILED"
# Only our own message: Chrome's log can hold URLs, and this ends up in errors.
fail() { echo "$1" > "$FAILED"; echo "$1" >&2; exit 1; }
exec 9>/tmp/cloud-browser-start.lock
flock -w 60 9 || fail "another start held the lock for 60 s"
# Everything launched below closes fd 9 (`9>&-`): a long-lived child holding the
# lock's descriptor would keep the lock held, and the next start would wait forever.

PROFILE=/home/ubuntu/profile
CHROME=/opt/google/chrome/chrome
export DISPLAY=:99

sudo mkdir -p /tmp/.X11-unix && sudo chmod 1777 /tmp/.X11-unix
if ! pgrep -x Xvfb >/dev/null; then
  # A session that ended without stop.sh leaves the display's lock and socket;
  # with them, Xvfb refuses to start (or the wait below passes on a dead socket).
  rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
  setsid nohup Xvfb :99 -screen 0 1280x800x24 -nolisten tcp >/tmp/xvfb.log 2>&1 </dev/null 9>&- &
fi
for _ in $(seq 50); do [ -S /tmp/.X11-unix/X99 ] && break; sleep 0.1; done
[ -S /tmp/.X11-unix/X99 ] || fail "Xvfb did not start"

if ! pgrep -f "^$CHROME --user-data-dir=$PROFILE" >/dev/null; then
  # A session that ended without a clean Chrome exit leaves these behind, and a
  # resumed session has a new hostname: Chrome would refuse the profile as "in
  # use on another computer" and never open CDP.
  rm -f "$PROFILE/SingletonLock" "$PROFILE/SingletonSocket" "$PROFILE/SingletonCookie"
  # Its only way out is the relay's SOCKS proxy (C4): through the person's Mac,
  # or from the cloud, as the relay chooses; with no relay, no network at all.
  # No back/forward cache: a restored page never runs past the agent's guard (C1).
  setsid nohup "$CHROME" --user-data-dir="$PROFILE" \
    --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 \
    --proxy-server=socks5://127.0.0.1:1080 --disable-back-forward-cache \
    --no-first-run --no-default-browser-check \
    --window-position=0,0 --window-size=1280,800 >/tmp/chrome.log 2>&1 </dev/null 9>&- &
fi
for _ in $(seq 150); do
  if curl -s -m 1 127.0.0.1:9222/json/version >/dev/null; then exit 0; fi
  sleep 0.1
done
fail "Chrome did not open CDP within 15 s"
