#!/usr/bin/env bash
# Prints a join token for a test call, valid for 15 minutes and for one room only
# (`check`, or the one named), so that a browser can join LiveKit from your own
# machine (../README.md step 23). The token is for that room alone; the key pair it
# is signed with is read here, on the server, and never shown.
#
#   sudo ./test-token.sh <identity> [room]
#
# Each person in the test call needs a token of their own: run it once per
# identity (for example `laptop` and `phone`).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
[ "$(id -u)" = 0 ] || { echo "Run it with sudo: .env is root's alone." >&2; exit 1; }
identity="${1:?usage: sudo ./test-token.sh <identity> [room]}"
room="${2:-check}"
[[ "$identity" =~ ^[A-Za-z0-9_-]{1,64}$ && "$room" =~ ^[A-Za-z0-9_-]{1,64}$ ]] ||
	{ echo "The identity and the room are letters, digits, - and _ only." >&2; exit 1; }

# The token is made as livekit-server-sdk's AccessToken makes one: HS256, the key
# as issuer, the identity as subject, the grants under "video".
python3 -I - "$here/.env" "$identity" "$room" <<'PY'
import base64, hashlib, hmac, json, re, sys, time

path, identity, room = sys.argv[1:4]
env = {}
for line in open(path).read().split("\n"):
    m = re.match(r"(LIVEKIT_API_KEY|LIVEKIT_API_SECRET)=(.*)$", line)
    if m:
        env[m.group(1)] = m.group(2).strip().strip("'\"")
key, secret = env.get("LIVEKIT_API_KEY", ""), env.get("LIVEKIT_API_SECRET", "")
if not key or not secret:
    sys.exit("No key pair in %s yet: sudo ./make-keys.sh" % path)

def b64(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()

now = int(time.time())
claims = {"iss": key, "sub": identity, "nbf": now - 10, "exp": now + 15 * 60,
          "video": {"roomJoin": True, "room": room, "canPublish": True, "canSubscribe": True}}
head = b64(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
body = b64(json.dumps(claims, separators=(",", ":")).encode())
sig = b64(hmac.new(secret.encode(), ("%s.%s" % (head, body)).encode(), hashlib.sha256).digest())
print("%s.%s.%s" % (head, body, sig))
print("(for %s in room %s, valid 15 minutes)" % (identity, room), file=sys.stderr)
PY
