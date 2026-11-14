"""Tests for entrypoint.sh's refusal of the earlier host's own variables:
python3 -m unittest discover -s deploy/app/tests

The entrypoint is run with sh, outside the image: a role that gets past the refusal
stops at the next check (there is no /app here), which is how "not refused" shows.
Every value here is made up.
"""
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
import check_settings as cs  # noqa: E402

ENTRYPOINT = os.path.join(HERE, "entrypoint.sh")
NAMES = ("VERCEL", "VERCEL_ENV", "VERCEL_TARGET_ENV", "VERCEL_URL", "VERCEL_PROJECT_ID", "VERCEL_TEAM_ID", "VERCEL_ORG_ID",
         "VERCEL_TOKEN", "VERCEL_OIDC_TOKEN")
VALUE = "made-up-value-that-must-not-show"


def read(name):
    with open(os.path.join(HERE, name)) as f:
        return f.read()


def run(args, **extra):
    env = {"PATH": os.environ["PATH"], **extra}
    return subprocess.run(["sh", ENTRYPOINT, *args], env=env, capture_output=True, text=True, timeout=60)


class RefusesTheEarlierHostsVariables(unittest.TestCase):
    def test_no_role_starts_with_one_set(self):
        for role in (["web"], ["worker"], ["agent", "chat-agent"], ["cron"]):
            for name in NAMES:
                with self.subTest(role=role, name=name):
                    r = run(role, **{name: VALUE})
                    self.assertEqual(r.returncode, 64)
                    self.assertIn("entrypoint: %s is set." % name, r.stderr)
                    self.assertIn("Remove the line from .env.", r.stderr)
                    self.assertNotIn(VALUE, r.stdout + r.stderr)

    def test_the_role_from_NI_ROLE_is_refused_too(self):
        r = run([], NI_ROLE="web", VERCEL_ENV=VALUE)
        self.assertEqual(r.returncode, 64)
        self.assertIn("entrypoint: VERCEL_ENV is set.", r.stderr)

    def test_it_is_the_first_refusal(self):
        # Before development mode's: that one needs the app's node_modules.
        r = run(["web"], VERCEL="1", EVE_DEV="1")
        self.assertIn("entrypoint: VERCEL is set.", r.stderr)
        self.assertNotIn("EVE_DEV", r.stderr)

    def test_unset_or_empty_is_not_refused(self):
        for extra in ({}, {name: "" for name in NAMES}):
            with self.subTest(extra=extra):
                r = run(["web"], **extra)
                self.assertNotEqual(r.returncode, 0)  # the next check stops it: no app here
                self.assertNotIn("is set.", r.stderr)
                self.assertNotIn("earlier host", r.stderr)

    def test_the_builds_commit_is_not_one_of_them(self):
        r = run(["web"], VERCEL_GIT_COMMIT_SHA="0123456789ab")
        self.assertNotIn("is set.", r.stderr)

    def test_a_plain_command_still_runs(self):
        # As development mode's refusal: only the four roles are held.
        r = run(["sh", "-c", "echo ran"], VERCEL="1")
        self.assertEqual((r.returncode, r.stdout), (0, "ran\n"))


class OneList(unittest.TestCase):
    def test_the_entrypoint_holds_it_and_the_settings_check_copies_it(self):
        line = re.search(r'^EARLIER_HOST_VARIABLES="([A-Z0-9_ ]+)"$', read("entrypoint.sh"), re.M)
        self.assertIsNotNone(line)
        self.assertEqual(tuple(line.group(1).split()), NAMES)
        self.assertEqual(tuple(cs.MUST_BE_ABSENT), NAMES)

    def test_deploy_keeps_no_list_of_its_own(self):
        code = "\n".join(l for l in read("deploy.sh").splitlines() if not l.lstrip().startswith("#"))
        for name in NAMES:
            self.assertNotRegex(code, r"\b%s\b(?![A-Z_])" % name)

    def test_nothing_here_sets_one(self):
        # No file that gives a container its environment names one of them (comments apart).
        for name in ("compose.yaml", "Dockerfile", ".env.example", "smoke.sh", "smoke/compose.yaml", "smoke/.env.example"):
            for line in read(name).splitlines():
                if line.lstrip().startswith("#"):
                    continue
                for refused in NAMES:
                    self.assertNotRegex(line, r"(?<![A-Z_])%s(?![A-Z_])" % refused, "%s: %s" % (name, line))


DEPLOY_BLOCK = re.compile(r"^# --- the earlier host's own variables ---\n(.*?)^# --- end ---$", re.S | re.M)


class DeployRefusesBeforeAnythingRuns(unittest.TestCase):
    """deploy.sh's part, run for real: its functions, with docker replaced by a script
    that answers `compose config` with a made-up stack and `run` with an image's entrypoint."""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        d = self.dir.name
        with open(os.path.join(d, "entrypoint.sh"), "w") as f:
            f.write(read("entrypoint.sh"))
        with open(os.path.join(d, "old-entrypoint.sh"), "w") as f:
            f.write("#!/bin/sh\n# an image from before the refusal\n")
        docker = os.path.join(d, "docker")
        with open(docker, "w") as f:
            f.write('#!/bin/sh\n'
                    'case "$1" in\n'
                    '  compose) [ -f "$STUB/config.json" ] || exit 1; cat "$STUB/config.json" ;;\n'
                    '  run) for a in "$@"; do image="$a"; [ "$a" = ni-app:live ] || [ "$a" = ni-app:previous ] || [ "$a" = ni-app:gone ] && break; done\n'
                    '       case "$image" in ni-app:live) cat "$STUB/entrypoint.sh" ;; ni-app:previous) cat "$STUB/old-entrypoint.sh" ;; *) exit 125 ;; esac ;;\n'
                    'esac\n')
        os.chmod(docker, os.stat(docker).st_mode | stat.S_IXUSR)
        block = DEPLOY_BLOCK.search(read("deploy.sh"))
        self.assertIsNotNone(block)
        self.block = block.group(1)

    def stack(self, environment):
        with open(os.path.join(self.dir.name, "config.json"), "w") as f:
            json.dump({"services": {"web": {"environment": environment}}}, f)

    def sh(self, call):
        script = ('set -euo pipefail\ndie() { echo "deploy: $*" >&2; exit 1; }\ncompose() { docker compose "$@"; }\n'
                  + self.block + "\n" + call + "\necho passed\n")
        env = {"PATH": self.dir.name + os.pathsep + os.environ["PATH"], "STUB": self.dir.name}
        return subprocess.run(["bash", "-c", script], cwd=self.dir.name, env=env, capture_output=True, text=True, timeout=60)

    def test_the_checkout_and_a_new_image_name_the_list_and_an_old_image_names_none(self):
        r = self.sh('refused_by_checkout; echo "[$(refused_by_image ni-app:live)]"; echo "[$(refused_by_image ni-app:previous)]"')
        self.assertEqual(r.stdout.splitlines(), [" ".join(NAMES), "[%s]" % " ".join(NAMES), "[]", "passed"], r.stderr)

    def test_an_image_that_cannot_be_read_stops_the_roll_out(self):
        # Not taken for an image from before the refusal.
        self.stack({"VERCEL_ENV": VALUE})
        r = self.sh('refused="$(refused_by_image ni-app:gone)"; refuse_earlier_host_variables "$refused"')
        self.assertEqual(r.returncode, 1)
        self.assertIn("cannot read entrypoint.sh from the image ni-app:gone", r.stderr)
        self.assertNotIn("passed", r.stdout)

    def test_a_set_one_stops_every_mode_by_name_alone(self):
        for call in ('refused="$(refused_by_checkout)"; refuse_earlier_host_variables "$refused"',    # deploy, --build-only
                     'refused="$(refused_by_image ni-app:live)"; refuse_earlier_host_variables "$refused"'):  # --no-build, --rollback to a new image
            for name in NAMES:
                with self.subTest(call=call, name=name):
                    self.stack({"NEXT_PUBLIC_APP_URL": "https://app.example", name: VALUE, "VERCEL_GIT_COMMIT_SHA": "0123456789ab"})
                    r = self.sh(call)
                    self.assertEqual(r.returncode, 1)
                    self.assertIn("deploy: set in .env: %s. " % name, r.stderr)
                    self.assertNotIn(VALUE, r.stdout + r.stderr)
                    self.assertNotIn("passed", r.stdout)

    def test_several_are_named_together(self):
        self.stack({"VERCEL": "1", "VERCEL_ENV": VALUE, "VERCEL_URL": ""})
        r = self.sh('refused="$(refused_by_checkout)"; refuse_earlier_host_variables "$refused"')
        self.assertIn("set in .env: VERCEL VERCEL_ENV. ", r.stderr)

    def test_a_clean_file_passes(self):
        # Empty and absent (Compose gives a bare name as null) both count as unset.
        self.stack({"NEXT_PUBLIC_APP_URL": "https://app.example", "VERCEL": "", "VERCEL_ENV": None, "VERCEL_GIT_COMMIT_SHA": "0123456789ab"})
        for call in ('refused="$(refused_by_checkout)"; refuse_earlier_host_variables "$refused"', 'refused="$(refused_by_image ni-app:live)"; refuse_earlier_host_variables "$refused"'):
            r = self.sh(call)
            self.assertEqual((r.returncode, r.stdout), (0, "passed\n"), r.stderr)
        self.stack({})
        self.assertEqual(self.sh('refused="$(refused_by_checkout)"; refuse_earlier_host_variables "$refused"').returncode, 0)

    def test_going_back_to_an_image_from_before_the_refusal_is_not_held(self):
        self.stack({"VERCEL_ENV": VALUE})
        r = self.sh('refused="$(refused_by_image ni-app:previous)"; refuse_earlier_host_variables "$refused"')
        self.assertEqual((r.returncode, r.stdout), (0, "passed\n"), r.stderr)

    def test_a_file_that_cannot_be_read_stops_it(self):
        r = self.sh('refused="$(refused_by_checkout)"; refuse_earlier_host_variables "$refused"')  # no config.json: compose fails
        self.assertEqual(r.returncode, 1)
        self.assertIn("cannot read .env", r.stderr)

    def test_an_entrypoint_without_the_list_stops_a_build(self):
        with open(os.path.join(self.dir.name, "entrypoint.sh"), "w") as f:
            f.write("#!/bin/sh\n")
        r = self.sh('refused="$(refused_by_checkout)"; refuse_earlier_host_variables "$refused"')
        self.assertEqual(r.returncode, 1)
        self.assertIn("cannot read EARLIER_HOST_VARIABLES", r.stderr)

    def test_every_mode_asks_before_anything_is_built_or_replaced(self):
        deploy = read("deploy.sh")
        modes = deploy[deploy.rindex('case "$mode" in'):]
        build, no_build, rollback = (modes[modes.index(a):modes.index(b)] for a, b in
                                     (("deploy | build-only)", "\nno-build)"), ("\nno-build)", "\nrollback)"), ("\nrollback)", "\nesac")))
        check = deploy[deploy.index("check_build_settings() {"):]
        self.assertIn('\trefused="$(refused_by_checkout)"\n\trefuse_earlier_host_variables "$refused"\n', check[:check.index("\n}\n")])
        # The check it stands beside is still there.
        self.assertIn("cannot read the checkout's commit", check[:check.index("\n}\n")])
        # Never as an argument: a failure inside "$(...)" there goes unnoticed.
        self.assertNotIn('refuse_earlier_host_variables "$(', deploy)
        self.assertLess(build.index("check_build_settings"), build.index("build_web"))
        ask = '\trefused="$(refused_by_image %s)"\n\trefuse_earlier_host_variables "$refused"\n'
        self.assertLess(no_build.index(ask % "ni-app:live"), no_build.index("rollout"))
        # Before the tags move, so a refused rollback changes nothing.
        self.assertLess(rollback.index(ask % "ni-app:previous"), rollback.index("docker tag"))


if __name__ == "__main__":
    unittest.main()
