#!/bin/bash
# Cloud browser base image (docs/plans/cloud-browser.md, C0). Runs ONCE inside a
# fresh `vercel/sandbox/universal` (Ubuntu) sandbox, from build-base-snapshot.sh;
# the result is snapshotted and every person's browser is created from it.
# Installs Xvfb, Google Chrome stable, x11vnc (C3's live view) and fonts, sets
# Chrome's policies, and bakes the start/stop scripts into /opt/cloud-browser.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  xvfb x11vnc fonts-liberation fonts-noto-color-emoji fonts-noto-cjk curl ca-certificates iproute2 >/dev/null
arch=$(dpkg --print-architecture)
curl -fsSLo /tmp/chrome.deb "https://dl.google.com/linux/direct/google-chrome-stable_current_${arch}.deb"
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq /tmp/chrome.deb >/dev/null
rm -f /tmp/chrome.deb
# Chrome's own updater can't run here; the base snapshot is rebuilt to update.
sudo rm -f /etc/cron.daily/google-chrome /etc/apt/sources.list.d/google-chrome.list

# Chrome policies (C3, C4): WebRTC only over the proxy, so no UDP leaves around
# the Mac exit; no downloads, even with a person driving and no relay attached.
sudo mkdir -p /etc/opt/chrome/policies/managed
echo '{"WebRtcIPHandling":"disable_non_proxied_udp","DownloadRestrictions":3}' | sudo tee /etc/opt/chrome/policies/managed/dial8.json >/dev/null

sudo mkdir -p /opt/cloud-browser
sudo install -m 0755 "$HERE/start.sh" "$HERE/stop.sh" /opt/cloud-browser/
sudo install -m 0644 "$HERE/close-chrome.mjs" /opt/cloud-browser/

# The profile: restore the previous session's tabs on start, so a resumed
# browser comes back where it was (session cookies included).
mkdir -p /home/ubuntu/profile/Default
[ -f /home/ubuntu/profile/Default/Preferences ] || echo '{"session":{"restore_on_startup":1}}' > /home/ubuntu/profile/Default/Preferences

echo "base ready: $(/opt/google/chrome/chrome --version 2>/dev/null); node $(node --version)"
