#!/usr/bin/env bash
# check-env.sh
#
# Checks the settings of the Supabase stack before it is started, and after
# Supabase's update.sh has brought in a new release. Changes nothing.
#
#   sudo ./check-env.sh       on the server, where stack/.env is root-only
#   ./check-env.sh            anywhere else: only the repository's own files
#
# 1. Every setting in Supabase's stack/.env.example is in ours (.env.example).
#    A release that adds one shows up here. Their file is only present while
#    a release is being taken, so this part runs from after-update.sh.
# 2. Every setting in ours is in stack/.env, and the ones the stack cannot
#    start or work without are not empty.
# 3. The three values copied from the hosted project agree with each other:
#    ANON_KEY and SERVICE_ROLE_KEY are tokens for the roles anon and
#    service_role, signed with JWT_SECRET. A wrong paste shows up here and
#    not as every client being refused after the switch.
# 4. The settings that must have one particular value have it.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
theirs="$here/stack/.env.example"
ours="$here/.env.example"
real="$here/stack/.env"
problems=0
problem() {
	echo "  PROBLEM: $*"
	problems=$((problems + 1))
}
note() { echo "  note: $*"; }

# Names set, or offered commented out, in an env file.
keys() { grep -oE '^#?[A-Za-z_][A-Za-z0-9_]*=' "$1" | tr -d '#=' | sort -u; }
value() { # value <KEY>: from stack/.env, without surrounding quotes
	local v
	v="$(grep -E "^$1=" "$real" | tail -n 1 | cut -d= -f2-)" || true
	v="${v%$'\r'}"
	case "$v" in \"*\") v="${v#\"}" v="${v%\"}" ;; \'*\') v="${v#\'}" v="${v%\'}" ;; esac
	printf '%s' "$v"
}

echo "1. Supabase's settings against ours"
if [ ! -f "$theirs" ]; then
	# Their example file is not kept in the repository (it holds their demo
	# keys). It is only here between update.sh and after-update.sh.
	echo "  not checked here: stack/.env.example only exists while a release is being taken (after-update.sh)"
else
	missing="$(comm -23 <(keys "$theirs") <(keys "$ours"))"
	if [ -n "$missing" ]; then
		for k in $missing; do problem "$k is in stack/.env.example and not in .env.example: add it there, with a comment, and to stack/.env on the server"; done
	else
		echo "  every setting of this release is in .env.example"
	fi
fi

if [ ! -r "$real" ]; then
	echo "2-4. stack/.env is not readable here (on the server: sudo $0). Nothing more to check."
	[ "$problems" = 0 ] && exit 0 || exit 1
fi

echo "2. stack/.env"
for k in $(comm -23 <(grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' "$ours" | tr -d '=' | sort -u) <(keys "$real")); do
	problem "$k is missing from stack/.env"
done
# The stack does not start, or does not do its job, with one of these empty.
required="COMPOSE_FILE POSTGRES_PASSWORD DASHBOARD_USERNAME DASHBOARD_PASSWORD SECRET_KEY_BASE REALTIME_DB_ENC_KEY
VAULT_ENC_KEY PG_META_CRYPTO_KEY S3_PROTOCOL_ACCESS_KEY_ID S3_PROTOCOL_ACCESS_KEY_SECRET JWT_SECRET ANON_KEY
SERVICE_ROLE_KEY JWT_EXPIRY SUPABASE_PUBLIC_URL API_EXTERNAL_URL SITE_URL DISABLE_SIGNUP ENABLE_EMAIL_SIGNUP
ENABLE_EMAIL_AUTOCONFIRM ENABLE_ANONYMOUS_USERS ENABLE_PHONE_SIGNUP ENABLE_PHONE_AUTOCONFIRM GOOGLE_ENABLED
APPLE_ENABLED HOOK_BEFORE_USER_CREATED_ENABLED SMTP_ADMIN_EMAIL SMTP_SENDER_NAME SMTP_HOST SMTP_PORT
FUNCTIONS_VERIFY_JWT FUNCTIONS_MEMORY_LIMIT POOLER_TENANT_ID GLOBAL_S3_BUCKET REGION STORAGE_TENANT_ID
POSTGRES_HOST POSTGRES_DB POSTGRES_PORT POOLER_DEFAULT_POOL_SIZE POOLER_MAX_CLIENT_CONN POOLER_DB_POOL_SIZE
PGRST_DB_SCHEMAS PGRST_DB_MAX_ROWS PGRST_DB_EXTRA_SEARCH_PATH API_GW_HTTP_PORT POOLER_PROXY_PORT_TRANSACTION"
for k in $required; do
	[ -n "$(value "$k")" ] || problem "$k is empty"
done
for provider in GOOGLE APPLE; do
	if [ "$(value "${provider}_ENABLED")" = true ]; then
		[ -n "$(value "${provider}_CLIENT_ID")" ] || problem "${provider}_ENABLED is true and ${provider}_CLIENT_ID is empty"
		[ -n "$(value "${provider}_SECRET")" ] || problem "${provider}_ENABLED is true and ${provider}_SECRET is empty"
	fi
done
for k in ADDITIONAL_REDIRECT_URLS SMTP_USER SMTP_PASS STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET STUDIO_DEFAULT_ORGANIZATION STUDIO_DEFAULT_PROJECT; do
	[ -n "$(value "$k")" ] || note "$k is empty. Right only if that is what the hosted project has."
done
for k in ENABLE_EMAIL_SIGNUP ENABLE_EMAIL_AUTOCONFIRM ENABLE_ANONYMOUS_USERS ENABLE_PHONE_SIGNUP ENABLE_PHONE_AUTOCONFIRM DISABLE_SIGNUP GOOGLE_ENABLED APPLE_ENABLED HOOK_BEFORE_USER_CREATED_ENABLED; do
	case "$(value "$k")" in true | false | '') ;; *) problem "$k must be true or false" ;; esac
done

echo "3. The keys copied from the hosted project"
b64url() { openssl enc -base64 -A | tr '+/' '-_' | tr -d '='; }
unb64url() { # decode base64url from stdin
	local s
	s="$(tr '_-' '/+')"
	while [ $((${#s} % 4)) -ne 0 ]; do s="$s="; done
	printf '%s' "$s" | openssl enc -base64 -d -A 2>/dev/null
}
secret="$(value JWT_SECRET)"
for pair in ANON_KEY:anon SERVICE_ROLE_KEY:service_role; do
	name="${pair%%:*}" role="${pair##*:}" token="$(value "${pair%%:*}")"
	[ -n "$token" ] && [ -n "$secret" ] || continue
	IFS=. read -r head body sig <<<"$token"
	if [ -z "${sig:-}" ]; then
		problem "$name is not a token (three parts separated by dots)"
		continue
	fi
	expected="$(printf '%s.%s' "$head" "$body" | openssl dgst -binary -sha256 -hmac "$secret" | b64url)"
	[ "$expected" = "$sig" ] || problem "$name is not signed with JWT_SECRET: one of the two was copied wrongly"
	claims="$(printf '%s' "$body" | unb64url)"
	case "$claims" in
		*"\"role\":\"$role\""* | *"\"role\": \"$role\""*) echo "  $name: signed with JWT_SECRET, role $role" ;;
		*) problem "$name is not a key for the role $role (anon and service_role swapped?)" ;;
	esac
done
[ "${#secret}" -ge 32 ] || [ -z "$secret" ] || problem "JWT_SECRET is shorter than 32 characters"

echo "4. Settings with one right value"
for k in SUPABASE_PUBLISHABLE_KEY SUPABASE_SECRET_KEY JWT_KEYS JWT_JWKS ANON_KEY_ASYMMETRIC SERVICE_ROLE_KEY_ASYMMETRIC; do
	[ -z "$(value "$k")" ] || problem "$k must stay empty: the hosted project signs with the shared secret only"
done
[ "$(value FUNCTIONS_VERIFY_JWT)" = false ] || problem "FUNCTIONS_VERIFY_JWT must be false, or Stripe's calls to the webhook are refused"
case ":$(value COMPOSE_FILE):" in
	*":../compose.override.yaml:"*) ;;
	*) problem "COMPOSE_FILE does not include ../compose.override.yaml: the stack would start as Supabase ships it, with ports published on the host" ;;
esac
case ":$(value COMPOSE_FILE):" in *logs*) problem "COMPOSE_FILE includes the logs add-on" ;; esac
public="$(value SUPABASE_PUBLIC_URL)"
[ "$(value API_EXTERNAL_URL)" = "${public}/auth/v1" ] || problem "API_EXTERNAL_URL must be SUPABASE_PUBLIC_URL followed by /auth/v1"
case "$public" in
	https://*/ | http://*/) problem "SUPABASE_PUBLIC_URL must not end in a slash" ;;
	https://*:* | http://*:*) problem "SUPABASE_PUBLIC_URL must not name a port: Storage would refuse the backup's and the migration's S3 requests" ;;
	https://*) ;;
	*) problem "SUPABASE_PUBLIC_URL must start with https://" ;;
esac
perms="$(stat -c '%a %U' "$real")"
[ "$perms" = "600 root" ] || problem "stack/.env is $perms; it must be 600 root (sudo chown root:root stack/.env && sudo chmod 600 stack/.env)"
[ ! -e "$here/stack/.env.old" ] || note "stack/.env.old is left over from generate-keys.sh. Delete it: it holds the previous values."

if [ "$problems" = 0 ]; then
	echo "no problems"
else
	echo "$problems problem(s)"
	exit 1
fi
