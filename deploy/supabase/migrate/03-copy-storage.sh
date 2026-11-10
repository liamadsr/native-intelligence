#!/usr/bin/env bash
# 03-copy-storage.sh
#
# Copies every stored file from the hosted project to this stack, bucket by
# bucket, with rclone over the S3 protocol on both sides, as Supabase's guide
# says to (https://supabase.com/docs/guides/self-hosting/copy-from-platform-s3).
# Files are never placed into the storage folder by hand: Storage keeps them in
# a layout of its own and only writes that layout itself.
#
# Run it after 02-restore.sh. It can be run again: every run copies everything.
#
# Two things here differ from the guide's commands, both found by rehearsing:
#
#   --ignore-times   The restore has already brought over the RECORD of every
#                    file (storage.objects), so the self-hosted side lists all
#                    of them, with the right sizes, before a single byte has
#                    arrived. A plain `rclone copy` compares the two listings,
#                    finds nothing to do and copies nothing; `rclone size` and
#                    `rclone check` then agree that all is well. This flag
#                    makes rclone send every file regardless.
#   --metadata       Without it each file loses its Cache-Control header.
#
# And two things are done after the copy:
#
#   1. rclone leaves two timestamps of its own in each record's user metadata,
#      and the upload moves updated_at to now. Both are set back to what the
#      hosted project has, read from its database.
#   2. Every file is downloaded from both sides and compared byte for byte,
#      because that is the only check the records cannot fool.
#
# What a record keeps through all this: its id, owner, created_at, size,
# content type, cache control and checksum. What changes: `version` (the name
# of the file on this disk) and the last-modified time inside `metadata`.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"
load_settings
need SOURCE_DB_URL SOURCE_S3_ENDPOINT SOURCE_S3_REGION SOURCE_S3_ACCESS_KEY_ID SOURCE_S3_SECRET_ACCESS_KEY \
	TARGET_S3_REGION TARGET_S3_ACCESS_KEY_ID TARGET_S3_SECRET_ACCESS_KEY

# rclone's log lines without their date and time.
tidy() { sed -E 's/^[0-9]{4}\/[0-9]{2}\/[0-9]{2} [0-9:]+ //'; }

log "listing buckets on both sides"
source_buckets="$(rclone_run lsf platform: 2>/dev/null | tr -d '/' | sort)" \
	|| die "cannot list buckets on the hosted project: check the SOURCE_S3_* settings"
target_buckets="$(rclone_run lsf selfhosted: 2>/dev/null | tr -d '/' | sort)" \
	|| die "cannot list buckets on this stack: is it running, and is SUPABASE_PUBLIC_URL in ../stack/.env the name it answers to?"
[ -n "$source_buckets" ] || die "the hosted project lists no buckets: the endpoint must end in /storage/v1/s3"

# Buckets are created first; the S3 protocol does not create one on copy.
# After a restore they already exist, with their settings, so this is only
# for a bucket made on the platform since the dump.
for bucket in $source_buckets; do
	if ! grep -qx -- "$bucket" <<<"$target_buckets"; then
		log "creating bucket $bucket"
		query_source "select format(
			'insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values (%L, %L, %L, %L, %L) on conflict (id) do nothing;',
			id, name, public, file_size_limit, allowed_mime_types) from storage.buckets where id = '$bucket'" \
			| psql_target -q -f - || die "could not create bucket $bucket"
	fi
done

failed=0
for bucket in $source_buckets; do
	log "copying bucket $bucket"
	# 4 transfers and 8 checkers are the guide's own suggestion.
	if out="$(rclone_run copy "platform:$bucket" "selfhosted:$bucket" \
		--ignore-times --metadata --transfers 4 --checkers 8 --retries 3 --stats-one-line -v 2>&1)"; then
		echo "$out" | tidy | grep -E '^INFO +: +[0-9.]+ ?[A-Za-z]* / ' | tail -n 1 | sed 's/^INFO *: */  /' || true
	else
		echo "$out" | tidy | grep -E 'ERROR|Failed' | tail -n 10 | sed 's/^/  /' >&2 || true
		warn "copying bucket $bucket failed"
		failed=1
	fi
done

log "setting user metadata and timestamps on the file records back to the hosted project's"
umask 077
work="$(mktemp -d "$MIGRATE_DIR/.storage.XXXXXX")"
trap 'rm -rf "$work"' EXIT
{
	echo "begin;"
	echo "create temp table hosted_object (bucket_id text, name text, user_metadata jsonb, updated_at timestamptz, last_accessed_at timestamptz) on commit drop;"
	echo "copy hosted_object from stdin;"
	psql_source -q -c "copy (select bucket_id, name, user_metadata, updated_at, last_accessed_at from storage.objects) to stdout" \
		|| die "could not read the file records from the hosted project"
	echo '\.'
	# Triggers off for the update, or Storage's own trigger would set
	# updated_at to now again.
	cat <<'SQL'
set local session_replication_role = replica;
update storage.objects o
   set user_metadata = h.user_metadata,
       updated_at = h.updated_at,
       last_accessed_at = h.last_accessed_at
  from hosted_object h
 where h.bucket_id = o.bucket_id and h.name = o.name
   and (o.user_metadata is distinct from h.user_metadata
        or o.updated_at is distinct from h.updated_at
        or o.last_accessed_at is distinct from h.last_accessed_at);
commit;
SQL
} >"$work/records.sql"
WORK_DIR="$work" psql_target -q -f records.sql >/dev/null || die "could not update the file records"

for bucket in $source_buckets; do
	log "comparing bucket $bucket byte for byte"
	if out="$(rclone_run check "platform:$bucket" "selfhosted:$bucket" --download --checkers 8 \
		--retries 1 --low-level-retries 2 2>&1)"; then
		echo "$out" | tidy | grep -E 'matching files' | sed -E 's/^NOTICE: */  /' || true
	else
		echo "$out" | tidy | grep -E 'ERROR|differences found' | tail -n 10 | sed 's/^/  /' >&2 || true
		failed=1
	fi
	src="$(rclone_run size "platform:$bucket" --json 2>/dev/null)" || src="unreadable"
	dst="$(rclone_run size "selfhosted:$bucket" --json 2>/dev/null)" || dst="unreadable"
	log "  hosted $src, here $dst"
	[ "$src" = "$dst" ] || failed=1
done

[ "$failed" = 0 ] || die "at least one bucket differs: see above. Running this script again copies everything again."
log "done. next: sudo $MIGRATE_DIR/04-verify.sh"
