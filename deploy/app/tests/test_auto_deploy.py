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
import time
import unittest

SCRIPT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "auto-deploy.sh")

FAKE_DEPLOY = """#!/usr/bin/env bash
set -e
commit="$(git -C "$AUTO_DEPLOY_REPO" rev-parse HEAD)"
echo "$commit" >>"$FAKE/deploy-calls"
if [ -e "$FAKE/deploy-fails" ]; then echo "the build failed" >&2; exit 1; fi
[ -e "$FAKE/serves-old" ] || echo "$commit" >"$FAKE/running"
"""

FAKE_DOCKER = """#!/usr/bin/env bash
running="$(cat "$FAKE/running" 2>/dev/null || true)"
case "$*" in
*"image inspect"*ni-app:running*) echo "${running:0:12}" ;;
*"exec ni-app-proxy wget"*/api/version*) printf '{"buildId":"%s"}\\n' "${running:0:8}" ;;
*) exit 1 ;;
esac
"""

FAKE_CURL = """#!/usr/bin/env bash
echo "$*" >>"$FAKE/pings"
"""

FAKE_SYSTEMCTL = """#!/usr/bin/env bash
echo "$*" >>"$FAKE/systemctl-calls"
"""

# util-linux flock, as far as the script uses it: `flock -n <fd>` and `flock -n <file> <command>`.
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
            "web/supabase/migrations/001_start.sql": "create table t (id int);\n",
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

    def commit(self, files, remove=()):
        for name, text in files.items():
            write(os.path.join(self.dev, name), text)
        for name in remove:
            os.remove(os.path.join(self.dev, name))
        self.git(self.dev, "add", "-A")
        self.git(self.dev, "commit", "-q", "-m", "change")
        self.git(self.dev, "push", "-q", "origin", "main")
        return self.git(self.dev, "rev-parse", "HEAD")

    def run_tool(self, *args):
        r = subprocess.run(["bash", SCRIPT, *args], env=self.env, capture_output=True, text=True, timeout=60)
        self.assertNotIn("never-shown-value", r.stdout + r.stderr)
        return r

    def switch_on(self):
        self.assertEqual(self.run_tool("install").returncode, 0)
        r = self.run_tool("on")
        self.assertEqual(r.returncode, 0, r.stderr)

    def head(self):
        return self.git(self.checkout, "rev-parse", "HEAD")

    def deploy_calls(self):
        p = os.path.join(self.fake, "deploy-calls")
        if not os.path.exists(p):
            return []
        with open(p) as f:
            return f.read().split()

    def status(self):
        with open(os.path.join(self.state, "status")) as f:
            return dict(line.split("=", 1) for line in f.read().splitlines())

    def fake_flag(self, name, on=True):
        p = os.path.join(self.fake, name)
        if on:
            open(p, "w").close()
        elif os.path.exists(p):
            os.remove(p)

    # --- tests -----------------------------------------------------------------

    def test_off_does_nothing(self):
        self.assertEqual(self.run_tool("install").returncode, 0)
        self.commit({"web/app.txt": "two\n"})
        r = self.run_tool("run")
        self.assertEqual(r.returncode, 0)
        self.assertEqual(r.stdout, "")
        self.assertEqual(self.deploy_calls(), [])
        self.assertEqual(self.head(), self.first)
        self.assertFalse(os.path.exists(os.path.join(self.state, "status")))

    def test_nothing_new_does_nothing(self):
        self.switch_on()
        r = self.run_tool("run")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.deploy_calls(), [])
        self.assertTrue(self.status()["state"].startswith("idle"))

    def test_a_plain_commit_is_pulled_and_deployed_once(self):
        self.switch_on()
        new = self.commit({"web/app.txt": "two\n"})
        r = self.run_tool("run")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.deploy_calls(), [new])
        self.assertEqual(self.head(), new)
        self.assertTrue(self.status()["state"].startswith("deployed %s at " % new[:12]))
        self.assertEqual(len(os.listdir(os.path.join(self.state, "runs"))), 1)
        r = self.run_tool("run")
        self.assertEqual(r.returncode, 0)
        self.assertEqual(r.stdout, "")  # nothing new: no log line
        self.assertEqual(self.deploy_calls(), [new])
        self.assertTrue(self.status()["state"].startswith("deployed %s at " % new[:12]))

    def test_it_moves_to_the_commit_it_checked_not_a_later_one(self):
        self.switch_on()
        new = self.commit({"web/app.txt": "two\n"})
        self.assertEqual(self.run_tool("run").returncode, 0)
        self.assertEqual(self.head(), new)
        self.assertEqual(self.git(self.checkout, "rev-parse", "--abbrev-ref", "HEAD"), "main")

    def test_a_migration_holds_until_acknowledged_and_only_for_what_was_seen(self):
        self.switch_on()
        new = self.commit({"web/supabase/migrations/002_more.sql": "alter table t add column n int;\n"})
        r = self.run_tool("run")
        self.assertEqual(r.returncode, 2)
        self.assertIn("002_more.sql", r.stdout)
        self.assertIn("migrations-applied %s" % new[:12], r.stdout)
        self.assertEqual(self.deploy_calls(), [])
        self.assertEqual(self.head(), self.first)
        self.assertTrue(self.status()["state"].startswith("holding: "))
        # Held again on the next run, without a second log line.
        r = self.run_tool("run")
        self.assertEqual(r.returncode, 2)
        self.assertEqual(r.stdout, "")

        r = self.run_tool("migrations-applied", new[:12])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("002_more.sql", r.stdout)
        self.assertEqual(oct(os.stat(os.path.join(self.state, "migrations-acknowledged")).st_mode & 0o777), "0o600")
        r = self.run_tool("run")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.deploy_calls(), [new])

        # A second migration later is held again.
        later = self.commit({"web/supabase/migrations/003_again.sql": "select 1;\n"})
        r = self.run_tool("run")
        self.assertEqual(r.returncode, 2)
        self.assertIn("003_again.sql", r.stdout)
        self.assertEqual(self.deploy_calls(), [new])
        self.assertEqual(self.head(), new)
        self.assertEqual(self.run_tool("migrations-applied", later).returncode, 0)
        self.assertEqual(self.run_tool("run").returncode, 0)
        self.assertEqual(self.deploy_calls(), [new, later])

    def test_an_acknowledgement_does_not_cover_what_arrives_after_it(self):
        self.switch_on()
        seen = self.commit({"web/supabase/migrations/002_more.sql": "alter table t add column n int;\n"})
        self.assertEqual(self.run_tool("run").returncode, 2)
        self.assertEqual(self.run_tool("migrations-applied", seen).returncode, 0)
        # Before the next run, the same file changes again and another one arrives.
        self.commit({"web/supabase/migrations/002_more.sql": "alter table t add column m int;\n"})
        r = self.run_tool("run")
        self.assertEqual(r.returncode, 2)
        self.assertIn("002_more.sql", r.stdout)
        self.assertEqual(self.deploy_calls(), [])
        self.assertEqual(self.head(), self.first)

    def test_migrations_applied_needs_a_waiting_migration(self):
        self.switch_on()
        new = self.commit({"web/app.txt": "two\n"})
        r = self.run_tool("migrations-applied", new)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("no commit", r.stderr)  # not fetched yet: no run has seen it
        self.git(self.checkout, "fetch", "-q", "origin", "main")
        r = self.run_tool("migrations-applied", new)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("nothing to acknowledge", r.stderr)
        self.assertNotEqual(self.run_tool("migrations-applied").returncode, 0)

    def test_a_new_setting_holds_until_env_has_its_line(self):
        self.switch_on()
        self.commit({"deploy/app/.env.example": "# made-up settings\nAPP_URL=\nSIGNING_KEY=\nNEW_ONE=\n#OPTIONAL_ONE=\n#ANOTHER_OPTIONAL=\n"})
        r = self.run_tool("run")
        self.assertEqual(r.returncode, 2)
        self.assertIn("NEW_ONE", r.stdout)
        self.assertNotIn("ANOTHER_OPTIONAL", r.stdout)  # commented out: optional
        self.assertNotIn("APP_URL", r.stdout)
        self.assertEqual(self.deploy_calls(), [])
        with open(os.path.join(self.checkout, "deploy/app/.env"), "a") as f:
            f.write("NEW_ONE=\n")
        r = self.run_tool("run")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(len(self.deploy_calls()), 1)

    def test_rewritten_history_is_refused(self):
        self.switch_on()
        self.git(self.dev, "commit", "-q", "--amend", "-m", "rewritten")
        self.git(self.dev, "push", "-q", "--force", "origin", "main")
        r = self.run_tool("run")
        self.assertEqual(r.returncode, 2)
        self.assertIn("not a plain step forward", r.stdout)
        self.assertEqual(self.deploy_calls(), [])
        self.assertEqual(self.head(), self.first)

    def test_a_dirty_checkout_is_refused(self):
        self.switch_on()
        self.commit({"web/app.txt": "two\n"})
        write(os.path.join(self.checkout, "web/app.txt"), "edited on the server\n")
        r = self.run_tool("run")
        self.assertEqual(r.returncode, 2)
        self.assertIn("web/app.txt", r.stdout)
        self.assertEqual(self.deploy_calls(), [])
        self.assertEqual(self.head(), self.first)

    def test_a_failed_deploy_is_recorded_and_not_retried_until_main_moves(self):
        self.switch_on()
        self.fake_flag("deploy-fails")
        bad = self.commit({"web/app.txt": "two\n"})
        r = self.run_tool("run")
        self.assertEqual(r.returncode, 1)
        self.assertIn("deploy.sh failed", r.stdout)
        self.assertTrue(self.status()["state"].startswith("failed: %s" % bad[:12]))
        r = self.run_tool("run")
        self.assertEqual(r.returncode, 1)
        self.assertEqual(self.deploy_calls(), [bad])  # not tried again
        self.assertTrue(self.status()["state"].startswith("failed: "))
        self.fake_flag("deploy-fails", on=False)
        good = self.commit({"web/app.txt": "three\n"})
        r = self.run_tool("run")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.deploy_calls(), [bad, good])
        self.assertFalse(os.path.exists(os.path.join(self.state, "failed")))

    def test_clear_failure_tries_the_same_commit_again(self):
        self.switch_on()
        self.fake_flag("deploy-fails")
        bad = self.commit({"web/app.txt": "two\n"})
        self.assertEqual(self.run_tool("run").returncode, 1)
        self.fake_flag("deploy-fails", on=False)
        r = self.run_tool("clear-failure")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("cleared", r.stdout)
        r = self.run_tool("run")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.deploy_calls(), [bad, bad])
        self.assertTrue(self.status()["state"].startswith("deployed %s" % bad[:12]))
        self.assertIn("No failure", self.run_tool("clear-failure").stdout)

    def test_clear_failure_after_a_fix_by_hand_builds_nothing(self):
        self.switch_on()
        self.fake_flag("deploy-fails")
        bad = self.commit({"web/app.txt": "two\n"})
        self.assertEqual(self.run_tool("run").returncode, 1)
        write(os.path.join(self.fake, "running"), bad + "\n")  # someone ran deploy.sh by hand
        self.assertEqual(self.run_tool("clear-failure").returncode, 0)
        r = self.run_tool("run")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.deploy_calls(), [bad])
        self.assertTrue(self.status()["state"].startswith("deployed %s" % bad[:12]))

    def test_a_deploy_that_leaves_the_old_version_serving_is_a_failure(self):
        self.switch_on()
        self.fake_flag("serves-old")
        new = self.commit({"web/app.txt": "two\n"})
        r = self.run_tool("run")
        self.assertEqual(r.returncode, 1)
        self.assertIn("ni-app:running was built from %s" % self.first[:12], r.stdout)
        self.assertTrue(self.status()["state"].startswith("failed: %s" % new[:12]))

    def test_the_lock_and_a_deploy_by_hand(self):
        self.switch_on()
        self.commit({"web/app.txt": "two\n"})
        with open(os.path.join(self.state, "lock"), "a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            r = self.run_tool("run")
            self.assertEqual(r.returncode, 0)
            self.assertEqual(r.stdout, "")
            self.assertIn("in progress", self.run_tool("status").stdout)
            fcntl.flock(lock, fcntl.LOCK_UN)
        self.assertEqual(self.deploy_calls(), [])
        # A deploy.sh someone started by hand.
        write(os.path.join(self.tmp, "byhand", "deploy.sh"), "#!/usr/bin/env bash\nsleep 30\n", 0o755)
        p = subprocess.Popen(["bash", os.path.join(self.tmp, "byhand", "deploy.sh")])
        try:
            time.sleep(0.3)
            r = self.run_tool("run")
            self.assertEqual(r.returncode, 0)
            self.assertEqual(self.deploy_calls(), [])
        finally:
            p.kill()
            p.wait()
        self.assertEqual(self.run_tool("run").returncode, 0)
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
        r = self.run_tool("run", "--dry-run")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("Would deploy %s" % new[:12], r.stdout)
        self.assertEqual(snapshot(), before)
        self.assertEqual(self.head(), self.first)
        self.assertEqual(self.deploy_calls(), [])
        self.commit({"web/supabase/migrations/002_more.sql": "select 1;\n"})
        r = self.run_tool("run", "--dry-run")
        self.assertEqual(r.returncode, 2)
        self.assertIn("Would hold", r.stdout)
        self.assertEqual(snapshot(), before)
        # Off, it says what a run would do were it on.
        self.assertEqual(self.run_tool("off").returncode, 0)
        r = self.run_tool("run", "--dry-run")
        self.assertIn("off", r.stdout)
        self.assertIn("Would hold", r.stdout)

    def test_install_writes_the_units_and_enables_nothing(self):
        r = self.run_tool("install")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("nothing is enabled", r.stdout)
        with open(os.path.join(self.units, "ni-auto-deploy.service")) as f:
            service = f.read()
        self.assertIn("ExecStart=%s/deploy/app/auto-deploy.sh run" % self.checkout, service)
        self.assertNotIn("/opt/native-intelligence", service)
        with open(os.path.join(self.units, "ni-auto-deploy.timer")) as f:
            timer = f.read()
        self.assertIn("Persistent=true", timer)
        with open(os.path.join(self.fake, "systemctl-calls")) as f:
            self.assertEqual(f.read().split("\n")[:-1], ["daemon-reload"])
        self.assertFalse(os.path.exists(os.path.join(self.state, "on")))
        self.assertEqual(oct(os.stat(os.path.join(self.state, "settings")).st_mode & 0o777), "0o600")

        self.assertEqual(self.run_tool("on").returncode, 0)
        self.assertTrue(os.path.exists(os.path.join(self.state, "on")))
        r = self.run_tool("off")
        self.assertEqual(r.returncode, 0)
        self.assertIn("Switched off", r.stdout)
        self.assertFalse(os.path.exists(os.path.join(self.state, "on")))
        with open(os.path.join(self.fake, "systemctl-calls")) as f:
            self.assertEqual(f.read().split("\n")[:-1], [
                "daemon-reload", "enable --now ni-auto-deploy.timer", "disable --now ni-auto-deploy.timer"])

    def test_on_needs_the_units_installed(self):
        r = self.run_tool("on")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("install first", r.stderr)
        self.assertFalse(os.path.exists(os.path.join(self.state, "on")))

    def test_the_ping_follows_a_deploy_and_never_a_hold_or_a_failure(self):
        self.switch_on()
        with open(os.path.join(self.state, "settings"), "a") as f:
            f.write("AUTO_DEPLOY_PING_URL=https://ping.invalid/made-up\n")
        pings = os.path.join(self.fake, "pings")
        self.commit({"web/supabase/migrations/002_more.sql": "select 1;\n"})
        self.assertEqual(self.run_tool("run").returncode, 2)
        self.assertFalse(os.path.exists(pings))
        self.git(self.dev, "revert", "--no-edit", "HEAD")
        self.fake_flag("deploy-fails")
        self.git(self.dev, "push", "-q", "origin", "main")
        self.assertEqual(self.run_tool("run").returncode, 1)
        self.assertFalse(os.path.exists(pings))
        self.fake_flag("deploy-fails", on=False)
        self.commit({"web/app.txt": "two\n"})
        r = self.run_tool("run")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        with open(pings) as f:
            self.assertIn("https://ping.invalid/made-up", f.read())
        self.assertNotIn("ping.invalid", r.stdout)

    def test_status_reads_without_changing_anything(self):
        self.switch_on()
        self.commit({"web/app.txt": "two\n"})
        self.run_tool("run")
        r = self.run_tool("status")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("Automatic deploys: on", r.stdout)
        self.assertIn("state=deployed", r.stdout)


if __name__ == "__main__":
    unittest.main()
