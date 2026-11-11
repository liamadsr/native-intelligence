#!/usr/bin/env bash
# Builds the app's image from this checkout and puts it into service, on the server.
#
#   sudo ./deploy.sh              build, then roll out
#   sudo ./deploy.sh --no-build   roll out the image already built (ni-app:live)
#   sudo ./deploy.sh --rollback   go back to the image that ran before the last
#                                 roll-out (ni-app:previous)
#   sudo ./deploy.sh --build-only build, and change nothing that runs
#
# Run `git pull` in the checkout first (as its owner, not with sudo).
#
# The order, and what each step costs the people using the app:
#   1. The image is built while the old one keeps serving (about ten minutes).
#   2. The eight agents are replaced one by one. eve keeps an agent's runs in files
#      that only one process may hold, so the old container stops before the new
#      one starts: a reply that is streaming from that agent at that moment stops.
#   3. worker, then web, are replaced without a gap: a second container is started
#      beside the first, and only when it is healthy is the old one stopped, with
#      its grace period (900 s for the worker, 120 s for web) to finish what is in
#      flight. The stack's proxy sends new requests to whichever is running.
#   4. The scheduler is replaced last. A job that is running is let finish first,
#      for up to 15 minutes.
#   5. The proxy is restarted only if proxy/Caddyfile changed since it started.
#
# Each image is labelled with the public address it was built for, and none is put
# into service while .env names another (a rehearsal's image is built for its test
# address). What ran before is kept as the image ni-app:previous, so --rollback
# needs no build. The image built before that is deleted. ni-app:running names
# what the last finished roll-out put into service.
set -euo pipefail

cd "$(dirname "$0")"
here="$(pwd)"

die() { echo "deploy: $*" >&2; exit 1; }
say() { printf '\n== %s\n' "$*"; }
ts() { date -u +%H:%M:%S; }

mode=deploy
case "${1:-}" in
"") ;;
--no-build) mode=no-build ;;
--rollback) mode=rollback ;;
--build-only) mode=build-only ;;
-h | --help) awk 'NR > 1 && /^set -euo/ { exit } NR > 1' "$0"; exit 0 ;;
*) die "unknown option $1 (see --help)" ;;
esac

[ "$(id -u)" = 0 ] || die "run it with sudo: the settings file is root's."
# One deploy at a time, by hand or automatic. auto-deploy.sh holds this lock for its
# whole run and says so with NI_DEPLOY_LOCK_HELD=1 (sudo does not pass that on).
if [ "${NI_DEPLOY_LOCK_HELD:-}" != 1 ]; then
	exec 8>>/run/ni-app-deploy.lock
	flock -n 8 || die "another deploy is running (by hand, or the automatic deploys: ./auto-deploy.sh status); try again when it has ended."
fi
[ -f .env ] || die "no .env here. ../README.md step 20 says how it is made."
command -v docker >/dev/null || die "Docker is not installed."

compose() { docker compose "$@"; }
# For the roll-out: Compose's progress lines say nothing the steps below do not.
quiet() { docker compose --progress quiet "$@"; }

# The checkout belongs to the login user. git refuses to work in it as root, and
# running it as root once left root-owned files in .git, so ask as its owner.
repo="$(cd ../.. && pwd)"
owner="$(stat -c %U "$repo")"
commit="$(sudo -u "$owner" git -C "$repo" rev-parse --short=12 HEAD 2>/dev/null || true)"

# One value from the resolved stack (Compose reads .env): a build argument of web.
build_arg() {
	compose config --format json 2>/dev/null |
		python3 -I -c "import json,sys; print(json.load(sys.stdin)['services']['web']['build']['args'].get(sys.argv[1]) or '')" "$1"
}

# One setting of web's, as Compose resolves it from .env. Never printed: the caller
# keeps it in a variable.
setting() {
	compose config --format json 2>/dev/null |
		python3 -I -c "import json,sys; print(json.load(sys.stdin)['services']['web'].get('environment', {}).get(sys.argv[1]) or '')" "$1"
}

# Builds web's image. The hosted sandbox service's credentials go to the build as
# BuildKit secrets (compose.yaml: web's build.secrets), which Compose takes from its
# own environment: so they are read from .env and given to this one command, not
# exported to the rest of the script. The coding agent's build uses them
# (build-agents.sh); empty, its sandbox is just-bash. Never a build argument: those
# are kept in the image's history.
build_web() {
	local token team project
	token="$(setting SANDBOX_ACCESS_TOKEN)" || die "cannot read SANDBOX_ACCESS_TOKEN from .env (docker compose config)."
	team="$(setting SANDBOX_TEAM_ID)" || die "cannot read SANDBOX_TEAM_ID from .env (docker compose config)."
	project="$(setting SANDBOX_PROJECT_ID)" || die "cannot read SANDBOX_PROJECT_ID from .env (docker compose config)."
	SANDBOX_ACCESS_TOKEN="$token" SANDBOX_TEAM_ID="$team" SANDBOX_PROJECT_ID="$project" \
		NI_APP_COMMIT="$commit" compose build web
}

# The public address an image was built for (compose.yaml labels it). The client
# code, its links and the sign-in returns all carry it, so an image built for a
# rehearsal's test address must never serve production, nor the other way round.
image_url() { docker image inspect -f '{{index .Config.Labels "ni.app-url"}}' "$1" 2>/dev/null || true; }
check_image_url() { # check_image_url <image>
	local want got
	want="$(build_arg NEXT_PUBLIC_APP_URL)"
	got="$(image_url "$1")"
	[ "$got" = "$want" ] ||
		die "$1 was built for '${got:-an unknown address}', but .env says NEXT_PUBLIC_APP_URL=$want. Build again (sudo ./deploy.sh), or put the address back in .env."
}

# The settings that `next build` compiles in must be there before ten minutes are
# spent on a build that cannot work.
check_build_settings() {
	local name missing=""
	for name in NEXT_PUBLIC_APP_URL NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY; do
		[ -n "$(build_arg "$name")" ] || missing="$missing $name"
	done
	[ -z "$missing" ] || die "empty in .env:$missing."
	[ -n "$commit" ] || die "cannot read the checkout's commit (git rev-parse in $repo, as $owner)."
}

running_ids() { # running_ids <service> [-a]: its containers, oldest first (-a: stopped ones too)
	docker ps ${2:-} --filter "label=com.docker.compose.project=ni-app" \
		--filter "label=com.docker.compose.service=$1" --format '{{.CreatedAt}} {{.ID}}' |
		sort | awk '{ print $NF }'
}

health() { docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$1" 2>/dev/null || echo gone; }

wait_healthy() { # wait_healthy <container> <seconds>
	local id="$1" limit="$2" waited=0 state
	while :; do
		state="$(health "$id")"
		case "$state" in
		healthy) return 0 ;;
		unhealthy | exited | dead | gone) return 1 ;;
		esac
		[ "$waited" -lt "$limit" ] || return 1
		sleep 2
		waited=$((waited + 2))
	done
}

# Replaces one service's container in place: for the agents and the scheduler.
replace() {
	local service="$1"
	echo "$(ts) $service"
	quiet up -d --no-deps --wait --wait-timeout 300 "$service"
}

# Replaces a service's containers with one on the new image, without a moment in
# which none is serving.
roll() {
	local service="$1" grace="$2" old new id
	old="$(running_ids "$service")"
	if [ -z "$old" ]; then
		replace "$service"
		return
	fi
	echo "$(ts) $service: starting a new container beside $(echo "$old" | wc -w | tr -d ' ') running"
	quiet up -d --no-deps --no-recreate --scale "$service=$(($(echo "$old" | wc -w) + 1))" "$service"
	# -a: a new container that stopped at once must be found too, to be removed.
	new="$(running_ids "$service" -a | grep -vxF "$old" || true)"
	[ -n "$new" ] || die "$service: no new container appeared."
	for id in $new; do
		if ! wait_healthy "$id" 300; then
			echo "$(ts) $service: the new container did not become healthy; it is removed and the old one keeps serving." >&2
			docker logs --tail 30 "$id" >&2 || true
			docker rm -f "$id" >/dev/null || true
			die "$service: roll-out stopped. Nothing else was changed after this point."
		fi
	done
	echo "$(ts) $service: new container healthy; stopping the old one (up to ${grace}s for what is in flight)"
	for id in $old; do
		docker stop -t "$grace" "$id" >/dev/null
		docker rm "$id" >/dev/null
	done
	echo "$(ts) $service: done"
}

restart_proxy_if_changed() {
	local id started changed
	id="$(running_ids proxy | tail -n 1)"
	if [ -z "$id" ]; then
		quiet up -d --no-deps --wait proxy
		return
	fi
	started="$(date -d "$(docker inspect -f '{{.State.StartedAt}}' "$id")" +%s)"
	changed="$(stat -c %Y proxy/Caddyfile)"
	if [ "$changed" -gt "$started" ]; then
		echo "$(ts) proxy: proxy/Caddyfile changed since it started; restarting it (a second or two)"
		quiet restart proxy
	fi
}

rollout() {
	local agents
	say "Rolling out ni-app:live ($(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' ni-app:live 2>/dev/null || echo '?'))"
	# The way back. ni-app:running is what the last finished roll-out put into
	# service; it becomes ni-app:previous now, and this image becomes
	# ni-app:running at the end. (Docker's image store drops an image as soon as no
	# tag names it, even while a container runs from it, so what ran must keep a
	# tag of its own: the build has already moved ni-app:live.)
	if docker image inspect ni-app:running >/dev/null 2>&1 &&
		[ "$(docker image inspect -f '{{.Id}}' ni-app:running)" != "$(docker image inspect -f '{{.Id}}' ni-app:live)" ]; then
		docker tag ni-app:running ni-app:previous
		echo "$(ts) kept what ran as ni-app:previous"
	fi
	quiet up -d --no-deps --wait proxy
	agents="$(compose config --services | grep '^agent-' || true)"
	for service in $agents; do replace "$service"; done
	roll worker 900
	roll web 120
	echo "$(ts) cron (waits for a job that is running)"
	replace cron
	restart_proxy_if_changed
	docker tag ni-app:live ni-app:running
	say "Running"
	compose ps --format 'table {{.Service}}\t{{.Status}}'
	# Images no tag points at any more: the build before last. And Docker's build
	# cache, which grows by several gigabytes a build: the newest 12 GB stay, enough
	# for the next build to reuse its dependency layers.
	docker image prune -f >/dev/null
	docker builder prune -f --max-used-space 12gb >/dev/null || true
}

case "$mode" in
deploy | build-only)
	check_build_settings
	# What runs keeps a name through the build. Normally ni-app:running names it; on
	# a server whose stack was started some other way, ni-app:live is what runs
	# until the build moves that tag.
	if ! docker image inspect ni-app:running >/dev/null 2>&1 && docker image inspect ni-app:live >/dev/null 2>&1; then
		docker tag ni-app:live ni-app:running
	fi
	say "Building the image from $commit for $(build_arg NEXT_PUBLIC_APP_URL) (the app keeps serving meanwhile)"
	started=$SECONDS
	build_web
	echo "$(ts) built in $(((SECONDS - started) / 60)) min $(((SECONDS - started) % 60)) s"
	[ "$mode" = build-only ] && exit 0
	check_image_url ni-app:live
	rollout
	;;
no-build)
	docker image inspect ni-app:live >/dev/null 2>&1 || die "there is no image ni-app:live yet; build first."
	check_image_url ni-app:live
	rollout
	;;
rollback)
	docker image inspect ni-app:previous >/dev/null 2>&1 || die "there is no ni-app:previous to go back to."
	# Checked before the tags move: the image before the first production roll-out
	# is the rehearsal's, built for the test address. Going back from there is
	# ../README.md step 22, not this.
	check_image_url ni-app:previous
	say "Going back to ni-app:previous"
	# Swap the two tags, so that a second --rollback goes forward again.
	docker tag ni-app:live ni-app:rollback-swap
	docker tag ni-app:previous ni-app:live
	docker tag ni-app:rollback-swap ni-app:previous
	docker rmi ni-app:rollback-swap >/dev/null
	# A mark for the automatic deploys (auto-deploy.sh), where they are installed:
	# their next run holds everything until a person has cleared it, whatever is
	# rolled out by hand after this. Never a reason for the rollback itself to stop.
	if [ -d /var/lib/ni-auto-deploy ]; then
		date -u +%Y-%m-%dT%H:%M:%SZ >/var/lib/ni-auto-deploy/rolled-back 2>/dev/null || true
	fi
	rollout
	;;
esac
