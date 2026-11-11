#!/usr/bin/env bash
# One test recording through Egress, from a room people are in (made with
# test-token.sh), into the Storage bucket (../README.md step 23, "Egress").
#
#   sudo ./test-egress.sh track [room] [seconds]       the first audio track found, as an
#                                                      .ogg file: what call notes use
#   sudo ./test-egress.sh composite [room] [seconds]   the whole room, video and sound, as
#                                                      an .mp4 (Chrome): to measure its CPU
#
# Defaults: room `check`, 20 seconds (composite: 60). It starts the recording through
# LiveKit's API, waits, stops it, and waits for Egress to say where the file went.
# Files land under checks/ in the bucket. The key pair is read here and never shown.
#
# Settings:
#   LIVEKIT_API_URL   where LiveKit's API is (default: https:// and LIVEKIT_HOST in
#                     ../edge/.env, or livekit.nativeintelligence.dev)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
[ "$(id -u)" = 0 ] || { echo "Run it with sudo: .env is root's alone." >&2; exit 1; }
kind="${1:-}"
case "$kind" in track) seconds="${3:-20}" ;; composite) seconds="${3:-60}" ;; *) echo "usage: sudo ./test-egress.sh track|composite [room] [seconds]" >&2; exit 2 ;; esac
room="${2:-check}"
[[ "$room" =~ ^[A-Za-z0-9_-]{1,64}$ && "$seconds" =~ ^[0-9]{1,4}$ ]] || { echo "The room is letters, digits, - and _; seconds a number." >&2; exit 1; }

api="${LIVEKIT_API_URL:-}"
if [ -z "$api" ]; then
	host=""
	[ -f "$here/../edge/.env" ] && host="$(sed -n 's/^LIVEKIT_HOST=//p' "$here/../edge/.env" | tail -n 1 | tr -d "'\"")"
	api="https://${host:-livekit.nativeintelligence.dev}"
fi

python3 -I - "$here/.env" "$kind" "$room" "$seconds" "$api" <<'PY'
import base64, hashlib, hmac, json, re, sys, time, urllib.error, urllib.request

path, kind, room, seconds, api = sys.argv[1:6]
seconds = int(seconds)
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

def token(video):
    now = int(time.time())
    claims = {"iss": key, "nbf": now - 10, "exp": now + 600, "video": video}
    head = b64(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    body = b64(json.dumps(claims, separators=(",", ":")).encode())
    sig = b64(hmac.new(secret.encode(), ("%s.%s" % (head, body)).encode(), hashlib.sha256).digest())
    return "%s.%s.%s" % (head, body, sig)

def call(service, method, body, video):
    request = urllib.request.Request(
        "%s/twirp/livekit.%s/%s" % (api.rstrip("/"), service, method), data=json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + token(video), "Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=30) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        detail = e.read()[:300].decode(errors="replace")
        hint = ""
        if service == "Egress" and e.code == 503:
            hint = "\nNo Egress took the job: is it running and healthy (COMPOSE_PROFILES=egress, sudo docker compose ps)?"
        sys.exit("%s/%s: %d %s%s" % (service, method, e.code, detail, hint))
    except (urllib.error.URLError, OSError) as e:
        sys.exit("LiveKit's API did not answer at %s (%s)" % (api, e))

def get(d, *names):
    for n in names:
        if n in d:
            return d[n]
    return None

stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
if kind == "track":
    people = get(call("RoomService", "ListParticipants", {"room": room}, {"roomAdmin": True, "room": room}), "participants") or []
    audio = [(p.get("identity"), t) for p in people for t in (p.get("tracks") or []) if get(t, "type") in ("AUDIO", 0)]
    if not audio:
        sys.exit("Nobody in room %s publishes sound. Join it first (test-token.sh), with the microphone on." % room)
    who, track = audio[0]
    print("Recording the sound of %s (track %s) for %d seconds..." % (who, track.get("sid"), seconds))
    started = call("Egress", "StartTrackEgress",
                   {"room_name": room, "track_id": track.get("sid"), "file": {"filepath": "checks/%s-%s-%s.ogg" % (room, who, stamp)}},
                   {"roomRecord": True})
else:
    print("Recording room %s, video and sound, for %d seconds. Measure meanwhile, in another terminal:" % (room, seconds))
    print("   sudo docker stats ni-livekit-egress")
    started = call("Egress", "StartRoomCompositeEgress",
                   {"room_name": room, "layout": "grid", "file_outputs": [{"file_type": "MP4", "filepath": "checks/%s-%s.mp4" % (room, stamp)}]},
                   {"roomRecord": True})
egress = get(started, "egress_id", "egressId")
print("Egress %s: %s" % (egress, get(started, "status")))
time.sleep(seconds)
call("Egress", "StopEgress", {"egress_id": egress}, {"roomRecord": True})
for _ in range(60):
    items = get(call("Egress", "ListEgress", {"egress_id": egress}, {"roomRecord": True}), "items") or [{}]
    info = items[0]
    status = get(info, "status")
    if status in ("EGRESS_COMPLETE", "EGRESS_FAILED", "EGRESS_ABORTED", "EGRESS_LIMIT_REACHED", 3, 4, 5, 6):
        break
    time.sleep(2)
files = get(info, "file_results", "fileResults") or ([get(info, "file")] if get(info, "file") else [])
print("Status: %s%s" % (status, (" (%s)" % get(info, "error")) if get(info, "error") else ""))
for f in files:
    if f:
        print("File: %s, %s bytes, %s" % (get(f, "filename"), get(f, "size"), get(f, "location")))
sys.exit(0 if status in ("EGRESS_COMPLETE", 3) else 1)
PY
