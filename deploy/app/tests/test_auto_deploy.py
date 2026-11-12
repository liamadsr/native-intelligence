"""Tests for auto-deploy.sh: python3 -m unittest discover -s deploy/app/tests

Each test makes a made-up origin (a bare repository), a developer's clone that
pushes to it, and the server's checkout, then runs the script with the outside
world replaced: deploy.sh, docker and curl by the small scripts below, systemd by a
folder and a stand-in systemctl. No root, Docker, systemd or network. Needs git,
bash and util-linux flock (where flock is missing, as on macOS, a stand-in on
Python's fcntl.flock takes its place: the same system call).
"""
import fcntl
import getpass
import os
import shutil
import subprocess
import tempfile
import unittest

SCRIPT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "auto-deploy.sh")

# deploy.sh, as auto-deploy.sh calls it: --build-only, then --no-build.
FAKE_DEPLOY = """#!/usr/bin/env bash
set -e
mode="$1"
# It runs under auto-deploy.sh's lock, and is told so.
[ "${NI_DEPLOY_LOCK_HELD:-}" = 1 ] || { echo "no lock marker" >&2; exit 3; }
if flock -n "$AUTO_DEPLOY_LOCK" true; then echo "the lock is not held" >&2; exit 3; fi
# The failure is recorded before each phase starts.
[ ! -e "$AUTO_DEPLOY_STATE/failed" ] || echo "$mode $(cut -d' ' -f2 "$AUTO_DEPLOY_STATE/failed")" >>"$FAKE/failed-seen"
commit="$(git -C "$AUTO_DEPLOY_REPO" rev-parse HEAD)"
case "$mode" in
--build-only)
	echo "$commit" >>"$FAKE/deploy-calls"
	[ ! -e "$FAKE/build-fails" ] || { echo "the build failed" >&2; exit 1; }
	echo "$commit" >"$FAKE/built"
	# The image turns out to be built from something else.
	[ ! -e "$FAKE/built-label" ] || cp "$FAKE/built-label" "$FAKE/built"
	# Someone moves the checkout while the image builds.
	[ ! -e "$FAKE/moved-during-build" ] || git -C "$AUTO_DEPLOY_REPO" commit -q --allow-empty -m moved
	;;
--no-build)
	[ ! -e "$FAKE/rollout-fails" ] || { echo "the roll-out failed" >&2; exit 1; }
	if [ ! -e "$FAKE/serves-old" ]; then
		# Like deploy.sh: what ran is kept as ni-app:previous, then the new one serves.
		old="$(cat "$FAKE/running" 2>/dev/null || true)"
		[ -z "$old" ] || [ "$old" = "$commit" ] || echo "$old" >"$FAKE/previous"
		echo "$commit" >"$FAKE/running"
	fi
	;;
*) exit 2 ;;
esac
"""

# $FAKE/previous: the commit ni-app:previous carries ("no-label": an image without
# one); no such file, no such image.
FAKE_DOCKER = """#!/usr/bin/env bash
running="$(cat "$FAKE/running" 2>/dev/null || true)"
previous="$(cat "$FAKE/previous" 2>/dev/null || true)"
version="$(cat "$FAKE/version" 2>/dev/null || echo "$running")"
case "$*" in
*"image ls -q ni-app:previous"*) [ ! -e "$FAKE/docker-ls-fails" ] || exit 1; [ -z "$previous" ] || echo 0123456789ab ;;
*"image inspect"*ni-app:previous*) [ -n "$previous" ] && [ ! -e "$FAKE/docker-inspect-fails" ] || exit 1; if [ "$previous" = no-label ]; then echo; else echo "${previous:0:12}"; fi ;;
*"image inspect"*ni-app:running*) [ -n "$running" ] || exit 1; echo "${running:0:12}" ;;
*"image inspect"*ni-app:live*) built="$(cat "$FAKE/built" 2>/dev/null || true)"; echo "${built:0:12}" ;;
*"exec ni-app-proxy wget"*/api/version*) printf '{"buildId":"%s"}\\n' "${version:0:8}" ;;
*) exit 1 ;;
esac
"""

FAKE_CURL = """#!/usr/bin/env bash
echo "${@: -1}" >>"$FAKE/pings"
"""

FAKE_SYSTEMCTL = """#!/usr/bin/env bash
echo "$*" >>"$FAKE/systemctl-calls"
"""

# util-linux flock, as far as these scripts use it: `flock -n <fd>` and `flock -n <file> <command>`.
FLOCK_STANDIN = """#!/usr/bin/env python3
import fcntl, os, subprocess, sys
args = [a for a in sys.argv[1:] if a != "-n"]
how = fcntl.LOCK_EX | (fcntl.LOCK_NB if "-n" in sys.argv[1:] else 0)
fd = int(args[0]) if args[0].isdigit() else os.open(args[0], os.O_RDONLY | os.O_CREAT, 0o644)
try:
    fcntl.flock(fd, how)
except BlockingIOError:
    sys.exit(1)
if len(args) > 1:
    sys.exit(subprocess.call(args[1:]))
"""


def write(path, text, mode=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text)
    if mode:
        os.chmod(path, mode)


def read(path):
    with open(path) as f:
        return f.read()


class AutoDeploy(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="auto-deploy-test-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        t = self.tmp
        self.origin = os.path.join(t, "origin.git")
        self.dev = os.path.join(t, "dev")
        self.checkout = os.path.join(t, "checkout")
        self.state = os.path.join(t, "state")
        self.fake = os.path.join(t, "fake")
        self.units = os.path.join(t, "systemd")
        self.lock = os.path.join(t, "deploy.lock")
        bin_dir = os.path.join(t, "bin")
        os.makedirs(self.units)
        os.makedirs(bin_dir)
        write(os.path.join(self.fake, "deploy.sh-standin"), FAKE_DEPLOY, 0o755)
        write(os.path.join(self.fake, "docker"), FAKE_DOCKER, 0o755)
        write(os.path.join(self.fake, "curl"), FAKE_CURL, 0o755)
        write(os.path.join(self.fake, "systemctl"), FAKE_SYSTEMCTL, 0o755)
        path = os.environ.get("PATH", "/usr/bin:/bin")
        if not shutil.which("flock"):
            write(os.path.join(bin_dir, "flock"), FLOCK_STANDIN, 0o755)
            path = bin_dir + os.pathsep + path
        self.env = {
            "PATH": path,
            "HOME": t,
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_AUTHOR_NAME": "dev", "GIT_AUTHOR_EMAIL": "dev",
            "GIT_COMMITTER_NAME": "dev", "GIT_COMMITTER_EMAIL": "dev",
            "FAKE": self.fake,
            "AUTO_DEPLOY_REPO": self.checkout,
            "AUTO_DEPLOY_STATE": self.state,
            "AUTO_DEPLOY_LOCK": self.lock,
            "AUTO_DEPLOY_OWNER": getpass.getuser(),
            "AUTO_DEPLOY_DEPLOY_SH": os.path.join(self.fake, "deploy.sh-standin"),
            "AUTO_DEPLOY_DOCKER": os.path.join(self.fake, "docker"),
            "AUTO_DEPLOY_CURL": os.path.join(self.fake, "curl"),
            "AUTO_DEPLOY_SYSTEMD_DIR": self.units,
            "AUTO_DEPLOY_SYSTEMCTL": os.path.join(self.fake, "systemctl"),
        }
        self.git(t, "init", "-q", "--bare", "-b", "main", self.origin)
        self.git(t, "clone", "-q", self.origin, self.dev)
        self.git(self.dev, "switch", "-q", "-c", "main")
        self.first = self.commit({
            "deploy/app/.gitignore": ".env\n",
            "deploy/app/.env.example": "# made-up settings\nAPP_URL=\nSIGNING_KEY=\n#OPTIONAL_ONE=\n",
            "deploy/edge/Caddyfile": "# made up\n",
            "web/supabase/migrations/001_start.sql": "create table t (id int);\n",
            "web/supabase/functions/hook/index.ts": "// made up\n",
            "web/app.txt": "one\n",
        })
        self.git(t, "clone", "-q", self.origin, self.checkout)
        # The server's settings: a value that must never appear in any output.
        write(os.path.join(self.checkout, "deploy/app/.env"), "APP_URL=https://app.invalid\nSIGNING_KEY=never-shown-value\n")
        # What serves before the first automatic deploy: the first commit, rolled out by hand.
        write(os.path.join(self.fake, "running"), self.first + "\n")

    # --- helpers ---------------------------------------------------------------

    def git(self, cwd, *args):
        return subprocess.run(["git", *args], cwd=cwd, env=self.env, check=True, capture_output=True, text=True).stdout.strip()

    def commit(self, files=None, remove=(), message="change"):
        for name, text in (files or {}).items():
            write(os.path.join(self.dev, name), text)
        for name in remove:
            os.remove(os.path.join(self.dev, name))
        self.git(self.dev, "add", "-A")
        self.git(self.dev, "commit", "-q", "-m", message)
        self.git(self.dev, "push", "-q", "origin", "main")
        return self.git(self.dev, "rev-parse", "HEAD")

    def run_tool(self, *args, script=SCRIPT):
        r = subprocess.run(["bash", script, *args], env=self.env, capture_output=True, text=True, timeout=120)
        self.assertNotIn("never-shown-value", r.stdout + r.stderr)
        self.assertNotIn("no lock marker", r.stdout + r.stderr)
        self.assertNotIn("the lock is not held", r.stdout + r.stderr)
        return r

    def run_ok(self, *args):
        r = self.run_tool(*args)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        return r

    def switch_on(self):
        self.run_ok("install")
        self.run_ok("on")

    def head(self):
        return self.git(self.checkout, "rev-parse", "HEAD")

    def fake_file(self, name):
        p = os.path.join(self.fake, name)
        return read(p).split("\n")[:-1] if os.path.exists(p) else []

    def deploy_calls(self):
        return self.fake_file("deploy-calls")

    def serving(self):
        return read(os.path.join(self.fake, "running")).strip()

    def by_hand(self, commit):
        """sudo ./deploy.sh by hand: what ran is kept as ni-app:previous, then the new one serves."""
        old = self.serving()
        if old != commit:
            write(os.path.join(self.fake, "previous"), old + "\n")
        write(os.path.join(self.fake, "running"), commit + "\n")

    def rollback_by_hand(self):
        """sudo ./deploy.sh --rollback: the two images change places."""
        old = self.serving()
        write(os.path.join(self.fake, "running"), read(os.path.join(self.fake, "previous")))
        write(os.path.join(self.fake, "previous"), old + "\n")

    def failing_git(self, *words, instead=None):
        """From now on git fails (or runs `instead`) whenever all these words are among its arguments."""
        wrap = os.path.join(self.tmp, "gitwrap")
        when = " && ".join('[[ " $* " == *" %s "* ]]' % w for w in words)
        write(os.path.join(wrap, "git"), '#!/usr/bin/env bash\nif %s; then %s; fi\nexec %s "$@"\n' % (
            when, instead or "echo boom >&2; exit 128", shutil.which("git")), 0o755)
        if not self.env["PATH"].startswith(wrap + os.pathsep):
            self.env["PATH"] = wrap + os.pathsep + self.env["PATH"]

    def current(self):
        return dict(line.split("=", 1) for line in read(os.path.join(self.state, "status")).splitlines())["state"]

    def flag(self, name, on=True):
        p = os.path.join(self.fake, name)
        if on:
            open(p, "w").close()
        elif os.path.exists(p):
            os.remove(p)

    def assertHeld(self, r, *words):
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)  # a hold is not a malfunction
        self.assertTrue(self.current().startswith("holding: "), self.current())
        for w in words:
            self.assertIn(w, self.current())

    # --- the basics ------------------------------------------------------------

    def test_off_does_nothing(self):
        self.run_ok("install")
        self.commit({"web/app.txt": "two\n"})
        r = self.run_ok("run")
        self.assertEqual(r.stdout, "")
        self.assertEqual(self.deploy_calls(), [])
        self.assertEqual(self.head(), self.first)
        self.assertFalse(os.path.exists(os.path.join(self.state, "status")))
        self.assertEqual(self.fake_file("pings"), [])

    def test_nothing_new_does_nothing(self):
        self.switch_on()
        self.run_ok("run")
        self.assertEqual(self.deploy_calls(), [])
        self.assertTrue(self.current().startswith("idle"))

    def test_a_plain_commit_is_deployed_once(self):
        self.switch_on()
        new = self.commit({"web/app.txt": "two\n"})
        self.run_ok("run")
        self.assertEqual(self.deploy_calls(), [new])
        self.assertEqual(self.head(), new)
        self.assertEqual(self.serving(), new)
        self.assertTrue(self.current().startswith("deployed %s at " % new[:12]))
        self.assertEqual(len(os.listdir(os.path.join(self.state, "runs"))), 1)
        r = self.run_ok("run")
        self.assertEqual(r.stdout, "")  # nothing new: no log line
        self.assertEqual(self.deploy_calls(), [new])
        self.assertTrue(self.current().startswith("deployed %s at " % new[:12]))

    def test_the_failure_is_recorded_before_each_phase_and_the_lock_is_passed_on(self):
        self.switch_on()
        self.commit({"web/app.txt": "two\n"})
        self.run_ok("run")
        self.assertEqual(self.fake_file("failed-seen"), ["--build-only build", "--no-build halt"])
        self.assertFalse(os.path.exists(os.path.join(self.state, "failed")))

    # --- 1: what serves is the baseline ----------------------------------------

    def test_pulling_by_hand_first_still_holds_and_then_deploys(self):
        self.switch_on()
        new = self.commit({"web/supabase/migrations/002_more.sql": "alter table t add column n int;\n"})
        self.git(self.checkout, "pull", "-q")
        self.assertHeld(self.run_tool("run"), "002_more.sql")
        self.assertEqual(self.deploy_calls(), [])
        self.run_ok("acknowledge", new[:12])
        self.run_ok("run")
        self.assertEqual(self.deploy_calls(), [new])
        # The next commit is checked from what serves, not skipped.
        later = self.commit({"web/supabase/migrations/003_again.sql": "select 1;\n"})
        self.git(self.checkout, "pull", "-q")
        self.assertHeld(self.run_tool("run"), "003_again.sql")
        self.assertEqual(self.deploy_calls(), [new])
        self.run_ok("acknowledge", later)
        self.run_ok("run")
        self.assertEqual(self.deploy_calls(), [new, later])

    def test_a_checkout_ahead_of_what_serves_is_deployed(self):
        self.switch_on()
        new = self.commit({"web/app.txt": "two\n"})
        self.git(self.checkout, "pull", "-q")
        self.run_ok("run")
        self.assertEqual(self.deploy_calls(), [new])

    def test_unknown_serving_commit_holds(self):
        self.switch_on()
        os.remove(os.path.join(self.fake, "running"))
        self.commit({"web/app.txt": "two\n"})
        self.assertHeld(self.run_tool("run"), "cannot tell which commit serves")
        write(os.path.join(self.fake, "running"), "0123456789abcdef\n")  # a commit the checkout lacks
        self.assertHeld(self.run_tool("run"), "cannot tell which commit serves")
        self.assertEqual(self.deploy_calls(), [])

    # --- migrations and the other watched files --------------------------------

    def test_a_migration_holds_until_acknowledged(self):
        self.switch_on()
        new = self.commit({"web/supabase/migrations/002_more.sql": "alter table t add column n int;\n"})
        r = self.run_tool("run")
        self.assertHeld(r, "002_more.sql")
        self.assertIn("acknowledge %s" % new[:12], r.stdout)
        self.assertEqual(self.head(), self.first)
        self.assertEqual(self.run_tool("run").stdout, "")  # held again, without a second log line
        r = self.run_ok("acknowledge", new[:12])
        self.assertIn("002_more.sql", r.stdout)
        self.assertEqual(oct(os.stat(os.path.join(self.state, "acknowledged")).st_mode & 0o777), "0o600")
        self.run_ok("run")
        self.assertEqual(self.deploy_calls(), [new])
        self.assertFalse(self.run_tool("acknowledge", new).returncode == 0)  # nothing waits now

    def test_an_acknowledgement_does_not_cover_what_arrives_after_it(self):
        self.switch_on()
        seen = self.commit({"web/supabase/migrations/002_more.sql": "alter table t add column n int;\n"})
        self.run_ok("run")
        self.run_ok("acknowledge", seen)
        self.commit({"web/supabase/migrations/002_more.sql": "alter table t add column m int;\n"})
        self.assertHeld(self.run_tool("run"), "002_more.sql")
        self.commit({"web/supabase/migrations/002_more.sql": "alter table t add column n int;\n",
                     "web/supabase/migrations/004_new.sql": "select 1;\n"})
        self.assertHeld(self.run_tool("run"), "004_new.sql")
        self.assertEqual(self.deploy_calls(), [])

    def test_renamed_and_removed_migrations_hold(self):
        self.switch_on()
        self.commit({"web/supabase/migrations/001_renamed.sql": "create table t (id int);\n"},
                    remove=["web/supabase/migrations/001_start.sql"])
        self.assertHeld(self.run_tool("run"), "001_renamed.sql", "001_start.sql")
        self.assertEqual(self.deploy_calls(), [])

    def test_a_migration_in_the_middle_of_a_range_holds(self):
        self.switch_on()
        self.commit({"web/supabase/migrations/002_more.sql": "select 1;\n"})
        self.commit({"web/app.txt": "two\n"})
        self.assertHeld(self.run_tool("run"), "002_more.sql")

    def test_a_migration_brought_by_a_merge_commit_holds(self):
        self.switch_on()
        self.git(self.dev, "switch", "-q", "-c", "side")
        self.commit_on_branch("side", {"web/supabase/migrations/002_side.sql": "select 1;\n"})
        self.git(self.dev, "switch", "-q", "main")
        self.commit({"web/app.txt": "two\n"})
        self.git(self.dev, "merge", "-q", "--no-ff", "-m", "merge", "side")
        self.git(self.dev, "push", "-q", "origin", "main")
        self.assertHeld(self.run_tool("run"), "002_side.sql")

    def commit_on_branch(self, branch, files):
        for name, text in files.items():
            write(os.path.join(self.dev, name), text)
        self.git(self.dev, "add", "-A")
        self.git(self.dev, "commit", "-q", "-m", "on " + branch)

    def test_names_git_would_quote_are_held_and_stay_held(self):
        self.switch_on()
        for name in ("web/supabase/migrations/003_café.sql", 'web/supabase/migrations/004_"quoted".sql'):
            seen = self.commit({name: "select 1;\n"})
            r = self.run_tool("run")
            self.assertHeld(r, os.path.basename(name))
            self.run_ok("acknowledge", seen)
            self.commit({name: "drop table t;\n"})
            self.assertHeld(self.run_tool("run"), os.path.basename(name))
            self.assertEqual(self.deploy_calls(), [])
            self.commit({name: "select 1;\n"})  # back to what was acknowledged
            self.run_ok("run")
            self.assertEqual(self.serving(), self.git(self.dev, "rev-parse", "HEAD"))
            os.remove(os.path.join(self.fake, "deploy-calls"))

    def test_a_failing_git_holds_instead_of_passing(self):
        self.switch_on()
        self.commit({"web/supabase/migrations/002_more.sql": "select 1;\n"})
        wrap = os.path.join(self.tmp, "gitwrap")
        write(os.path.join(wrap, "git"), '#!/usr/bin/env bash\nfor a in "$@"; do [ "$a" = diff ] && { echo boom >&2; exit 128; }; done\nexec %s "$@"\n' % shutil.which("git"), 0o755)
        self.env["PATH"] = wrap + os.pathsep + self.env["PATH"]
        self.assertHeld(self.run_tool("run"))
        self.assertEqual(self.deploy_calls(), [])
        self.assertEqual(self.head(), self.first)

    def test_files_other_stacks_use_hold(self):
        self.switch_on()
        for name in ("web/supabase/functions/hook/index.ts", "web/supabase/templates/invite.html",
                     "deploy/edge/Caddyfile", "deploy/supabase/x.yaml", "deploy/inngest/sync.sh", "deploy/backup/crontab",
                     "deploy/livekit/compose.yaml", "recorder/src/main.ts", "recorder/package-lock.json"):
            new = self.commit({name: "changed %s\n" % name})
            r = self.run_tool("run")
            self.assertHeld(r, name, "a person deploys this one")
            self.assertEqual(self.head(), self.first if not self.deploy_calls() else self.deploy_calls()[-1])
            self.run_ok("acknowledge", new)
            self.run_ok("run")
            self.assertEqual(self.deploy_calls()[-1], new)

    def test_a_mode_change_or_a_symlink_after_acknowledging_holds(self):
        self.switch_on()
        a = self.commit({"deploy/backup/run.sh": "echo hi\n", "deploy/backup/target": "../app/x"})
        self.run_tool("run")
        self.run_ok("acknowledge", a)
        os.chmod(os.path.join(self.dev, "deploy/backup/run.sh"), 0o755)
        self.commit({})
        self.assertHeld(self.run_tool("run"), "run.sh")
        os.chmod(os.path.join(self.dev, "deploy/backup/run.sh"), 0o644)
        os.remove(os.path.join(self.dev, "deploy/backup/target"))
        os.symlink("../app/x", os.path.join(self.dev, "deploy/backup/target"))
        self.commit({})
        self.assertHeld(self.run_tool("run"), "target")
        self.assertEqual(self.deploy_calls(), [])

    def test_a_failing_watched_files_diff_holds(self):
        self.switch_on()
        self.commit({"web/supabase/migrations/002_more.sql": "select 1;\n"})
        wrap = os.path.join(self.tmp, "gitwrap")
        # Only the diff of the watched files fails (it is the one with --raw).
        write(os.path.join(wrap, "git"), '#!/usr/bin/env bash\nfor a in "$@"; do [ "$a" = --raw ] && { echo boom >&2; exit 128; }; done\nexec %s "$@"\n' % shutil.which("git"), 0o755)
        self.env["PATH"] = wrap + os.pathsep + self.env["PATH"]
        self.assertHeld(self.run_tool("run"), "could not list the files the new commits change")
        self.assertEqual(self.deploy_calls(), [])

    def test_the_servers_own_deploy_tooling_holds(self):
        self.switch_on()
        for name in ("deploy/app/deploy.sh", "deploy/app/auto-deploy.sh", "deploy/app/check_settings.py",
                     "deploy/app/compose.yaml", "deploy/app/ni-auto-deploy.timer", "deploy/app/proxy/Caddyfile",
                     # Files nobody listed are held too: one Compose reads beside compose.yaml by
                     # itself, the one that says what a build may take from the checkout, a
                     # folder Python would import from, and anything else that is new there.
                     "deploy/app/compose.override.yaml", "deploy/app/docker-compose.yml",
                     # The Dockerfile's first line names the program that drives the build.
                     "deploy/app/Dockerfile", "deploy/app/Dockerfile.dockerignore",
                     "deploy/app/json/__init__.py", "deploy/app/new-folder/run"):
            new = self.commit({name: "changed\n"})
            self.assertHeld(self.run_tool("run"), name, "deploy tooling")
            self.run_ok("acknowledge", new)
            self.run_ok("run")
            self.assertEqual(self.deploy_calls()[-1], new)
        # What only runs inside the containers is the app's, like web/: not held. Nor
        # are the tests and the guide, here or the call recorder's.
        new = self.commit({"deploy/app/cron/crontab": "* * * * * x\n", "deploy/app/cron/run.sh": "x\n",
                           "deploy/app/smoke/compose.yaml": "x\n", "deploy/app/healthcheck.mjs": "x\n",
                           "deploy/app/eve-origin.mjs": "x\n", "deploy/app/tests/test_x.py": "x\n",
                           "deploy/app/README.md": "x\n", "recorder/test/x.test.ts": "x\n",
                           "recorder/e2e/run.mjs": "x\n", "recorder/README.md": "x\n"})
        self.run_ok("run")
        self.assertEqual(self.deploy_calls()[-1], new)

    def test_every_held_file_is_counted_and_listed(self):
        self.switch_on()
        new = self.commit({"web/supabase/migrations/1%02d.sql" % i: "select %d;\n" % i for i in range(12)})
        self.assertHeld(self.run_tool("run"), "(12)", "and 4 more", "every file: sudo ./auto-deploy.sh status")
        status = self.run_ok("status").stdout
        for i in range(12):
            self.assertIn("migration: web/supabase/migrations/1%02d.sql" % i, status)
        self.assertIn("111.sql", self.run_ok("run", "--dry-run").stdout)
        r = self.run_ok("acknowledge", new)
        self.assertIn("12 files", r.stdout)
        self.assertIn("111.sql", r.stdout)

    def test_acknowledge_takes_only_a_commit_of_main(self):
        self.switch_on()
        self.commit({"web/supabase/migrations/002.sql": "select 1;\n"})
        self.run_tool("run")
        self.git(self.dev, "switch", "-q", "-c", "side")
        side = self.commit_on_branch("side", {"web/supabase/migrations/003.sql": "select 1;\n"}) or self.git(self.dev, "rev-parse", "HEAD")
        self.git(self.dev, "push", "-q", "origin", "side")
        self.git(self.checkout, "fetch", "-q", "origin", "side")
        r = self.run_tool("acknowledge", side)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("not on origin/main", r.stderr)

    # --- settings, and the state of the checkout -------------------------------

    def test_a_new_setting_holds_until_env_has_its_line(self):
        self.switch_on()
        self.commit({"deploy/app/.env.example": "# made-up settings\nAPP_URL=\nSIGNING_KEY=\nNEW_ONE=\n#OPTIONAL_ONE=\n#ANOTHER_OPTIONAL=\n"})
        r = self.run_tool("run")
        self.assertHeld(r, "NEW_ONE")
        self.assertNotIn("ANOTHER_OPTIONAL", r.stdout)  # commented out: optional
        self.assertNotIn("APP_URL", r.stdout)
        with open(os.path.join(self.checkout, "deploy/app/.env"), "a") as f:
            f.write("NEW_ONE=\n")
        self.run_ok("run")
        self.assertEqual(len(self.deploy_calls()), 1)

    def test_an_env_example_that_cannot_be_read_as_settings_holds(self):
        self.switch_on()
        example = os.path.join(self.dev, "deploy/app/.env.example")
        self.commit(remove=["deploy/app/.env.example"])
        self.assertHeld(self.run_tool("run"), "remove deploy/app/.env.example")
        os.symlink("../edge/Caddyfile", example)
        self.commit()
        self.assertHeld(self.run_tool("run"), "not a plain file")
        os.remove(example)
        self.commit({"deploy/app/.env.example/inner": "NEW_ONE=\n"})
        self.assertHeld(self.run_tool("run"), "not a plain file")
        shutil.rmtree(example)
        # Lines the reader of settings skips, but Compose would take.
        for line in ("export NEW_ONE=", "  NEW_ONE=", "NEW ONE"):
            self.commit({"deploy/app/.env.example": "APP_URL=\nSIGNING_KEY=\n%s\n" % line})
            self.assertHeld(self.run_tool("run"), "neither NAME=value nor a comment", "line 3")
        self.assertEqual(self.deploy_calls(), [])
        self.commit({"deploy/app/.env.example": "APP_URL=\n\n# a comment\nSIGNING_KEY=\n"})
        self.run_ok("run")
        self.assertEqual(len(self.deploy_calls()), 1)

    def test_the_repositorys_own_env_example_reads_as_settings(self):
        self.switch_on()
        self.commit({"deploy/app/.env.example": read(os.path.join(os.path.dirname(SCRIPT), ".env.example"))})
        # Held for the names the made-up .env lacks, not for a line it cannot read.
        self.assertHeld(self.run_tool("run"), "settings that .env has no line for")

    def test_settings_that_cannot_be_compared_hold(self):
        self.switch_on()
        self.commit({"web/app.txt": "two\n"})
        os.remove(os.path.join(self.checkout, "deploy/app/.env"))
        self.assertHeld(self.run_tool("run"), "could not compare deploy/app/.env.example with .env")
        self.assertEqual(self.deploy_calls(), [])

    def test_a_folder_named_like_a_standard_module_beside_the_tool_never_runs(self):
        # A copy of the tool with, beside it, what a merge could add: files Python
        # would import instead of its own modules if it looked in that folder.
        tool = os.path.join(self.tmp, "tool")
        os.makedirs(tool)
        for name in ("auto-deploy.sh", "check_settings.py", "ni-auto-deploy.service", "ni-auto-deploy.timer"):
            shutil.copy(os.path.join(os.path.dirname(SCRIPT), name), tool)
        marker = os.path.join(self.tmp, "ran")
        for shadow in ("json/__init__.py", "re.py", "importlib/__init__.py", "os.py"):
            write(os.path.join(tool, shadow), "open(%r, 'w').close()\n" % marker)
        script = os.path.join(tool, "auto-deploy.sh")
        self.assertEqual(self.run_tool("install", script=script).returncode, 0)
        self.assertEqual(self.run_tool("on", script=script).returncode, 0)
        new = self.commit({"web/app.txt": "two\n"})
        r = self.run_tool("run", script=script)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.serving(), new)  # the settings were compared, and it deployed
        self.assertFalse(os.path.exists(marker))

    def test_any_failing_read_of_the_checkout_holds(self):
        self.switch_on()
        self.commit({"web/app.txt": "two\n"})
        for words, said in ((("status",), "git status failed in the checkout"),
                            (("ls-files",), "could not check who owns the checkout's files"),
                            (("--diff-filter=A",), "could not list what the new commits add"),
                            (("ls-tree",), "could not read the new deploy/app/.env.example"),
                            (("show",), "could not read the new deploy/app/.env.example")):
            self.failing_git(*words)
            self.assertHeld(self.run_tool("run"), said)
            self.assertEqual(self.deploy_calls(), [])
            self.assertEqual(self.head(), self.first)

    def test_a_list_of_changed_files_that_cannot_be_read_holds(self):
        self.switch_on()
        self.commit({"web/app.txt": "two\n"})
        # A well-formed entry, then something that is not one.
        self.failing_git("--raw", instead=r"printf ':100644 100644 %040d %040d M\0web/supabase/migrations/x.sql\0\0stray\0' 0 1; exit 0")
        self.assertHeld(self.run_tool("run"), "could not compare the changed files with the acknowledged ones")
        self.assertEqual(self.deploy_calls(), [])

    def test_acknowledgements_that_cannot_be_read_hold(self):
        self.switch_on()
        self.commit({"web/supabase/migrations/002_more.sql": "select 1;\n"})
        os.makedirs(os.path.join(self.state, "acknowledged"))
        self.assertHeld(self.run_tool("run"), "could not compare the changed files with the acknowledged ones")
        self.assertEqual(self.deploy_calls(), [])

    def test_rewritten_history_is_refused(self):
        self.switch_on()
        self.git(self.dev, "commit", "-q", "--amend", "-m", "rewritten")
        self.git(self.dev, "push", "-q", "--force", "origin", "main")
        self.assertHeld(self.run_tool("run"), "not a plain step forward")
        self.assertEqual(self.deploy_calls(), [])

    def test_a_dirty_checkout_is_refused_even_with_many_files(self):
        self.commit({"web/many/f%04d.txt" % i: "x\n" for i in range(4000)})
        self.git(self.checkout, "pull", "-q")
        write(os.path.join(self.fake, "running"), self.head() + "\n")
        self.switch_on()
        self.commit({"web/app.txt": "two\n"})
        for i in range(4000):
            write(os.path.join(self.checkout, "web/many/f%04d.txt" % i), "edited\n")
        self.assertHeld(self.run_tool("run"), "changes of its own", "and 3995 more")
        self.assertEqual(self.deploy_calls(), [])

    def test_not_on_main_is_refused(self):
        self.switch_on()
        self.commit({"web/app.txt": "two\n"})
        self.git(self.checkout, "switch", "-q", "-c", "other")
        self.assertHeld(self.run_tool("run"), "not main")

    def test_files_not_owned_by_the_owner_are_refused(self):
        self.switch_on()
        self.commit({"web/app.txt": "two\n"})
        self.env["AUTO_DEPLOY_OWNER_UID"] = str(os.getuid() + 1)
        self.assertHeld(self.run_tool("run"), "not owned by")
        self.assertEqual(self.deploy_calls(), [])

    def test_a_failed_fetch_holds(self):
        self.switch_on()
        self.git(self.checkout, "remote", "set-url", "origin", os.path.join(self.tmp, "gone.git"))
        self.assertHeld(self.run_tool("run"), "git fetch origin main failed")

    def test_a_commit_that_would_overwrite_an_ignored_file_holds(self):
        self.switch_on()
        write(os.path.join(self.dev, "deploy/app/.env"), "APP_URL=\n")
        self.git(self.dev, "add", "-f", "deploy/app/.env")
        self.git(self.dev, "commit", "-q", "-m", "tracks .env")
        self.git(self.dev, "push", "-q", "origin", "main")
        self.assertHeld(self.run_tool("run"), "deploy/app/.env")
        self.assertIn("never-shown-value", read(os.path.join(self.checkout, "deploy/app/.env")))

    # --- failures, rollbacks ---------------------------------------------------

    def test_a_failed_build_skips_that_commit_and_a_newer_one_is_tried(self):
        self.switch_on()
        self.flag("build-fails")
        bad = self.commit({"web/app.txt": "two\n"})
        r = self.run_tool("run")
        self.assertEqual(r.returncode, 1)
        self.assertTrue(self.current().startswith("failed: %s: the build failed" % bad[:12]))
        r = self.run_tool("run")
        self.assertEqual(r.returncode, 0)  # reporting a recorded failure is not a new one
        self.assertEqual(self.deploy_calls(), [bad])
        self.flag("build-fails", on=False)
        good = self.commit({"web/app.txt": "three\n"})
        self.run_ok("run")
        self.assertEqual(self.deploy_calls(), [bad, good])
        self.assertFalse(os.path.exists(os.path.join(self.state, "failed")))

    def test_a_failed_roll_out_holds_everything_until_cleared(self):
        self.switch_on()
        self.flag("rollout-fails")
        bad = self.commit({"web/app.txt": "two\n"})
        self.assertEqual(self.run_tool("run").returncode, 1)
        self.flag("rollout-fails", on=False)
        newer = self.commit({"web/app.txt": "three\n"})
        self.run_ok("run")
        self.assertEqual(self.deploy_calls(), [bad])  # not rolled out on top
        self.assertTrue(self.current().startswith("failed: %s" % bad[:12]))
        r = self.run_ok("clear-failure")
        self.assertIn("cleared", r.stdout)
        self.run_ok("run")
        self.assertEqual(self.deploy_calls(), [bad, newer])

    def test_a_run_killed_during_the_roll_out_holds_everything(self):
        self.switch_on()
        new = self.commit({"web/app.txt": "two\n"})
        os.makedirs(self.state, exist_ok=True)
        write(os.path.join(self.state, "failed"), "%s halt the run stopped during the roll-out\n" % new)
        self.run_ok("run")
        self.assertEqual(self.deploy_calls(), [])
        self.assertTrue(self.current().startswith("failed: "))

    def test_an_unreadable_failure_record_holds(self):
        self.switch_on()
        self.commit({"web/app.txt": "two\n"})
        os.makedirs(self.state, exist_ok=True)
        write(os.path.join(self.state, "failed"), "")
        self.assertHeld(self.run_tool("run"), "cannot be read")
        self.assertEqual(self.deploy_calls(), [])
        self.run_ok("clear-failure")
        self.run_ok("run")
        self.assertEqual(len(self.deploy_calls()), 1)

    def test_clear_failure_tries_the_same_commit_again(self):
        self.switch_on()
        self.flag("build-fails")
        bad = self.commit({"web/app.txt": "two\n"})
        self.run_tool("run")
        self.flag("build-fails", on=False)
        self.run_ok("clear-failure")
        self.run_ok("run")
        self.assertEqual(self.deploy_calls(), [bad, bad])
        self.assertEqual(self.head(), bad)
        self.assertTrue(self.current().startswith("deployed %s" % bad[:12]))
        self.assertIn("nothing to clear", self.run_ok("clear-failure").stdout)

    def test_a_failed_commit_deployed_by_hand_counts_as_serving(self):
        self.switch_on()
        self.flag("build-fails")
        bad = self.commit({"web/app.txt": "two\n"})
        self.run_tool("run")
        write(os.path.join(self.fake, "running"), bad + "\n")  # someone ran deploy.sh by hand
        self.run_ok("run")
        self.assertEqual(self.deploy_calls(), [bad])
        self.assertTrue(self.current().startswith("idle"))
        self.assertFalse(os.path.exists(os.path.join(self.state, "failed")))

    def test_the_label_must_name_the_new_commit(self):
        self.switch_on()
        self.flag("serves-old")
        new = self.commit({"web/app.txt": "two\n"})
        r = self.run_tool("run")
        self.assertEqual(r.returncode, 1)
        self.assertIn("ni-app:running is not %s" % new[:12], self.current())
        self.assertIn(" halt ", read(os.path.join(self.state, "failed")))

    def test_api_version_must_name_the_new_commit(self):
        self.switch_on()
        write(os.path.join(self.fake, "version"), self.first + "\n")
        new = self.commit({"web/app.txt": "two\n"})
        r = self.run_tool("run")
        self.assertEqual(r.returncode, 1)
        self.assertIn("/api/version", self.current())
        self.assertIn("%s halt" % new, read(os.path.join(self.state, "failed")))

    def test_a_rollback_by_hand_holds_everything_until_cleared(self):
        self.switch_on()
        new = self.commit({"web/app.txt": "two\n"})
        self.run_ok("run")
        write(os.path.join(self.fake, "running"), self.first + "\n")  # sudo ./deploy.sh --rollback
        self.run_ok("run")
        self.assertIn("a rollback", self.current())
        self.assertTrue(self.current().startswith("failed: "))
        self.commit({"README.txt": "docs only\n"})  # a newer merge does not lift it
        self.run_ok("run")
        self.assertEqual(self.deploy_calls(), [new])
        r = self.run_ok("clear-failure")
        self.assertIn("which is or contains %s" % new[:12], r.stdout)  # says what goes out next
        self.run_ok("run")
        self.assertEqual(len(self.deploy_calls()), 2)

    def test_a_rollback_after_a_deploy_by_hand_is_not_undone(self):
        self.switch_on()
        d = self.commit({"web/app.txt": "two\n"})
        self.run_ok("run")
        n = self.commit({"web/app.txt": "three\n"})
        self.git(self.checkout, "pull", "-q")
        write(os.path.join(self.fake, "running"), n + "\n")  # deployed by hand
        self.run_ok("run")
        write(os.path.join(self.fake, "running"), d + "\n")  # then rolled back by hand
        self.run_ok("run")
        self.run_ok("run")
        self.assertEqual(self.deploy_calls(), [d])
        self.assertIn("went from %s to %s" % (n[:12], d[:12]), self.current())

    def test_a_rollback_drops_the_acknowledgements(self):
        self.switch_on()
        d = self.commit({"web/app.txt": "two\n"})
        self.run_ok("run")
        n = self.commit({"web/supabase/migrations/002.sql": "alter table t add column n int;\n"})
        self.run_tool("run")
        self.run_ok("acknowledge", n)
        self.git(self.checkout, "pull", "-q")
        write(os.path.join(self.fake, "running"), n + "\n")  # rolled out by hand
        self.run_ok("run")
        write(os.path.join(self.fake, "running"), d + "\n")  # --rollback
        self.run_ok("run")
        self.run_ok("clear-failure")
        self.assertHeld(self.run_tool("run"), "002.sql")  # acknowledged again, or nothing
        self.assertEqual(self.deploy_calls(), [d])

    # A rollback is read from the images, so no run needs to have seen it happen.

    def test_a_rollback_no_run_saw_is_not_undone(self):
        self.switch_on()
        d = self.commit({"web/app.txt": "two\n"})
        self.run_ok("run")
        n = self.commit({"web/app.txt": "three\n"})
        self.git(self.checkout, "pull", "-q")
        self.by_hand(n)  # deployed by hand ...
        self.rollback_by_hand()  # ... and rolled back before the next run came
        self.assertIn("Would hold everything", self.run_ok("run", "--dry-run").stdout)
        self.run_ok("run")
        self.assertTrue(self.current().startswith("failed: %s" % n[:12]), self.current())
        self.assertIn("is not a later commit than what served before it", self.current())
        self.commit({"README.txt": "docs only\n"})  # a newer merge does not lift it
        self.run_ok("run")
        self.assertEqual(self.deploy_calls(), [d])
        self.assertEqual(self.serving(), d)
        r = self.run_ok("clear-failure")
        self.assertIn("which is or contains %s" % n[:12], r.stdout)
        self.run_ok("run")  # cleared: the same images do not hold it a second time
        self.assertEqual(len(self.deploy_calls()), 2)
        self.run_ok("run")
        self.assertTrue(self.current().startswith("deployed "), self.current())

    def test_a_rollback_made_while_it_was_off_is_not_undone(self):
        self.switch_on()
        d = self.commit({"web/app.txt": "two\n"})
        self.run_ok("run")
        self.run_ok("off")
        n = self.commit({"web/app.txt": "three\n"})
        self.git(self.checkout, "pull", "-q")
        self.by_hand(n)
        self.rollback_by_hand()
        self.run_ok("on")
        self.run_ok("run")
        self.run_ok("run")
        self.assertTrue(self.current().startswith("failed: %s" % n[:12]), self.current())
        self.assertEqual(self.deploy_calls(), [d])

    def test_a_rollback_made_before_the_first_run_is_not_undone(self):
        n = self.commit({"web/app.txt": "two\n"})
        self.git(self.checkout, "pull", "-q")
        self.by_hand(n)
        self.rollback_by_hand()
        self.switch_on()
        self.assertFalse(os.path.exists(os.path.join(self.state, "seen")))
        self.run_ok("run")
        self.assertTrue(self.current().startswith("failed: %s" % n[:12]), self.current())
        self.assertIn("Would do nothing", self.run_ok("run", "--dry-run").stdout)
        self.assertEqual(self.deploy_calls(), [])

    def test_going_forward_by_hand_holds_nothing(self):
        self.switch_on()
        n = self.commit({"web/app.txt": "two\n"})
        self.git(self.checkout, "pull", "-q")
        self.by_hand(n)
        self.run_ok("run")
        self.assertTrue(self.current().startswith("idle"), self.current())
        self.rollback_by_hand()  # back ...
        self.rollback_by_hand()  # ... and forward again, between two runs: what serves is the latest
        self.run_ok("run")
        self.assertTrue(self.current().startswith("idle"), self.current())
        self.assertFalse(os.path.exists(os.path.join(self.state, "failed")))

    def test_an_image_before_that_cannot_be_read_holds_until_cleared(self):
        for text in ("no-label\n", "0123456789abcdef\n"):  # no commit on it; one the checkout lacks
            write(os.path.join(self.fake, "previous"), text)
            for stale in ("seen", "failed"):
                if os.path.exists(os.path.join(self.state, stale)):
                    os.remove(os.path.join(self.state, stale))
            self.switch_on()
            self.commit({"web/app.txt": "changed, with %s" % text})
            self.run_ok("run")
            self.assertTrue(self.current().startswith("failed: "), self.current())
            self.assertIn("a rollback cannot be ruled out", self.current())
            self.assertEqual(self.deploy_calls(), [])
        self.run_ok("clear-failure")
        self.run_ok("run")
        self.assertEqual(len(self.deploy_calls()), 1)

    def test_docker_not_answering_holds_and_the_next_run_tries_again(self):
        self.switch_on()
        new = self.commit({"web/app.txt": "two\n"})
        for name in ("docker-ls-fails", "docker-inspect-fails"):
            write(os.path.join(self.fake, "previous"), self.first + "\n")
            self.flag(name)
            self.assertHeld(self.run_tool("run"), "cannot tell what served before the last roll-out")
            self.assertEqual(self.deploy_calls(), [])
            self.assertFalse(os.path.exists(os.path.join(self.state, "failed")))  # nothing to clear by hand
            self.flag(name, on=False)
        self.run_ok("run")
        self.assertEqual(self.deploy_calls(), [new])

    def test_the_mark_of_a_rollback_holds_whatever_was_rolled_out_after_it(self):
        self.switch_on()
        d = self.commit({"web/app.txt": "two\n"})
        self.run_ok("run")
        n = self.commit({"web/app.txt": "three\n"})
        self.git(self.checkout, "pull", "-q")
        self.by_hand(n)
        self.rollback_by_hand()
        mark = os.path.join(self.state, "rolled-back")
        write(mark, "2026-01-01T00:00:00Z\n")  # what deploy.sh --rollback leaves
        # Then d is built and rolled out again by hand: the images no longer show
        # that anything went back.
        write(os.path.join(self.fake, "previous"), d + "\n")
        self.assertIn("Would hold everything: deploy.sh --rollback was run", self.run_ok("run", "--dry-run").stdout)
        self.assertTrue(os.path.exists(mark))
        self.run_ok("run")
        self.assertTrue(self.current().startswith("failed: "), self.current())
        self.assertIn("deploy.sh --rollback was run by hand (2026-01-01T00:00:00Z)", self.current())
        self.assertFalse(os.path.exists(mark))  # taken once; the record of the failure holds from here
        self.run_ok("run")
        self.assertEqual(self.deploy_calls(), [d])
        self.run_ok("clear-failure")
        self.run_ok("run")
        self.assertEqual(self.deploy_calls(), [d, n])

    def test_the_mark_names_the_commit_it_went_back_from(self):
        self.switch_on()
        d = self.commit({"web/app.txt": "two\n"})
        self.run_ok("run")
        n = self.commit({"web/app.txt": "three\n"})
        self.git(self.checkout, "pull", "-q")
        self.by_hand(n)
        self.rollback_by_hand()
        write(os.path.join(self.state, "rolled-back"), "2026-01-01T00:00:00Z\n")
        self.assertIn("marked: deploy.sh --rollback was run by hand (2026-01-01T00:00:00Z)", self.run_ok("status").stdout)
        self.run_ok("off")
        self.assertIn("the first run holds everything", self.run_ok("on").stdout)
        self.run_ok("run")
        self.assertTrue(self.current().startswith("failed: %s: deploy.sh --rollback was run by hand" % n[:12]), self.current())
        self.assertIn("which is or contains %s" % n[:12], self.run_ok("clear-failure").stdout)
        self.assertEqual(self.deploy_calls(), [d])

    def test_after_a_half_done_roll_out_and_a_rollback_one_clear_failure_is_enough(self):
        self.switch_on()
        self.flag("rollout-fails")
        bad = self.commit({"web/app.txt": "two\n"})
        self.assertEqual(self.run_tool("run").returncode, 1)
        self.flag("rollout-fails", on=False)
        # sudo ./deploy.sh --rollback, as the failure says: what was being rolled out
        # becomes ni-app:previous, and the rollback leaves its mark.
        write(os.path.join(self.fake, "previous"), bad + "\n")
        mark = os.path.join(self.state, "rolled-back")
        write(mark, "2026-01-01T00:00:00Z\n")
        r = self.run_ok("clear-failure")
        self.assertIn("halt of %s, and the mark of a rollback by hand (2026-01-01T00:00:00Z)" % bad[:12], r.stdout)
        self.assertIn("which is or contains %s" % bad[:12], r.stdout)
        self.assertFalse(os.path.exists(mark))
        self.run_ok("run")  # neither the mark nor the same images hold it a second time
        self.assertEqual(self.deploy_calls(), [bad, bad])
        self.assertTrue(self.current().startswith("deployed %s" % bad[:12]), self.current())

    def test_clear_failure_takes_a_mark_no_run_has_taken(self):
        self.switch_on()
        d = self.commit({"web/app.txt": "two\n"})
        self.run_ok("run")
        n = self.commit({"web/app.txt": "three\n"})
        self.git(self.checkout, "pull", "-q")
        self.by_hand(n)
        self.rollback_by_hand()
        mark = os.path.join(self.state, "rolled-back")
        write(mark, "2026-01-01T00:00:00Z\n")
        r = self.run_ok("clear-failure")
        self.assertIn("cleared (rollback of %s)" % n[:12], r.stdout)
        self.assertIn("which is or contains %s" % n[:12], r.stdout)
        self.assertFalse(os.path.exists(mark))
        self.run_ok("run")
        self.assertEqual(self.deploy_calls(), [d, n])

    def test_clear_failure_names_a_step_back_no_run_has_judged(self):
        self.switch_on()
        d = self.commit({"web/app.txt": "two\n"})
        self.run_ok("run")
        self.flag("build-fails")
        n = self.commit({"web/app.txt": "three\n"})
        self.assertEqual(self.run_tool("run").returncode, 1)
        self.flag("build-fails", on=False)
        # An older commit is rolled out by hand with a plain deploy.sh (no --rollback,
        # so no mark), and the failed build is cleared before a run comes.
        self.by_hand(self.first)
        r = self.run_ok("clear-failure")
        self.assertIn("cleared (build of %s)" % n[:12], r.stdout)
        self.assertIn("which is or contains %s and %s (rolled back by hand), over %s" % (n[:12], d[:12], self.first[:12]), r.stdout)

    def test_a_rollback_drops_the_acknowledgements_at_once(self):
        self.switch_on()
        self.commit({"web/app.txt": "two\n"})
        self.run_ok("run")
        n = self.commit({"web/supabase/migrations/002.sql": "alter table t add column n int;\n"})
        self.run_tool("run")
        self.run_ok("acknowledge", n)
        self.assertTrue(os.path.exists(os.path.join(self.state, "acknowledged")))
        self.git(self.checkout, "pull", "-q")
        self.by_hand(n)
        self.rollback_by_hand()
        self.run_ok("run")
        self.assertTrue(self.current().startswith("failed: "), self.current())
        self.assertEqual(len(self.deploy_calls()), 1)  # not because it went out again
        self.assertFalse(os.path.exists(os.path.join(self.state, "acknowledged")))

    def test_clearing_a_half_done_roll_out_drops_the_acknowledgements_and_a_failed_build_keeps_them(self):
        self.switch_on()
        n = self.commit({"web/supabase/migrations/002.sql": "select 1;\n"})
        self.run_tool("run")
        self.run_ok("acknowledge", n)
        acknowledged = os.path.join(self.state, "acknowledged")
        self.flag("build-fails")
        self.assertEqual(self.run_tool("run").returncode, 1)
        self.flag("build-fails", on=False)
        self.run_ok("clear-failure")
        self.assertTrue(os.path.exists(acknowledged))  # nothing was replaced: they stand
        self.flag("rollout-fails")
        self.assertEqual(self.run_tool("run").returncode, 1)
        self.flag("rollout-fails", on=False)
        self.assertTrue(os.path.exists(acknowledged))
        self.run_ok("clear-failure")
        self.assertFalse(os.path.exists(acknowledged))
        self.assertHeld(self.run_tool("run"), "002.sql")

    def test_records_of_what_served_that_cannot_be_read_hold(self):
        self.switch_on()
        self.commit({"web/app.txt": "two\n"})
        for name, text in (("seen", "not a commit\n"), ("seen", self.first + " nor-this\n"), ("deployed", "not a commit\n")):
            write(os.path.join(self.state, name), text)
            self.assertHeld(self.run_tool("run"), "%s cannot be read" % name)
            os.remove(os.path.join(self.state, name))
        self.assertEqual(self.deploy_calls(), [])

    def test_an_image_built_from_another_commit_is_not_rolled_out(self):
        self.switch_on()
        write(os.path.join(self.fake, "built-label"), self.first + "\n")
        new = self.commit({"web/app.txt": "two\n"})
        r = self.run_tool("run")
        self.assertEqual(r.returncode, 1)
        self.assertEqual(self.deploy_calls(), [new])
        self.assertEqual(self.serving(), self.first)  # --no-build never ran
        self.assertIn("ni-app:live says %s" % self.first[:12], self.current())
        self.assertIn(" halt ", read(os.path.join(self.state, "failed")))

    def test_after_a_halt_clearing_says_the_same_commit_goes_out_again(self):
        self.switch_on()
        self.flag("rollout-fails")
        bad = self.commit({"web/app.txt": "two\n"})
        self.run_tool("run")
        self.flag("rollout-fails", on=False)
        r = self.run_ok("clear-failure")
        self.assertIn("the next run rolls out origin/main as last fetched, %s, which is or contains %s" % (bad[:12], bad[:12]), r.stdout)

    def test_a_checkout_moved_before_the_build_is_not_built(self):
        self.switch_on()
        new = self.commit({"web/app.txt": "two\n"})
        later = self.commit({"web/app.txt": "three\n"})
        self.git(self.dev, "push", "-q", "origin", "%s:refs/heads/later" % later)
        self.git(self.dev, "push", "-q", "--force", "origin", "%s:main" % new)
        self.git(self.checkout, "fetch", "-q", "origin", "later")
        wrap = os.path.join(self.tmp, "gitwrap")
        # A person's git pull lands between the run's checks and its merge.
        write(os.path.join(wrap, "git"), '#!/usr/bin/env bash\nreal=%s\nfor a in "$@"; do if [ "$a" = merge ]; then "$real" -C "$AUTO_DEPLOY_REPO" merge -q --ff-only %s; fi; done\nexec "$real" "$@"\n' % (shutil.which("git"), later), 0o755)
        self.env["PATH"] = wrap + os.pathsep + self.env["PATH"]
        r = self.run_tool("run")
        self.assertEqual(r.returncode, 1)
        self.assertEqual(self.deploy_calls(), [])
        self.assertIn("it was moved meanwhile", self.current())

    def test_a_checkout_moved_during_the_build_is_not_rolled_out(self):
        self.switch_on()
        self.flag("moved-during-build")
        new = self.commit({"web/app.txt": "two\n"})
        r = self.run_tool("run")
        self.assertEqual(r.returncode, 1)
        self.assertEqual(self.deploy_calls(), [new])
        self.assertEqual(self.serving(), self.first)  # --no-build never ran
        self.assertIn("moved during the build", self.current())
        self.assertIn(" halt ", read(os.path.join(self.state, "failed")))

    # --- the lock, the dry run, pings, systemd ---------------------------------

    def test_a_deploy_by_hand_makes_the_run_wait_and_says_so(self):
        self.switch_on()
        self.commit({"web/app.txt": "two\n"})
        with open(self.lock, "a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)  # deploy.sh, by hand
            r = self.run_ok("run")
            self.assertTrue(self.current().startswith("waiting: a deploy is running"))
            self.assertIn("A deploy is running", self.run_ok("status").stdout)
            self.assertIn("Do nothing", self.run_ok("run", "--dry-run").stdout)
            self.assertNotEqual(self.run_tool("acknowledge", self.first).returncode, 0)
            fcntl.flock(lock, fcntl.LOCK_UN)
        self.assertEqual(self.deploy_calls(), [])
        self.run_ok("run")
        self.assertEqual(len(self.deploy_calls()), 1)

    def test_dry_run_changes_nothing(self):
        def snapshot():
            out = {}
            for top, _, files in os.walk(self.state):
                for name in files:
                    with open(os.path.join(top, name), "rb") as f:
                        out[os.path.join(top, name)] = f.read()
            return out

        self.switch_on()
        new = self.commit({"web/app.txt": "two\n"})
        before = snapshot()
        r = self.run_ok("run", "--dry-run")
        self.assertIn("Would deploy %s" % new[:12], r.stdout)
        self.assertEqual(snapshot(), before)
        self.assertEqual(self.head(), self.first)
        self.assertEqual(self.deploy_calls(), [])
        self.commit({"web/supabase/migrations/002_more.sql": "select 1;\n"})
        r = self.run_ok("run", "--dry-run")
        self.assertIn("Would hold", r.stdout)
        self.assertEqual(snapshot(), before)
        self.assertEqual(self.fake_file("pings"), [])
        self.run_ok("off")
        r = self.run_ok("run", "--dry-run")
        self.assertIn("off", r.stdout)
        self.assertIn("Would hold", r.stdout)

    def test_pings_tell_well_holding_and_failed_apart(self):
        self.switch_on()
        with open(os.path.join(self.state, "settings"), "a") as f:
            f.write("AUTO_DEPLOY_PING_URL=https://ping.invalid/ok\n"
                    "AUTO_DEPLOY_HOLD_PING_URL=https://ping.invalid/hold\n"
                    "AUTO_DEPLOY_FAIL_PING_URL=https://ping.invalid/fail\n")
        self.run_ok("run")
        self.assertEqual(self.fake_file("pings"), ["https://ping.invalid/ok"])
        self.commit({"web/supabase/migrations/002_more.sql": "select 1;\n"})
        r = self.run_ok("run")
        self.assertNotIn("ping.invalid", r.stdout)
        self.assertEqual(self.fake_file("pings")[-1], "https://ping.invalid/hold")
        self.git(self.dev, "revert", "--no-edit", "HEAD")
        self.git(self.dev, "push", "-q", "origin", "main")
        self.flag("build-fails")
        self.run_tool("run")
        self.assertEqual(self.fake_file("pings")[-1], "https://ping.invalid/fail")
        self.run_tool("run")
        self.assertEqual(self.fake_file("pings")[-1], "https://ping.invalid/fail")
        self.flag("build-fails", on=False)
        self.commit({"web/app.txt": "two\n"})
        self.run_ok("run")
        self.assertEqual(self.fake_file("pings")[-1], "https://ping.invalid/ok")
        self.run_ok("off")
        n = len(self.fake_file("pings"))
        self.run_ok("run")
        self.assertEqual(len(self.fake_file("pings")), n)  # off: silence

    def test_install_writes_the_units_and_enables_nothing(self):
        r = self.run_ok("install")
        self.assertIn("nothing is enabled", r.stdout)
        service = read(os.path.join(self.units, "ni-auto-deploy.service"))
        self.assertIn("ExecStart=%s/deploy/app/auto-deploy.sh run" % self.checkout, service)
        self.assertNotIn("/opt/native-intelligence", service)
        self.assertIn("Persistent=true", read(os.path.join(self.units, "ni-auto-deploy.timer")))
        self.assertEqual(self.fake_file("systemctl-calls"), ["daemon-reload"])
        self.assertFalse(os.path.exists(os.path.join(self.state, "on")))
        self.assertEqual(oct(os.stat(os.path.join(self.state, "settings")).st_mode & 0o777), "0o600")
        self.run_ok("on")
        self.assertTrue(os.path.exists(os.path.join(self.state, "on")))
        self.assertIn("Switched off", self.run_ok("off").stdout)
        self.assertFalse(os.path.exists(os.path.join(self.state, "on")))
        self.assertEqual(self.fake_file("systemctl-calls"), [
            "daemon-reload", "enable --now ni-auto-deploy.timer", "disable --now ni-auto-deploy.timer"])

    def test_on_needs_the_units_installed(self):
        r = self.run_tool("on")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("install first", r.stderr)
        self.assertFalse(os.path.exists(os.path.join(self.state, "on")))

    def test_status_reads_without_changing_anything(self):
        self.switch_on()
        self.commit({"web/app.txt": "two\n"})
        self.run_ok("run")
        r = self.run_ok("status")
        self.assertIn("Automatic deploys: on", r.stdout)
        self.assertIn("state=deployed", r.stdout)
        self.assertIn("serving=", r.stdout)


if __name__ == "__main__":
    unittest.main()
