"""Tests for entrypoint.sh's refusal of the earlier host's own variables:
python3 -m unittest discover -s deploy/app/tests

The entrypoint is run with sh, outside the image: a role that gets past the refusal
stops at the next check (there is no /app here), which is how "not refused" shows.
Every value here is made up.
"""
import os
import re
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
import check_settings as cs  # noqa: E402

ENTRYPOINT = os.path.join(HERE, "entrypoint.sh")
NAMES = ("VERCEL", "VERCEL_ENV", "VERCEL_TARGET_ENV", "VERCEL_PROJECT_ID", "VERCEL_TEAM_ID")
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


class OneListInThreePlaces(unittest.TestCase):
    def test_entrypoint_deploy_and_the_settings_check_name_the_same_variables(self):
        entrypoint = re.search(r'^EARLIER_HOST_VARIABLES="([A-Z_ ]+)"$', read("entrypoint.sh"), re.M)
        deploy = re.search(r"^\tfor name in ((?:VERCEL[A-Z_]* ?)+); do$", read("deploy.sh"), re.M)
        self.assertIsNotNone(entrypoint)
        self.assertIsNotNone(deploy)
        self.assertEqual(tuple(entrypoint.group(1).split()), NAMES)
        self.assertEqual(tuple(deploy.group(1).split()), NAMES)
        self.assertEqual(tuple(cs.MUST_BE_ABSENT), NAMES)

    def test_deploy_refuses_them_before_it_builds_and_never_prints_the_value(self):
        deploy = read("deploy.sh")
        check = deploy[deploy.index("check_build_settings() {"):]
        check = check[:check.index("\n}\n")]
        self.assertIn('[ -z "$(setting "$name")" ] ||', check)
        self.assertIn("Remove the line.", check)
        self.assertLess(deploy.index("\tcheck_build_settings\n"), deploy.index("\tbuild_web\n"))

    def test_nothing_here_sets_one(self):
        # compose.yaml and the image hand no container any of them.
        for name in ("compose.yaml", "Dockerfile", ".env.example"):
            for line in read(name).splitlines():
                if line.lstrip().startswith("#"):
                    continue
                self.assertNotRegex(line, r"\bVERCEL(_ENV|_TARGET_ENV|_PROJECT_ID|_TEAM_ID)?\b(?!_)\s*[:=]")


if __name__ == "__main__":
    unittest.main()
