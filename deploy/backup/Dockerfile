# The backup container: pg_dump, rclone and cron, nothing else.
#
# pg_dump has to be the same major version as the server it dumps, so the base
# is the Postgres 17 image itself (it also brings bash, busybox crond and
# wget). rclone is one static binary, copied from its official image: it
# uploads to Backblaze B2 and encrypts on the way.
FROM rclone/rclone:1.75.2 AS rclone

FROM postgres:17-alpine

COPY --from=rclone /usr/local/bin/rclone /usr/local/bin/rclone
COPY bin/ /usr/local/bin/
# Every job there is. The entrypoint schedules the ones that are configured.
COPY crontab /etc/backup/crontab

RUN chmod 0755 /usr/local/bin/backup-entrypoint /usr/local/bin/backup-postgres \
		/usr/local/bin/backup-storage /usr/local/bin/restore-supabase-db \
		/usr/local/bin/restore-supabase-storage \
	&& rclone version >/dev/null \
	&& pg_dump --version >/dev/null

ENTRYPOINT ["/usr/local/bin/backup-entrypoint"]
# Foreground, log to stderr, level 8 (jobs started, not every wake-up).
CMD ["crond", "-f", "-d", "8"]
