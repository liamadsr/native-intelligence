"""Tests for build-agents.sh's sandbox choice, and for how the hosted sandbox
service's credentials reach the image build: python3 -m unittest discover -s deploy/app/tests

Every token and id here is made up. Needs sh and node (as the image has).
"""
import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(APP, "build-agents.sh")
NAMES = ("SANDBOX_ACCESS_TOKEN", "SANDBOX_TEAM_ID", "SANDBOX_PROJECT_ID")
TOKEN = "madeup_access_token_0123456789"
CREDS = {"SANDBOX_ACCESS_TOKEN": TOKEN, "SANDBOX_TEAM_ID": "team_madeup0001", "SANDBOX_PROJECT_ID": "prj_madeup0001"}


def run(script, *args, env=None):
    base = {k: v for k, v in os.environ.items() if k not in NAMES and k != "NI_SANDBOX_PROVIDER"}
    base.update(env or {})
    return subprocess.run(["sh", script, *args], env=base, capture_output=True, text=True)


class SandboxProvider(unittest.TestCase):
    """The repository's own script and agent list."""

    def test_no_credentials_every_agent_is_just_bash(self):
        names = run(SCRIPT, "--list").stdout.split()
        self.assertIn("coding-agent", names)
        for name in names:
            r = run(SCRIPT, "--sandbox-provider", name)
            self.assertEqual((r.returncode, r.stdout.strip()), (0, "just-bash"), name)

    def test_blank_credentials_count_as_unset(self):
        r = run(SCRIPT, "--sandbox-provider", "coding-agent", env={n: " \n" for n in NAMES})
        self.assertEqual((r.returncode, r.stdout.strip()), (0, "just-bash"))

    def test_all_three_the_coding_agent_alone_is_hosted(self):
        r = run(SCRIPT, "--sandbox-provider", "coding-agent", env=CREDS)
        self.assertEqual((r.returncode, r.stdout.strip()), (0, "vercel"))
        r = run(SCRIPT, "--sandbox-provider", "chat-agent", env=CREDS)
        self.assertEqual((r.returncode, r.stdout.strip()), (0, "just-bash"))

    def test_some_of_the_three_is_an_error_that_names_them_and_shows_no_value(self):
        r = run(SCRIPT, "--sandbox-provider", "coding-agent", env={"SANDBOX_ACCESS_TOKEN": TOKEN})
        self.assertEqual(r.returncode, 1)
        self.assertIn("missing: SANDBOX_TEAM_ID SANDBOX_PROJECT_ID", r.stderr)
        self.assertNotIn(TOKEN, r.stdout + r.stderr)

    def test_an_unknown_agent_is_refused(self):
        self.assertEqual(run(SCRIPT, "--sandbox-provider", "no-such-agent").returncode, 64)


class CheckSandbox(unittest.TestCase):
    """--check-sandbox, as entrypoint.sh runs it, against a made-up built agent."""

    def setUp(self):
        self.root = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.root, "deploy", "app"))
        self.script = os.path.join(self.root, "deploy", "app", "build-agents.sh")
        shutil.copy(SCRIPT, self.script)
        web = os.path.join(self.root, "web")
        os.makedirs(web)
        with open(os.path.join(web, "next.config.mjs"), "w") as f:
            f.write("agents: { 'coding-agent': './agents/coding-agent', 'chat-agent': './agents/chat-agent' }\n")
        self.web = web

    def tearDown(self):
        shutil.rmtree(self.root)

    def built(self, name, provider):
        compile_dir = os.path.join(self.web, "agents", name, ".output", ".eve", "compile")
        os.makedirs(compile_dir, exist_ok=True)
        artifact = {"snapshotId": "snap_madeup"} if provider == "vercel" else {"templateKey": "tpl"}
        with open(os.path.join(compile_dir, "sandbox-prepared-artifacts.json"), "w") as f:
            json.dump({"entries": [{"nodeId": "root", "providerName": provider, "artifact": artifact}]}, f)

    def test_agreeing_build_and_settings_start(self):
        self.built("coding-agent", "vercel")
        self.assertEqual(run(self.script, "--check-sandbox", "coding-agent", env=CREDS).returncode, 0)
        self.built("coding-agent", "just-bash")
        self.assertEqual(run(self.script, "--check-sandbox", "coding-agent").returncode, 0)
        self.built("chat-agent", "just-bash")
        self.assertEqual(run(self.script, "--check-sandbox", "chat-agent", env=CREDS).returncode, 0)

    def test_settings_set_but_built_without_them_refuses_and_says_rebuild(self):
        self.built("coding-agent", "just-bash")
        r = run(self.script, "--check-sandbox", "coding-agent", env=CREDS)
        self.assertEqual(r.returncode, 1)
        self.assertIn("Build the image again", r.stderr)
        self.assertNotIn(TOKEN, r.stdout + r.stderr)

    def test_built_hosted_but_settings_gone_refuses(self):
        self.built("coding-agent", "vercel")
        r = run(self.script, "--check-sandbox", "coding-agent")
        self.assertEqual(r.returncode, 1)
        self.assertIn("they are not set here", r.stderr)

    def test_no_record_of_the_build_refuses(self):
        os.makedirs(os.path.join(self.web, "agents", "coding-agent"))
        self.assertEqual(run(self.script, "--check-sandbox", "coding-agent").returncode, 1)


def read(name):
    with open(os.path.join(APP, name)) as f:
        return f.read()


class SecretsNeverInALayer(unittest.TestCase):
    """The three settings reach the build only as BuildKit secret mounts."""

    def test_dockerfile_mentions_them_only_as_secret_mounts_of_the_agents_build(self):
        dockerfile = read("Dockerfile")
        # Joined continuation lines: one instruction per entry.
        instructions = re.sub(r"\\\n\s*", " ", "\n".join(l for l in dockerfile.splitlines() if not l.lstrip().startswith("#"))).splitlines()
        mentioning = [i for i in instructions if any(n in i for n in NAMES)]
        self.assertEqual(len(mentioning), 1, mentioning)
        step = mentioning[0]
        self.assertTrue(step.startswith("RUN "), step)
        self.assertTrue(step.rstrip().endswith("/app/deploy/app/build-agents.sh"), step)
        for name in NAMES:
            mount = "--mount=type=secret,id=%s,env=%s" % (name, name)
            self.assertIn(mount, step)
            # Every mention of the name is inside its mount.
            self.assertEqual(step.count(name), 2, step)
        for instruction in instructions:
            word = instruction.split(" ", 1)[0].upper()
            if word in ("ARG", "ENV", "LABEL", "COPY", "ADD"):
                self.assertFalse(any(n in instruction for n in NAMES), instruction)

    def test_compose_passes_them_as_build_secrets_never_as_arguments(self):
        compose = read("compose.yaml")
        args = compose.split("      args:\n", 1)[1].split("      secrets:\n", 1)[0]
        # The one argument that mentions the token yields a word, never its value.
        self.assertEqual(re.findall(r"\$\{[^}]*SANDBOX_[^}]*\}", args), ["${SANDBOX_ACCESS_TOKEN:+vercel}"])
        for name in NAMES:
            self.assertIn("  %s:\n    environment: %s\n" % (name, name), compose)
            self.assertIn("        - %s\n" % name, compose)

    def test_deploy_never_gives_them_as_build_arguments(self):
        deploy = read("deploy.sh")
        self.assertNotIn("--build-arg", deploy)
        self.assertIn("export_build_secrets\n\tNI_APP_COMMIT=\"$commit\" compose build web", deploy)


if __name__ == "__main__":
    unittest.main()
