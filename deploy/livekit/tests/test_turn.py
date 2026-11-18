"""TURN over TLS on 443 (compose.yaml's `turn:` block and compose.turn.yaml): off,
and LiveKit's configuration as it was, until its settings are filled in; on, the
values LiveKit v1.13.11 reads (pkg/config/config.go, TURNConfig; pkg/service/turn.go).

    python3 -m unittest discover -s deploy/livekit/tests

Needs `docker` (compose only, no daemon); skipped without it. With a running Docker
(GitHub's runners), LiveKit itself is started with the settings empty and set.
"""
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

LIVEKIT = Path(__file__).resolve().parents[1]
SETTINGS = ("LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "LIVEKIT_TURN_DOMAIN", "LIVEKIT_TURN_IP", "COMPOSE_FILE",
            "COMPOSE_PROFILES", "LIVEKIT_NODE_IP", "LIVEKIT_WEBHOOK_URL")


def turn_block(config):
    """The `turn:` mapping of LIVEKIT_CONFIG, as plain text lines."""
    lines = config.splitlines()
    start = lines.index("turn:")
    block = []
    for line in lines[start + 1:]:
        if not line.startswith("  "):
            break
        block.append(line.strip())
    return block


@unittest.skipUnless(shutil.which("docker"), "needs docker compose (no daemon)")
class TheCompose(unittest.TestCase):
    def render(self, env, check=True):
        with tempfile.TemporaryDirectory() as folder:
            for name in ("compose.yaml", "compose.turn.yaml"):
                shutil.copy(LIVEKIT / name, folder)
            with open(os.path.join(folder, ".env"), "w") as f:
                f.write("LIVEKIT_API_KEY=APIabcdefghijkl\nLIVEKIT_API_SECRET=%s\n" % ("s" * 48))
                f.writelines("%s=%s\n" % kv for kv in env.items())
            clean = {k: v for k, v in os.environ.items() if k not in SETTINGS}
            done = subprocess.run(["docker", "compose", "config", "--format", "json"], cwd=folder, env=clean,
                                  capture_output=True, text=True)
            if not check:
                return done
            self.assertEqual(done.returncode, 0, done.stderr)
            return json.loads(done.stdout)

    def test_off_until_set(self):
        for env in ({}, {"LIVEKIT_TURN_DOMAIN": "", "LIVEKIT_TURN_IP": ""}):
            rendered = self.render(env)
            self.assertNotIn("turn-tls", rendered["services"])
            block = turn_block(rendered["services"]["livekit"]["environment"]["LIVEKIT_CONFIG"])
            # Empty is unset for LiveKit: enabled false, no TLS port (and so no "TLS only" answer either).
            self.assertIn("enabled:", block)
            self.assertIn("tls_port:", block)
            self.assertIn("domain: ''", block)
            # LiveKit's own ports, as before.
            self.assertEqual(sorted((p["target"], p["protocol"]) for p in rendered["services"]["livekit"]["ports"]),
                             [(7881, "tcp"), (7882, "udp")])

    def test_on(self):
        rendered = self.render({"COMPOSE_FILE": "compose.yaml:compose.turn.yaml",
                                "LIVEKIT_TURN_DOMAIN": "turn.example.com", "LIVEKIT_TURN_IP": "203.0.113.7"})
        block = turn_block(rendered["services"]["livekit"]["environment"]["LIVEKIT_CONFIG"])
        for line in ("enabled: true", "domain: 'turn.example.com'", "tls_port: 5349", "external_tls: true",
                     "proxy_protocol: true", "proxy_protocol_trusted_cidrs: [10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16]"):
            self.assertIn(line, block)
        # No TURN over UDP, and LiveKit publishes nothing more.
        self.assertFalse(any(line.startswith("udp_port") for line in block))
        self.assertEqual(len(rendered["services"]["livekit"]["ports"]), 2)

        tls = rendered["services"]["turn-tls"]
        self.assertEqual([(p.get("host_ip"), p["published"], p["target"], p["protocol"]) for p in tls["ports"]],
                         [("203.0.113.7", "443", 443, "tcp")])
        self.assertEqual(tls["volumes"], [{"type": "volume", "source": "caddy-data", "target": "/certs", "read_only": True,
                                           "volume": {"subpath": "caddy/certificates/acme-v02.api.letsencrypt.org-directory/turn.example.com"}}])
        self.assertEqual(rendered["volumes"]["caddy-data"]["name"], "ni-edge-caddy-data")
        self.assertTrue(rendered["volumes"]["caddy-data"]["external"])
        self.assertTrue(tls["read_only"])
        self.assertEqual(tls["cap_drop"], ["ALL"])
        self.assertEqual(sorted(tls["cap_add"]), ["SETGID", "SETUID"])
        self.assertEqual(list(tls["networks"]), ["livekit-edge"])

        nginx = rendered["configs"]["turn-tls"]["content"].replace("$$", "$")
        for line in ("listen 443 ssl;", "proxy_protocol on;", "ssl_certificate $turn_cert;", "ssl_certificate_key $turn_key;",
                     "proxy_pass $turn_upstream;", "resolver 127.0.0.11 valid=10s ipv6=off;",
                     "map $server_port $turn_cert { default /certs/turn.example.com.crt; }",
                     "map $server_port $turn_key { default /certs/turn.example.com.key; }",
                     "map $server_port $turn_upstream { default ni-livekit:5349; }"):
            self.assertIn(line, nginx)
        # The upstream port is LiveKit's tls_port.
        self.assertIn("ni-livekit:5349", nginx)

    def test_the_file_named_without_its_settings_stops(self):
        done = self.render({"COMPOSE_FILE": "compose.yaml:compose.turn.yaml", "LIVEKIT_TURN_DOMAIN": "turn.example.com"}, check=False)
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("LIVEKIT_TURN_IP", done.stderr)
        done = self.render({"COMPOSE_FILE": "compose.yaml:compose.turn.yaml", "LIVEKIT_TURN_IP": "203.0.113.7"}, check=False)
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("LIVEKIT_TURN_DOMAIN", done.stderr)

    def test_the_example_names_them(self):
        example = (LIVEKIT / ".env.example").read_text()
        for line in ("#COMPOSE_FILE=compose.yaml:compose.turn.yaml\n", "\nLIVEKIT_TURN_DOMAIN=\n", "\nLIVEKIT_TURN_IP=\n"):
            self.assertIn(line, example)


if __name__ == "__main__":
    unittest.main()


def docker_runs():
    if not shutil.which("docker"):
        return False
    try:
        if subprocess.run(["docker", "info"], capture_output=True, timeout=20).returncode != 0:
            return False
        # Never beside the real one (the server, or a machine that runs this stack).
        named = subprocess.run(["docker", "ps", "-aq", "--filter", "name=^ni-livekit"], capture_output=True, text=True, timeout=20)
        return named.returncode == 0 and not named.stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        return False


@unittest.skipUnless(docker_runs(), "needs a running Docker with no ni-livekit container")
class LiveKitItself(unittest.TestCase):
    """LiveKit, as pinned, starts and reports healthy with the TURN settings empty and with them set."""

    def start(self, env):
        with tempfile.TemporaryDirectory() as folder:
            shutil.copy(LIVEKIT / "compose.yaml", folder)
            with open(os.path.join(folder, ".env"), "w") as f:
                # A fixed node address: no question to a public STUN server from a test.
                f.write("LIVEKIT_API_KEY=APIabcdefghijkl\nLIVEKIT_API_SECRET=%s\nLIVEKIT_NODE_IP=127.0.0.1\n" % ("s" * 48))
                f.writelines("%s=%s\n" % kv for kv in env.items())
            clean = {k: v for k, v in os.environ.items() if k not in SETTINGS}
            made = subprocess.run(["docker", "network", "create", "ni-livekit-edge"], capture_output=True).returncode == 0
            compose = ["docker", "compose", "-p", "ni-livekit-test"]
            try:
                up = subprocess.run(compose + ["up", "-d", "--wait", "--wait-timeout", "120", "livekit"], cwd=folder, env=clean,
                                    capture_output=True, text=True)
                logs = subprocess.run(compose + ["logs", "--no-color", "livekit"], cwd=folder, env=clean, capture_output=True, text=True).stdout
                self.assertEqual(up.returncode, 0, up.stderr + logs[-3000:])
                return logs
            finally:
                subprocess.run(compose + ["down", "-v", "--timeout", "5"], cwd=folder, env=clean, capture_output=True)
                if made:
                    subprocess.run(["docker", "network", "rm", "ni-livekit-edge"], capture_output=True)

    def test_it_starts_with_turn_off(self):
        self.start({})

    def test_it_starts_with_turn_on(self):
        # Without compose.turn.yaml: LiveKit's own side of it (the TLS terminator is nginx's test, on the server).
        self.start({"LIVEKIT_TURN_DOMAIN": "turn.example.com"})
