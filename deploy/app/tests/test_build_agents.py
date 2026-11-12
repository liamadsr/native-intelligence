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

    def test_both_ways_set_the_own_runtime_wins_for_the_coding_agent(self):
        # The hosted three stay in .env for the cloud browser.
        r = run(SCRIPT, "--sandbox-provider", "coding-agent", env=dict(CREDS, **RUNTIME, SANDBOX_RUNTIME_KEY=RUNTIME_KEY))
        self.assertEqual((r.returncode, r.stdout.strip()), (0, "ni-runtime"))
        self.assertNotIn(TOKEN, r.stdout + r.stderr)
        self.assertNotIn(RUNTIME_KEY, r.stdout + r.stderr)
        r = run(SCRIPT, "--sandbox-provider", "chat-agent", env=dict(CREDS, **RUNTIME))
        self.assertEqual((r.returncode, r.stdout.strip()), (0, "just-bash"))

    def test_a_partial_hosted_set_beside_the_own_runtime_is_not_the_coding_agents_error(self):
        r = run(SCRIPT, "--sandbox-provider", "coding-agent", env=dict(RUNTIME, SANDBOX_ACCESS_TOKEN=TOKEN))
        self.assertEqual((r.returncode, r.stdout.strip()), (0, "ni-runtime"))
        # Without the own runtime, it still is.
        r = run(SCRIPT, "--sandbox-provider", "coding-agent", env={"SANDBOX_ACCESS_TOKEN": TOKEN})
        self.assertEqual(r.returncode, 1)

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
        # And with the hosted three set as well (the cloud browser's).
        self.assertEqual(run(self.script, "--check-sandbox", "coding-agent", env=dict(CREDS, **RUNTIME)).returncode, 0)
        self.built("coding-agent", "vercel")
        r = run(self.script, "--check-sandbox", "coding-agent", env=dict(CREDS, **RUNTIME))
        self.assertEqual(r.returncode, 1)
        self.assertIn("call for our own runtime", r.stderr)

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


# Stands in for eve: records the SANDBOX_* settings each agent's build ran with
# (outside the app's folder), and writes what a build of the provider that environment
# calls for would write.
FAKE_EVE = r"""
const fs = require("node:fs"), path = require("node:path")
const name = path.basename(process.cwd())
// Only the names this test asks about: a failing assertion prints what was recorded.
const seen = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("SANDBOX_")))
fs.writeFileSync(path.join(process.env.NI_TEST_ENV_DIR, name + ".json"), JSON.stringify(seen))
let providerName = "just-bash", artifact = { templateKey: "tpl" }
if (name === "coding-agent" && process.env.SANDBOX_RUNTIME_API_URL) {
  providerName = "ni-runtime"; artifact = { template: process.env.SANDBOX_RUNTIME_TEMPLATE || "ni-coding-agent" }
} else if (name === "coding-agent" && process.env.SANDBOX_ACCESS_TOKEN) {
  providerName = "vercel"; artifact = { snapshotId: "snap_madeup" }
} else {
  fs.mkdirSync(".eve/sandbox-cache/just-bash/templates/tpl", { recursive: true })
}
fs.mkdirSync(".output/server", { recursive: true })
fs.writeFileSync(".output/server/index.mjs", "")
fs.mkdirSync(".output/.eve/compile", { recursive: true })
fs.writeFileSync(".output/.eve/compile/sandbox-prepared-artifacts.json", JSON.stringify({ entries: [{ nodeId: "root", providerName, artifact }] }))
console.log("built")
"""

# grep, except that the build's leak search looks in the app's folder alone (the
# real one also searches /tmp and $HOME, far too much for a test), and is logged.
GREP_SHIM = """#!/bin/sh
if [ "$1" = "-rqF" ]; then
  printf '%s\\n' "$5" >> "$NI_TEST_GREP_LOG"
  exec /usr/bin/grep -rqF -D skip -e "$5" "$6"
fi
exec /usr/bin/grep "$@"
"""


class BuildEnvironment(unittest.TestCase):
    """The build loop itself, with a stand-in for eve: what each agent's build sees."""

    def setUp(self):
        self.root = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.root, "deploy", "app"))
        self.script = os.path.join(self.root, "deploy", "app", "build-agents.sh")
        shutil.copy(SCRIPT, self.script)
        self.web = os.path.join(self.root, "web")
        for name in ("coding-agent", "chat-agent"):
            os.makedirs(os.path.join(self.web, "agents", name))
            open(os.path.join(self.web, "agents", name, "agent.ts"), "w").close()
        with open(os.path.join(self.web, "next.config.mjs"), "w") as f:
            f.write("agents: { 'coding-agent': './agents/coding-agent', 'chat-agent': './agents/chat-agent' }\n")
        eve = os.path.join(self.web, "node_modules", "eve", "bin")
        os.makedirs(eve)
        with open(os.path.join(eve, "eve.js"), "w") as f:
            f.write(FAKE_EVE)
        self.envs = os.path.join(self.root, "envs")
        os.makedirs(self.envs)
        shim = os.path.join(self.root, "bin")
        os.makedirs(shim)
        with open(os.path.join(shim, "grep"), "w") as f:
            f.write(GREP_SHIM)
        os.chmod(os.path.join(shim, "grep"), 0o755)
        self.grep_log = os.path.join(self.root, "grep.log")
        self.base = {"PATH": shim + os.pathsep + os.environ["PATH"], "HOME": self.root,
                     "NI_TEST_ENV_DIR": self.envs, "NI_TEST_GREP_LOG": self.grep_log}

    def tearDown(self):
        shutil.rmtree(self.root)

    def build(self, env):
        return run(self.script, env=dict(self.base, **env))

    def seen(self, name):
        with open(os.path.join(self.envs, name + ".json")) as f:
            return json.load(f)

    def searched(self):
        if not os.path.exists(self.grep_log):
            return []
        with open(self.grep_log) as f:
            return f.read().split()

    def test_both_sets_the_coding_agent_is_built_for_the_own_runtime_without_the_hosted_three(self):
        env = dict(CREDS, **RUNTIME, SANDBOX_RUNTIME_KEY=RUNTIME_KEY,
                   NI_CODING_AGENT_SANDBOX="vercel/team_madeup0001/prj_madeup0001", NI_CODING_AGENT_RUNTIME="runtime/ni-coding-agent")
        r = self.build(env)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("== eve build: coding-agent (sandbox: ni-runtime)", r.stdout)
        coding = self.seen("coding-agent")
        for name in NAMES + ("SANDBOX_RUNTIME_KEY",):
            self.assertNotIn(name, coding)
        self.assertEqual(coding["SANDBOX_RUNTIME_API_URL"], RUNTIME["SANDBOX_RUNTIME_API_URL"])
        chat = self.seen("chat-agent")
        for name in NAMES + RUNTIME_NAMES:
            self.assertNotIn(name, chat)
        # The leak searches still ran, for the hosted token and for the key.
        self.assertIn(TOKEN, self.searched())
        self.assertIn(RUNTIME_KEY, self.searched())
        self.assertNotIn(TOKEN, r.stdout + r.stderr)
        self.assertNotIn(RUNTIME_KEY, r.stdout + r.stderr)

    def test_hosted_alone_still_gives_the_coding_agent_the_three(self):
        r = self.build(dict(CREDS, NI_CODING_AGENT_SANDBOX="vercel/team_madeup0001/prj_madeup0001"))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("== eve build: coding-agent (sandbox: vercel)", r.stdout)
        self.assertEqual(self.seen("coding-agent")["SANDBOX_ACCESS_TOKEN"], TOKEN)
        self.assertNotIn("SANDBOX_ACCESS_TOKEN", self.seen("chat-agent"))
        self.assertIn(TOKEN, self.searched())

    def test_the_cross_check_follows_the_chosen_provider(self):
        # Meant for the own runtime, but its addresses did not arrive: the hosted one would be built.
        r = self.build(dict(CREDS, NI_CODING_AGENT_SANDBOX="vercel/team_madeup0001/prj_madeup0001", NI_CODING_AGENT_RUNTIME="runtime/ni-coding-agent"))
        self.assertEqual(r.returncode, 1)
        self.assertIn("meant to give coding-agent the runtime/ni-coding-agent sandbox", r.stderr)
        # Another template than meant.
        r = self.build(dict(RUNTIME, SANDBOX_RUNTIME_TEMPLATE="other", NI_CODING_AGENT_RUNTIME="runtime/ni-coding-agent"))
        self.assertEqual(r.returncode, 1)

    def test_a_hosted_token_that_turns_up_in_the_app_stops_the_build(self):
        with open(os.path.join(self.web, "agents", "chat-agent", "leak.txt"), "w") as f:
            f.write(TOKEN)
        r = self.build(dict(CREDS, **RUNTIME))
        self.assertEqual(r.returncode, 1)
        self.assertIn("SANDBOX_ACCESS_TOKEN turned up", r.stderr)


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
        for name in ("SANDBOX_RUNTIME_API_URL", "SANDBOX_RUNTIME_TRAFFIC_URL", "SANDBOX_RUNTIME_TEMPLATE", "NI_CODING_AGENT_RUNTIME"):
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
            "NI_CODING_AGENT_SANDBOX: ${SANDBOX_ACCESS_TOKEN:+vercel/${SANDBOX_TEAM_ID:-}/${SANDBOX_PROJECT_ID:-}}\n", args)
        self.assertIn("NI_CODING_AGENT_RUNTIME: ${SANDBOX_RUNTIME_API_URL:+runtime/${SANDBOX_RUNTIME_TEMPLATE:-ni-coding-agent}}\n", args)
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
        self.assertEqual(build["args"]["NI_CODING_AGENT_RUNTIME"], "runtime/ni-coding-agent")
        self.assertEqual(build["args"]["NI_CODING_AGENT_SANDBOX"], "")
        args = self.config(dict(RUNTIME, SANDBOX_RUNTIME_TEMPLATE="my-template"))["services"]["web"]["build"]["args"]
        self.assertEqual(args["NI_CODING_AGENT_RUNTIME"], "runtime/my-template")
        self.assertEqual(args["SANDBOX_RUNTIME_TEMPLATE"], "my-template")

    def test_both_sets_the_runtime_argument_names_the_own_runtime_and_the_hosted_three_still_reach_their_readers(self):
        services = self.config(dict(CREDS, **RUNTIME, SANDBOX_RUNTIME_KEY=RUNTIME_KEY))["services"]
        args = services["web"]["build"]["args"]
        self.assertEqual(args["NI_CODING_AGENT_RUNTIME"], "runtime/ni-coding-agent")
        self.assertEqual(args["NI_CODING_AGENT_SANDBOX"], "vercel/team_madeup0001/prj_madeup0001")
        for name in ("web", "worker", "agent-coding-agent"):
            self.assertEqual(services[name]["environment"]["SANDBOX_ACCESS_TOKEN"], TOKEN, name)
        self.assertEqual(services["agent-coding-agent"]["environment"]["SANDBOX_RUNTIME_KEY"], RUNTIME_KEY)
        self.assertEqual(services["web"]["environment"]["SANDBOX_RUNTIME_KEY"], "")


if __name__ == "__main__":
    unittest.main()
