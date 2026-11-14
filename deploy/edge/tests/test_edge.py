"""The edge's cloud browser block (deploy/edge/Caddyfile, the last block, and
compose.yaml): an opt-in that does nothing until its two settings are set, that
reaches one port of one sandbox only, and that leaves every other site as it was.

    python3 -m unittest discover -s deploy/edge/tests

The Caddyfile is read as text here. With `caddy` on the PATH (2.11, as the
edge runs), it is also adapted to JSON and the result looked at; without it,
those tests are skipped. With `docker` (no daemon needed), compose.yaml is
rendered with and without the settings.
"""
import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

EDGE = Path(__file__).resolve().parents[1]
CADDYFILE = (EDGE / "Caddyfile").read_text()


def blocks(text):
    """The top-level blocks of a Caddyfile: (the line that opens it, its body)."""
    found, depth, head, body = [], 0, None, []
    for line in text.splitlines():
        stripped = line.split("#", 1)[0].strip() if not line.lstrip().startswith("#") else ""
        if depth == 0 and stripped.endswith("{"):
            head, body = stripped[:-1].strip(), []
        elif depth > 0:
            body.append(line)
        depth += stripped.count("{") - stripped.count("}") if stripped and not stripped.startswith("regexp") else 0
        if depth == 0 and head is not None:
            found.append((head, "\n".join(body)))
            head = None
    return found


class TheCaddyfile(unittest.TestCase):
    def setUp(self):
        self.blocks = dict(blocks(CADDYFILE))
        self.hub = self.blocks["https://*.{$CLOUD_BROWSER_HUB_DOMAIN:cloud-browser.invalid}"]

    def test_the_ask_is_global_and_points_at_the_apps_proxy(self):
        globals_ = self.blocks[""]
        self.assertIn("on_demand_tls {", globals_)
        self.assertIn("ask http://ni-app-proxy:8080/api/internal/cloud-browser/tls-ask", globals_)
        # Not the deprecated rate limits.
        self.assertNotRegex(globals_, r"\n\s*(interval|burst)\s")

    def test_on_demand_is_the_browsers_block_alone(self):
        self.assertEqual(CADDYFILE.count("on_demand\n"), 1)
        self.assertIn("tls {\n\t\ton_demand\n\t}", self.hub)
        for head, body in self.blocks.items():
            if head != "https://*.{$CLOUD_BROWSER_HUB_DOMAIN:cloud-browser.invalid}":
                self.assertNotIn("on_demand\n", body, head)

    def test_the_default_is_a_name_no_request_carries(self):
        self.assertIn("{$CLOUD_BROWSER_HUB_DOMAIN:cloud-browser.invalid}", CADDYFILE)
        self.assertIn("{$CLOUD_BROWSER_TRAFFIC_UPSTREAM:127.0.0.1:9}", self.hub)

    def test_only_port_4000_of_the_sandbox_the_certificate_names(self):
        matcher = re.search(r"@hub vars_regexp hub \{http\.request\.tls\.server_name\} (\S+)", self.hub).group(1)
        self.assertEqual(matcher, r"^([a-z0-9]{20})\.{$CLOUD_BROWSER_HUB_DOMAIN:cloud-browser.invalid}$")
        pattern = re.compile(matcher.replace("{$CLOUD_BROWSER_HUB_DOMAIN:cloud-browser.invalid}", re.escape("browsers.example.com")))
        self.assertEqual(pattern.match("abcdefghij0123456789.browsers.example.com").group(1), "abcdefghij0123456789")
        for refused in ("abcdefghij0123456789.other.example.com", "ABCDEFGHIJ0123456789.browsers.example.com", "short.browsers.example.com",
                        "4000-abcdefghij0123456789.browsers.example.com", "a.abcdefghij0123456789.browsers.example.com", ""):
            self.assertIsNone(pattern.match(refused), refused)
        for line in ("header_up Host {upstream_hostport}", "header_up E2b-Sandbox-Id {re.hub.1}", "header_up E2b-Sandbox-Port 4000",
                     "header_up X-Real-IP {remote_host}", "header_up -E2b-Traffic-Access-Token"):
            self.assertIn(line, self.hub)
        # Everything else is answered here.
        self.assertRegex(self.hub, r"handle \{\n\t\trespond 404\n\t\}")

    def test_the_routing_is_the_clients_own(self):
        # What the runtime's clients send to the traffic port when it is given (sandboxUrl):
        # the same two headers (web/node_modules/e2b, ConnectionConfig + SandboxApi).
        js = Path(EDGE.parents[1], "web", "node_modules", "e2b", "dist", "index.js")
        if not js.exists():
            self.skipTest("web/node_modules not installed")
        text = js.read_text()
        self.assertIn('"E2b-Sandbox-Id": this.sandboxId', text)
        self.assertIn('"E2b-Sandbox-Port": this.envdPort.toString()', text)

    def test_quiet_websockets_are_not_cut(self):
        transport = re.search(r"transport http \{([^}]*)\}", self.hub).group(1)
        self.assertNotIn("read_timeout", transport)
        self.assertNotIn("write_timeout", transport)
        self.assertNotIn("import proxy", self.hub)
        self.assertIn("flush_interval -1", self.hub)
        self.assertIn("stream_close_delay", self.hub)

    def test_the_question_is_not_a_public_page(self):
        app = self.blocks["{$APP_HOSTS:http://app.invalid}"]
        self.assertIn("respond /api/internal/cloud-browser/tls-ask* 404", app)

    def test_the_other_sites_are_where_they_were(self):
        for head in ("{$INNGEST_HOST:inngest.nativeintelligence.dev}", "{$SUPABASE_HOST:sb.nativeintelligence.dev}",
                     "{$APP_HOSTS:http://app.invalid}", "{$LIVEKIT_HOST:http://livekit.invalid}"):
            self.assertIn(head, self.blocks)
            # No tls directive of their own: ordinary automatic certificates, as before.
            self.assertNotRegex(self.blocks[head], r"(?m)^\s*tls\b")
        # The global options, the proxy snippet, the four sites as before, and the browsers.
        self.assertEqual(len(self.blocks), 7, list(self.blocks))


@unittest.skipUnless(shutil.which("caddy"), "needs caddy on the PATH (2.11, as the edge runs)")
class CaddyItself(unittest.TestCase):
    def adapt(self, env):
        with tempfile.TemporaryDirectory() as folder:
            shutil.copy(EDGE / "Caddyfile", folder)
            base = {"PATH": os.environ["PATH"], "SUPABASE_UPSTREAM": "https://made-up.example.com", "HOME": folder}
            done = subprocess.run(["caddy", "adapt", "--config", os.path.join(folder, "Caddyfile")], env=dict(base, **env),
                                  capture_output=True, text=True)
            self.assertEqual(done.returncode, 0, done.stderr)
            return json.loads(done.stdout)

    def test_it_adapts_with_and_without_the_settings(self):
        for env in ({}, {"CLOUD_BROWSER_HUB_DOMAIN": "browsers.example.com", "CLOUD_BROWSER_TRAFFIC_UPSTREAM": "10.200.77.2:3002"}):
            config = self.adapt(env)
            tls = config["apps"]["tls"]
            self.assertEqual(tls["automation"]["on_demand"]["permission"]["endpoint"],
                             "http://ni-app-proxy:8080/api/internal/cloud-browser/tls-ask")
            on_demand = [p for p in tls["automation"]["policies"] if p.get("on_demand")]
            self.assertEqual(len(on_demand), 1)
            self.assertEqual(len(on_demand[0]["subjects"]), 1)
            self.assertTrue(on_demand[0]["subjects"][0].startswith("*."))


@unittest.skipUnless(shutil.which("docker"), "needs docker compose (no daemon)")
class TheCompose(unittest.TestCase):
    def config(self, env):
        with tempfile.TemporaryDirectory() as folder:
            shutil.copy(EDGE / "compose.yaml", folder)
            with open(os.path.join(folder, ".env"), "w") as f:
                f.write("SUPABASE_UPSTREAM=https://made-up.example.com\n")
                f.writelines("%s=%s\n" % kv for kv in env.items())
            clean = {k: v for k, v in os.environ.items() if not k.startswith("CLOUD_BROWSER_")}
            done = subprocess.run(["docker", "compose", "config", "--format", "json"], cwd=folder, env=clean,
                                  capture_output=True, text=True, check=True)
            return json.loads(done.stdout)["services"]["caddy"]["environment"]

    def test_unset_is_never_empty(self):
        env = self.config({})
        self.assertEqual(env["CLOUD_BROWSER_HUB_DOMAIN"], "cloud-browser.invalid")
        self.assertEqual(env["CLOUD_BROWSER_TRAFFIC_UPSTREAM"], "127.0.0.1:9")
        env = self.config({"CLOUD_BROWSER_HUB_DOMAIN": "", "CLOUD_BROWSER_TRAFFIC_UPSTREAM": ""})
        self.assertEqual(env["CLOUD_BROWSER_HUB_DOMAIN"], "cloud-browser.invalid")

    def test_set_is_passed_on(self):
        env = self.config({"CLOUD_BROWSER_HUB_DOMAIN": "browsers.example.com", "CLOUD_BROWSER_TRAFFIC_UPSTREAM": "10.200.77.2:3002"})
        self.assertEqual((env["CLOUD_BROWSER_HUB_DOMAIN"], env["CLOUD_BROWSER_TRAFFIC_UPSTREAM"]), ("browsers.example.com", "10.200.77.2:3002"))

    def test_the_edge_example_names_both(self):
        example = (EDGE / ".env.example").read_text()
        self.assertIn("#CLOUD_BROWSER_HUB_DOMAIN=", example)
        self.assertIn("#CLOUD_BROWSER_TRAFFIC_UPSTREAM=", example)


if __name__ == "__main__":
    unittest.main()
