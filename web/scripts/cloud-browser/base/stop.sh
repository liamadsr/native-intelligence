#!/bin/bash
# Close Chrome gracefully before the session stops: its last ~30 s of cookie
# writes reach disk and no stale profile lock is left. Kills it after 10 s.
# Then stops Xvfb and clears its lock, so the next session's start is clean.
set -u
node /opt/cloud-browser/close-chrome.mjs || true
for _ in $(seq 100); do
  pgrep -f '^/opt/google/chrome/chrome --user-data-dir=' >/dev/null || break
  sleep 0.1
done
pkill -f '^/opt/google/chrome/chrome --user-data-dir=' || true
pkill -x Xvfb || true
for _ in $(seq 30); do pgrep -x Xvfb >/dev/null || break; sleep 0.1; done
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
exit 0
