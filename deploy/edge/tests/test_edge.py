"""The edge's cloud browser block (deploy/edge/Caddyfile, the last block, and
compose.yaml): an opt-in that does nothing until its two settings are set, that
reaches one port of one sandbox only, and that leaves every other site as it was;
and the TURN name's certificate block and EDGE_PUBLIC_IP (TURN over TLS on 443),
which change nothing until set.

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
        matcher = re.search(r"@hub \{\n(.*?)\n\t\}", self.hub, re.S).group(1).splitlines()
        matcher = [line.strip() for line in matcher]
        # The server name must be the Host itself; the Host is this site's (one label under the domain, dots literal).
        self.assertIn("vars {http.request.tls.server_name} {http.request.host}", matcher)
        regexp = next(line for line in matcher if line.startswith("vars_regexp hub {http.request.tls.server_name} "))
        pattern_text = regexp.split(" ", 3)[3]
        # As Caddy sees it: no {$...} inside a regular expression (Caddy puts the value in as written).
        self.assertNotIn("{$", pattern_text)
        pattern = re.compile(pattern_text)
        # The runtime's ids as they are today: an "i" and twenty characters (21). A
        # pattern for exactly 20 refused every request of the first real browser.
        for name in ("iaovfvgjaesr1ebz1czih", "abcdefghij0123456789"):
            self.assertEqual(pattern.match(f"{name}.browsers.example.com").group(1), name)
        for refused in ("ABCDEFGHIJ0123456789.browsers.example.com", "short.browsers.example.com",
                        "4000-abcdefghij0123456789.browsers.example.com", "abcdefghij_123456789.browsers.example.com",
                        "a" * 41 + ".browsers.example.com", ""):
            self.assertIsNone(pattern.match(refused), refused)
        for line in ("header_up Host {upstream_hostport}", "header_up E2b-Sandbox-Id {re.hub.1}", "header_up E2b-Sandbox-Port 4000",
                     "header_up X-Real-IP {remote_host}", "header_up -E2b-Traffic-Access-Token"):
            self.assertIn(line, self.hub)
        # Everything else is answered here.
        self.assertRegex(self.hub, r"handle \{\n\t\trespond 404\n\t\}")

    def test_no_regular_expression_anywhere_holds_an_environment_value(self):
        for line in CADDYFILE.splitlines():
            if re.search(r"\b(header_regexp|vars_regexp|path_regexp|regexp)\b", line):
                self.assertNotIn("{$", line, line)

    def test_the_site_is_one_label_under_the_domain(self):
        # Caddy's host matcher takes "*." as exactly one label, and the rest of the name as written.
        self.assertIn("https://*.{$CLOUD_BROWSER_HUB_DOMAIN:cloud-browser.invalid}", self.blocks)

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
        # The global options, the proxy snippet, the four sites as before, TURN's name and the browsers.
        self.assertEqual(len(self.blocks), 8, list(self.blocks))


class TheTurnName(unittest.TestCase):
    """LiveKit's TURN name: Caddy keeps its certificate, in the one folder
    ../livekit/compose.turn.yaml mounts, and serves nothing for it."""

    def setUp(self):
        self.block = dict(blocks(CADDYFILE))["{$LIVEKIT_TURN_HOST:http://turn.invalid}"]

    def test_unset_is_a_name_no_request_carries_over_plain_http(self):
        # An http:// site: Caddy manages no certificate for it, whatever its tls block says.
        self.assertIn("{$LIVEKIT_TURN_HOST:http://turn.invalid} {", CADDYFILE)

    def test_lets_encrypt_alone_over_port_80(self):
        self.assertRegex(self.block, r"tls \{\n\t\tissuer acme \{\n\t\t\tdisable_tlsalpn_challenge\n\t\t\}\n\t\}")
        # No other CA, no on-demand, no other challenge switched off.
        self.assertNotIn("zerossl", self.block)
        self.assertNotIn("on_demand", self.block)
        self.assertNotIn("disable_http_challenge", self.block)

    def test_it_serves_nothing(self):
        directives = [line.strip().split()[0] for line in self.block.splitlines() if line.startswith("\t") and not line.startswith("\t\t")
                      and line.strip() and not line.strip().startswith("#")]
        self.assertEqual(directives, ["tls", "}", "respond"])
        self.assertIn("\n\trespond 404\n", self.block)

    def test_the_folder_is_the_one_livekit_mounts(self):
        turn = (EDGE.parent / "livekit" / "compose.turn.yaml").read_text()
        self.assertIn("subpath: caddy/certificates/acme-v02.api.letsencrypt.org-directory/${LIVEKIT_TURN_DOMAIN", turn)
        self.assertIn("name: ni-edge-caddy-data", turn)
        self.assertIn("name: ni-edge-caddy-data", (EDGE / "compose.yaml").read_text())


def docker_runs():
    """True when a Docker daemon answers (GitHub's runners; not a Mac with Docker closed)."""
    if not shutil.which("docker"):
        return False
    try:
        return subprocess.run(["docker", "info"], capture_output=True, timeout=20).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


CADDY_IMAGE = re.search(r"image: (caddy:\S+)", (EDGE / "compose.yaml").read_text()).group(1)
HAS_CADDY = bool(shutil.which("caddy"))


@unittest.skipUnless(HAS_CADDY or docker_runs(), "needs caddy on the PATH (2.11, as the edge runs) or a running Docker")
class CaddyItself(unittest.TestCase):
    """The Caddyfile through Caddy itself: its own binary, or the edge's image when only Docker is here."""

    def adapt(self, env):
        with tempfile.TemporaryDirectory() as folder:
            shutil.copy(EDGE / "Caddyfile", folder)
            os.chmod(folder, 0o755)
            settings = dict({"SUPABASE_UPSTREAM": "https://made-up.example.com"}, **env)
            if HAS_CADDY:
                done = subprocess.run(["caddy", "adapt", "--config", os.path.join(folder, "Caddyfile")],
                                      env=dict({"PATH": os.environ["PATH"], "HOME": folder}, **settings), capture_output=True, text=True)
            else:
                flags = [x for kv in settings.items() for x in ("-e", "%s=%s" % kv)]
                done = subprocess.run(["docker", "run", "--rm", "--network", "none", "-v", folder + ":/etc/caddy:ro", *flags, CADDY_IMAGE,
                                       "caddy", "adapt", "--config", "/etc/caddy/Caddyfile"], capture_output=True, text=True)
            self.assertEqual(done.returncode, 0, done.stderr)
            return json.loads(done.stdout)

    def test_it_loads_with_the_turn_name_unset_and_set(self):
        # The site block for the TURN name's certificate: every public name is down if Caddy refuses the file.
        for env in ({}, {"LIVEKIT_TURN_HOST": "turn.example.com", "EDGE_PUBLIC_IP": "198.51.100.4"}):
            servers = self.adapt(env)["apps"]["http"]["servers"]
            self.assertTrue(servers)

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

    def ports(self, env):
        with tempfile.TemporaryDirectory() as folder:
            shutil.copy(EDGE / "compose.yaml", folder)
            with open(os.path.join(folder, ".env"), "w") as f:
                f.write("SUPABASE_UPSTREAM=https://made-up.example.com\n")
                f.writelines("%s=%s\n" % kv for kv in env.items())
            clean = {k: v for k, v in os.environ.items() if k not in ("EDGE_PUBLIC_IP", "LIVEKIT_TURN_HOST")}
            done = subprocess.run(["docker", "compose", "config", "--format", "json"], cwd=folder, env=clean,
                                  capture_output=True, text=True, check=True)
            caddy = json.loads(done.stdout)["services"]["caddy"]
            return {p["target"]: p.get("host_ip") for p in caddy["ports"]}, caddy["environment"]

    def test_443_on_every_address_until_edge_public_ip_is_set(self):
        for env in ({}, {"EDGE_PUBLIC_IP": ""}):
            ports, environment = self.ports(env)
            # As before this setting existed: no address, so every one (IPv6 too).
            self.assertEqual(ports, {80: None, 443: None})
            self.assertEqual(environment["LIVEKIT_TURN_HOST"], "http://turn.invalid")
        ports, environment = self.ports({"EDGE_PUBLIC_IP": "198.51.100.4", "LIVEKIT_TURN_HOST": "turn.example.com"})
        # 443 on the first address alone; 80 everywhere, for the TURN name's challenge on the second.
        self.assertEqual(ports, {80: None, 443: "198.51.100.4"})
        self.assertEqual(environment["LIVEKIT_TURN_HOST"], "turn.example.com")

    def test_the_edge_example_names_both(self):
        example = (EDGE / ".env.example").read_text()
        self.assertIn("#CLOUD_BROWSER_HUB_DOMAIN=", example)
        self.assertIn("#CLOUD_BROWSER_TRAFFIC_UPSTREAM=", example)
        self.assertIn("#EDGE_PUBLIC_IP=", example)
        self.assertIn("#LIVEKIT_TURN_HOST=", example)


if __name__ == "__main__":
    unittest.main()


def uri_rules(body):
    """The request>uri multi_regexp rules of a block: (pattern, replacement) in order, Caddy's ${1} as Python's \\1."""
    m = re.search(r"request>uri multi_regexp \{(.*?)\n\s*\}", body, re.S)
    if not m:
        return []
    rules = re.findall(r'^\s*regexp "((?:[^"\\]|\\.)*)" "((?:[^"\\]|\\.)*)"', m.group(1), re.M)
    return [(pat, rep.replace("${1}", "\\1")) for pat, rep in rules]


def scrub(rules, uri):
    for pat, rep in rules:
        uri = re.sub(pat, rep, uri)
    return uri


class TheLogsKeepNoWordpressPassword(unittest.TestCase):
    """A WordPress site hands its application password back in the query string
    (web/src/app/api/website/wordpress/callback): neither log may keep it."""

    URI = "/api/website/wordpress/callback?state=abc.def&site_url=https%3A%2F%2Fexample.test&user_login=site-admin&password=abcd+efgh+ijkl+mnop+qrst+uvwx"

    def setUp(self):
        self.blocks = dict(blocks(CADDYFILE))
        self.global_options = next(body for head, body in blocks(CADDYFILE) if head == "")

    def check(self, body):
        scrubbed = scrub(uri_rules(body), self.URI)
        self.assertIn("password=REDACTED", scrubbed)
        self.assertIn("user_login=REDACTED", scrubbed)
        for leak in ("abcd", "uvwx", "site-admin"):
            self.assertNotIn(leak, scrubbed)
        return scrubbed

    def test_the_apps_access_log(self):
        scrubbed = self.check(self.blocks["{$APP_HOSTS:http://app.invalid}"])
        # The rules it had still hold.
        self.assertIn("state=REDACTED", scrubbed)
        self.assertEqual(scrub(uri_rules(self.blocks["{$APP_HOSTS:http://app.invalid}"]), "/x?code=1&token=2"), "/x?code=REDACTED&token=REDACTED")

    def test_the_error_log(self):
        self.check(self.global_options)
        self.assertEqual(scrub(uri_rules(self.global_options), "/x?apikey=1"), "/x?apikey=REDACTED")
