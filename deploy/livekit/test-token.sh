#!/usr/bin/env bash
# Makes the test room (if it is not there yet) and prints a join token for it, valid
# for 15 minutes and for that room only (`check`, or the one named), so that a browser
# can join LiveKit from your own machine (../README.md step 23). LiveKit makes no
# room for a token (room.auto_create is off in compose.yaml), so the room is made
# first, through LiveKit's server API, the way the app makes the rooms of its calls.
# The key pair everything is signed with is read here, on the server, and never shown.
#
#   sudo ./test-token.sh <identity> [room]
#
# Each person in the test call needs a token of their own: run it once per identity
# (for example `laptop` and `phone`). The room stays for 15 minutes while nobody is
# in it, and for 5 minutes after the last person leaves; then it is gone, and a new
# run makes it again.
#
# Settings:
#   LIVEKIT_API_URL   where LiveKit's API is (default: https:// and LIVEKIT_HOST in
#                     ../edge/.env, or livekit.nativeintelligence.dev)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
[ "$(id -u)" = 0 ] || { echo "Run it with sudo: .env is root's alone." >&2; exit 1; }
identity="${1:?usage: sudo ./test-token.sh <identity> [room]}"
room="${2:-check}"
[[ "$identity" =~ ^[A-Za-z0-9_-]{1,64}$ && "$room" =~ ^[A-Za-z0-9_-]{1,64}$ ]] ||
	{ echo "The identity and the room are letters, digits, - and _ only." >&2; exit 1; }

api="${LIVEKIT_API_URL:-}"
if [ -z "$api" ]; then
	host=""
	[ -f "$here/../edge/.env" ] && host="$(sed -n 's/^LIVEKIT_HOST=//p' "$here/../edge/.env" | tail -n 1 | tr -d "'\"")"
	api="https://${host:-livekit.nativeintelligence.dev}"
fi

# Tokens are made as livekit-server-sdk's AccessToken makes them: HS256, the key as
# issuer, the identity as subject, the grants under "video".
python3 -I - "$here/.env" "$identity" "$room" "$api" <<'PY'
import base64, hashlib, hmac, json, re, sys, time, urllib.error, urllib.request

path, identity, room, api = sys.argv[1:5]
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

def token(claims):
    now = int(time.time())
    claims = dict(claims, iss=key, nbf=now - 10, exp=now + 15 * 60)
    head = b64(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    body = b64(json.dumps(claims, separators=(",", ":")).encode())
    sig = b64(hmac.new(secret.encode(), ("%s.%s" % (head, body)).encode(), hashlib.sha256).digest())
    return "%s.%s.%s" % (head, body, sig)

# The room first: CreateRoom answers with the room as it is when it exists already.
request = urllib.request.Request(
    api.rstrip("/") + "/twirp/livekit.RoomService/CreateRoom",
    data=json.dumps({"name": room, "empty_timeout": 900, "departure_timeout": 300}).encode(),
    headers={"Authorization": "Bearer " + token({"video": {"roomCreate": True}}), "Content-Type": "application/json"},
    method="POST")
try:
    with urllib.request.urlopen(request, timeout=20) as r:
        made = json.loads(r.read() or b"{}")
except urllib.error.HTTPError as e:
    sys.exit("LiveKit refused to make the room %s (%d): %s" % (room, e.code, e.read()[:200].decode(errors="replace")))
except (urllib.error.URLError, OSError) as e:
    sys.exit("LiveKit's API did not answer at %s (%s). Is LIVEKIT_HOST in ../edge/.env, or LIVEKIT_API_URL, right?" % (api, e))

print(token({"sub": identity, "video": {"roomJoin": True, "room": room, "canPublish": True, "canSubscribe": True}}))
print("(for %s in room %s, %s; valid 15 minutes)" % (identity, room, made.get("sid") or "made"), file=sys.stderr)
PY
