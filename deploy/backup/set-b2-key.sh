#!/usr/bin/env bash
# Asks for the Backblaze B2 bucket name and its application key, writes them
# into the backup container's .env, and checks that Backblaze accepts them.
# What is typed for the two key fields is not shown, and nothing secret is
# printed. Run it on the server, in a terminal:
#
#   sudo /opt/native-intelligence/deploy/backup/set-b2-key.sh
set -euo pipefail

backup_dir="$(cd "$(dirname "$0")" && pwd)"
env_file="${NI_ENV_FILE:-$backup_dir/.env}"

[ "$(id -u)" = 0 ] || { echo "Run it with sudo."; exit 1; }
[ -f "$env_file" ] || { echo "$env_file is missing."; exit 1; }
[ -t 0 ] || { echo "This needs a terminal: connect with ssh -t."; exit 1; }

trim() { local v="$1"; v="${v#"${v%%[![:space:]]*}"}"; v="${v%"${v##*[![:space:]]}"}"; printf '%s' "$v"; }

echo "Backblaze B2 details for the backups. Paste each one and press Enter."
echo

while :; do
	read -r -p "Bucket name: " bucket; bucket="$(trim "$bucket")"
	[[ "$bucket" =~ ^[A-Za-z0-9-]{6,63}$ ]] && break
	echo "  A bucket name is 6 to 63 letters, digits and hyphens. Try again."
done
while :; do
	read -rs -p "keyID (hidden as you paste): " key_id; echo; key_id="$(trim "$key_id")"
	[[ "$key_id" =~ ^[A-Za-z0-9]{12,40}$ ]] && break
	echo "  That does not look like a keyID (letters and digits, usually 25). Try again."
done
while :; do
	read -rs -p "applicationKey (hidden as you paste): " app_key; echo; app_key="$(trim "$app_key")"
	[[ "$app_key" =~ ^[A-Za-z0-9+/_-]{20,80}$ ]] && [ "$app_key" != "$key_id" ] && break
	echo "  That does not look like an applicationKey (usually 31 characters, and not the keyID). Try again."
done

umask 077
tmp="$(mktemp "$(dirname "$env_file")/.env.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
NI_B="$bucket" NI_K="$key_id" NI_A="$app_key" awk '
	/^B2_BUCKET=/          { print "B2_BUCKET=" ENVIRON["NI_B"]; b = 1; next }
	/^B2_KEY_ID=/          { print "B2_KEY_ID=" ENVIRON["NI_K"]; k = 1; next }
	/^B2_APPLICATION_KEY=/ { print "B2_APPLICATION_KEY=" ENVIRON["NI_A"]; a = 1; next }
	{ print }
	END { if (!(b && k && a)) exit 3 }
' "$env_file" > "$tmp" || { echo "The settings file does not have the three B2 lines; nothing was changed."; exit 1; }
chown root:root "$tmp"; chmod 600 "$tmp"; mv "$tmp" "$env_file"
trap - EXIT
echo
echo "Saved: bucket $bucket, keyID ${#key_id} characters, applicationKey ${#app_key} characters."

[ -n "${NI_SKIP_CHECK:-}" ] && exit 0
echo "Asking Backblaze whether the key can reach the bucket..."
cd "$backup_dir"
if out="$(docker compose run --rm -T backup rclone lsf --max-depth 1 store: </dev/null 2>&1)"; then
	echo "Backblaze accepted the key. Recreate the container so it uses it: sudo docker compose up -d"
else
	echo "Backblaze did not accept it. Last lines of the answer:"
	printf '%s\n' "$out" | grep -v -e ' Network ' -e ' Container ' | tail -4 | sed 's/^/  /'
	echo "Check the bucket name and that the key is for this bucket with read and write access, then run this again."
	exit 1
fi
