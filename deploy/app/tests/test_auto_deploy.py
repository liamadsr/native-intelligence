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
	;;
--no-build)
	[ ! -e "$FAKE/rollout-fails" ] || { echo "the roll-out failed" >&2; exit 1; }
	[ -e "$FAKE/serves-old" ] || echo "$commit" >"$FAKE/running"
	;;
*) exit 2 ;;
esac
"""

FAKE_DOCKER = """#!/usr/bin/env bash
running="$(cat "$FAKE/running" 2>/dev/null || true)"
version="$(cat "$FAKE/version" 2>/dev/null || echo "$running")"
case "$*" in
*"image inspect"*ni-app:running*) [ -n "$running" ] || exit 1; echo "${running:0:12}" ;;
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

    def run_tool(self, *args):
        r = subprocess.run(["bash", SCRIPT, *args], env=self.env, capture_output=True, text=True, timeout=120)
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
                     "deploy/edge/Caddyfile", "deploy/supabase/x.yaml", "deploy/inngest/sync.sh", "deploy/backup/crontab"):
            new = self.commit({name: "changed %s\n" % name})
            r = self.run_tool("run")
            self.assertHeld(r, name, "a person deploys this one")
            self.assertEqual(self.head(), self.first if not self.deploy_calls() else self.deploy_calls()[-1])
            self.run_ok("acknowledge", new)
            self.run_ok("run")
            self.assertEqual(self.deploy_calls()[-1], new)

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

    def test_a_rollback_by_hand_is_not_undone(self):
        self.switch_on()
        new = self.commit({"web/app.txt": "two\n"})
        self.run_ok("run")
        write(os.path.join(self.fake, "running"), self.first + "\n")  # sudo ./deploy.sh --rollback
        self.assertHeld(self.run_tool("run"), "rolled back by hand")
        self.assertHeld(self.run_tool("run"), "rolled back by hand")
        self.assertEqual(self.deploy_calls(), [new])
        self.run_ok("clear-failure")
        self.run_ok("run")
        self.assertEqual(self.deploy_calls(), [new, new])

    def test_after_a_rollback_a_newer_commit_is_deployed(self):
        self.switch_on()
        new = self.commit({"web/app.txt": "two\n"})
        self.run_ok("run")
        write(os.path.join(self.fake, "running"), self.first + "\n")
        self.run_tool("run")
        newer = self.commit({"web/app.txt": "three\n"})
        self.run_ok("run")
        self.assertEqual(self.deploy_calls(), [new, newer])

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
