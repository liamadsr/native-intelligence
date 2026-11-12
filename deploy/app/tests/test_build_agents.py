"""Tests for build-agents.sh's sandbox choice, and for how the hosted sandbox
service's credentials (and our own runtime's settings) reach the image build:
python3 -m unittest discover -s deploy/app/tests

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
# Our own runtime (the coding agent's third way). The key is made up too.
RUNTIME_NAMES = ("SANDBOX_RUNTIME_API_URL", "SANDBOX_RUNTIME_TRAFFIC_URL", "SANDBOX_RUNTIME_TEMPLATE", "SANDBOX_RUNTIME_KEY")
RUNTIME_KEY = "e2b_" + "0123456789abcdef" * 2
RUNTIME = {"SANDBOX_RUNTIME_API_URL": "http://10.200.77.2:3000", "SANDBOX_RUNTIME_TRAFFIC_URL": "http://10.200.77.2:3002"}


def run(script, *args, env=None):
    base = {k: v for k, v in os.environ.items() if k not in NAMES + RUNTIME_NAMES and k != "NI_SANDBOX_PROVIDER"}
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

    def test_both_runtime_addresses_the_coding_agent_alone_is_on_our_own_runtime_without_a_key(self):
        r = run(SCRIPT, "--sandbox-provider", "coding-agent", env=RUNTIME)
        self.assertEqual((r.returncode, r.stdout.strip()), (0, "ni-runtime"))
        r = run(SCRIPT, "--sandbox-provider", "chat-agent", env=RUNTIME)
        self.assertEqual((r.returncode, r.stdout.strip()), (0, "just-bash"))
        # The key, or the template alone, chooses nothing.
        r = run(SCRIPT, "--sandbox-provider", "coding-agent", env={"SANDBOX_RUNTIME_KEY": RUNTIME_KEY, "SANDBOX_RUNTIME_TEMPLATE": "x"})
        self.assertEqual((r.returncode, r.stdout.strip()), (0, "just-bash"))
        r = run(SCRIPT, "--sandbox-provider", "coding-agent", env={n: " \n" for n in RUNTIME})
        self.assertEqual((r.returncode, r.stdout.strip()), (0, "just-bash"))

    def test_one_runtime_address_is_an_error_that_names_the_other(self):
        r = run(SCRIPT, "--sandbox-provider", "coding-agent", env={"SANDBOX_RUNTIME_API_URL": RUNTIME["SANDBOX_RUNTIME_API_URL"]})
        self.assertEqual(r.returncode, 1)
        self.assertIn("missing: SANDBOX_RUNTIME_TRAFFIC_URL", r.stderr)

    def test_both_ways_at_once_is_an_error_that_names_both_and_shows_no_value(self):
        r = run(SCRIPT, "--sandbox-provider", "coding-agent", env=dict(CREDS, **RUNTIME, SANDBOX_RUNTIME_KEY=RUNTIME_KEY))
        self.assertEqual(r.returncode, 1)
        self.assertIn("SANDBOX_ACCESS_TOKEN SANDBOX_TEAM_ID SANDBOX_PROJECT_ID", r.stderr)
        self.assertIn("SANDBOX_RUNTIME_API_URL SANDBOX_RUNTIME_TRAFFIC_URL", r.stderr)
        self.assertNotIn(TOKEN, r.stdout + r.stderr)
        self.assertNotIn(RUNTIME_KEY, r.stdout + r.stderr)

    def test_state_dirs_keep_the_just_bash_sessions_folder_whatever_the_sandbox(self):
        plain = run(SCRIPT, "--state-dirs").stdout
        for env in (RUNTIME, CREDS):
            self.assertEqual(run(SCRIPT, "--state-dirs", env=env).stdout, plain)
        self.assertIn("/agents/coding-agent/.eve/sandbox-cache/just-bash/sessions\n", plain)


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
        artifact = {"snapshotId": "snap_madeup"} if provider == "vercel" else {"template": "ni-coding-agent"} if provider == "ni-runtime" else {"templateKey": "tpl"}
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

    def test_our_own_runtime_built_and_set_starts_without_the_key(self):
        self.built("coding-agent", "ni-runtime")
        self.assertEqual(run(self.script, "--check-sandbox", "coding-agent", env=RUNTIME).returncode, 0)

    def test_runtime_settings_set_but_built_without_them_refuses_and_says_rebuild(self):
        self.built("coding-agent", "just-bash")
        r = run(self.script, "--check-sandbox", "coding-agent", env=dict(RUNTIME, SANDBOX_RUNTIME_KEY=RUNTIME_KEY))
        self.assertEqual(r.returncode, 1)
        self.assertIn("call for our own runtime", r.stderr)
        self.assertNotIn(RUNTIME_KEY, r.stdout + r.stderr)

    def test_built_on_our_own_runtime_but_settings_gone_refuses(self):
        self.built("coding-agent", "ni-runtime")
        r = run(self.script, "--check-sandbox", "coding-agent")
        self.assertEqual(r.returncode, 1)
        self.assertIn("SANDBOX_RUNTIME_API_URL SANDBOX_RUNTIME_TRAFFIC_URL", r.stderr)
        self.assertIn("they are not set here", r.stderr)
        r = run(self.script, "--check-sandbox", "coding-agent", env=CREDS)
        self.assertEqual(r.returncode, 1)

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
        # The runtime's key is in no instruction at all; its addresses and template are arguments.
        self.assertFalse(any("SANDBOX_RUNTIME_KEY" in i for i in instructions))
        for name in ("SANDBOX_RUNTIME_API_URL", "SANDBOX_RUNTIME_TRAFFIC_URL", "SANDBOX_RUNTIME_TEMPLATE"):
            self.assertIn("ARG %s=" % name, instructions)
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
        # The one argument that mentions the token yields a word and the two ids,
        # never the token's value (and, for our own runtime, a word and the template).
        self.assertIn(
            "NI_CODING_AGENT_SANDBOX: ${SANDBOX_ACCESS_TOKEN:+vercel/${SANDBOX_TEAM_ID:-}/${SANDBOX_PROJECT_ID:-}}"
            "${SANDBOX_RUNTIME_API_URL:+runtime/${SANDBOX_RUNTIME_TEMPLATE:-ni-coding-agent}}\n", args)
        self.assertEqual(len(re.findall(r"SANDBOX_ACCESS_TOKEN", args)), 1)
        self.assertNotIn("SANDBOX_RUNTIME_KEY", args)
        for name in NAMES:
            self.assertIn("  %s:\n    environment: %s\n" % (name, name), compose)
            self.assertIn("        - %s\n" % name, compose)

    def test_deploy_gives_them_to_the_build_command_alone(self):
        deploy = read("deploy.sh")
        self.assertNotIn("--build-arg", deploy)
        self.assertNotRegex(deploy, r"export[^\n]*SANDBOX_")
        self.assertIn(
            'SANDBOX_ACCESS_TOKEN="$token" SANDBOX_TEAM_ID="$team" SANDBOX_PROJECT_ID="$project" \\\n'
            '\t\tNI_APP_COMMIT="$commit" compose build web\n', deploy)
        self.assertEqual(deploy.count("compose build"), 1)
        # The runtime's key is read nowhere here (only a comment names it).
        code = [l for l in deploy.splitlines() if not l.lstrip().startswith("#")]
        self.assertFalse(any("SANDBOX_RUNTIME_KEY" in l for l in code))


@unittest.skipUnless(shutil.which("docker"), "needs docker compose (no daemon)")
class ComposeGivesThemOnlyToTheirReaders(unittest.TestCase):
    """docker compose config, with a made-up .env: who gets the three at run time."""

    READERS = {"web", "worker", "agent-coding-agent"}

    def config(self, env):
        d = tempfile.mkdtemp()
        try:
            shutil.copy(os.path.join(APP, "compose.yaml"), d)
            with open(os.path.join(d, ".env"), "w") as f:
                f.write("NEXT_PUBLIC_APP_URL=https://app.example.com\n")
                f.writelines("%s=%s\n" % kv for kv in env.items())
            clean = {k: v for k, v in os.environ.items() if k not in NAMES + RUNTIME_NAMES and k != "NI_CODING_AGENT_SANDBOX"}
            out = subprocess.run(["docker", "compose", "config", "--format", "json"], cwd=d, env=clean,
                                 capture_output=True, text=True, check=True).stdout
            return json.loads(out)
        finally:
            shutil.rmtree(d)

    def test_readers_keep_them_everyone_else_gets_them_blank(self):
        services = self.config(CREDS)["services"]
        self.assertTrue(self.READERS <= set(services))
        for name, service in services.items():
            if name == "proxy":
                self.assertNotIn("environment", service)
                continue
            env = service.get("environment", {})
            for key in NAMES:
                self.assertEqual(env.get(key), CREDS[key] if name in self.READERS else "", (name, key))

    def test_the_build_argument_carries_the_ids_and_never_the_token(self):
        args = self.config(CREDS)["services"]["web"]["build"]["args"]
        self.assertEqual(args["NI_CODING_AGENT_SANDBOX"], "vercel/team_madeup0001/prj_madeup0001")
        self.assertNotIn(TOKEN, json.dumps(args))
        self.assertEqual(self.config({n: "" for n in NAMES})["services"]["web"]["build"]["args"]["NI_CODING_AGENT_SANDBOX"], "")

    def test_our_own_runtime_key_reaches_the_coding_agent_alone_and_never_the_build(self):
        services = self.config(dict(RUNTIME, SANDBOX_RUNTIME_KEY=RUNTIME_KEY))["services"]
        for name, service in services.items():
            if name == "proxy":
                continue
            env = service.get("environment", {})
            self.assertEqual(env.get("SANDBOX_RUNTIME_KEY"), RUNTIME_KEY if name == "agent-coding-agent" else "", name)
        build = services["web"]["build"]
        self.assertNotIn(RUNTIME_KEY, json.dumps(build))
        self.assertEqual(build["args"]["SANDBOX_RUNTIME_API_URL"], RUNTIME["SANDBOX_RUNTIME_API_URL"])
        self.assertEqual(build["args"]["SANDBOX_RUNTIME_TRAFFIC_URL"], RUNTIME["SANDBOX_RUNTIME_TRAFFIC_URL"])
        self.assertEqual(build["args"]["NI_CODING_AGENT_SANDBOX"], "runtime/ni-coding-agent")
        args = self.config(dict(RUNTIME, SANDBOX_RUNTIME_TEMPLATE="my-template"))["services"]["web"]["build"]["args"]
        self.assertEqual(args["NI_CODING_AGENT_SANDBOX"], "runtime/my-template")
        self.assertEqual(args["SANDBOX_RUNTIME_TEMPLATE"], "my-template")


if __name__ == "__main__":
    unittest.main()
