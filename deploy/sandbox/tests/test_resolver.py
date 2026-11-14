"""The sandboxes' resolver answers for the names the coding agent's narrowed
levels allow, and for no other. Those names are written in two places: the
agent's own list (web/agents/coding-agent/sandbox.ts, RESTRICTED_ALLOW_HOSTS)
and the resolver's zones (deploy/sandbox/resolver.sh). Nothing but this test
notices when only one of them moves: a name added to the agent's list alone
would be allowed out and never resolve.

The guard's part is checked as text: which rules the resolver's setting adds,
and that it adds none without it.
"""
import importlib.util
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SANDBOX = ROOT / "deploy" / "sandbox"


def resolver(*args):
    return subprocess.run(["sh", str(SANDBOX / "resolver.sh"), *args], capture_output=True, text=True)


def guard_rules(settings: dict | None = None) -> str:
    with tempfile.TemporaryDirectory() as folder:
        for name, text in (settings or {}).items():
            (Path(folder) / name).write_text(text)
        done = subprocess.run(
            ["sh", str(SANDBOX / "guard.sh"), "render"],
            capture_output=True,
            text=True,
            env={"PATH": "/usr/bin:/bin", "NI_SANDBOX_SETTINGS_DIR": folder},
        )
        if done.returncode != 0:
            raise AssertionError(done.stderr)
        return done.stdout


def zones() -> list[str]:
    text = (SANDBOX / "resolver.sh").read_text()
    return re.search(r'^zones="([^"]+)"$', text, re.M).group(1).split()


def agents_hosts() -> list[str]:
    text = (ROOT / "web" / "agents" / "coding-agent" / "sandbox.ts").read_text()
    block = re.search(r"export const RESTRICTED_ALLOW_HOSTS = \[(.*?)\] as const", text, re.S).group(1)
    return re.findall(r"'([^']+)'", block)


def load_image():
    spec = importlib.util.spec_from_file_location("sandbox_image", SANDBOX / "image.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TheNames(unittest.TestCase):
    def test_every_name_the_agent_allows_is_under_a_zone(self):
        for host in agents_hosts():
            name = host.removeprefix("*.")
            self.assertTrue(
                any(name == zone or name.endswith("." + zone) for zone in zones()),
                f"{host} is on the agent's list and under none of the resolver's zones: it would be allowed out and never resolve",
            )

    def test_no_zone_is_there_for_nothing(self):
        names = [host.removeprefix("*.") for host in agents_hosts()]
        for zone in zones():
            self.assertTrue(
                any(name == zone or name.endswith("." + zone) for name in names),
                f"the resolver answers for {zone}, which the agent's list does not hold",
            )

    def test_the_agents_list_is_read(self):
        # The two tests above prove nothing over an empty list.
        self.assertIn("github.com", agents_hosts())
        self.assertGreaterEqual(len(agents_hosts()), 4)


class TheSettings(unittest.TestCase):
    def setUp(self):
        done = resolver("conf", "app.example.com")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.conf = done.stdout

    def test_everything_is_refused_but_the_zones_and_the_apps_host(self):
        self.assertIn('local-zone: "." refuse', self.conf)
        opened = re.findall(r'local-zone: "([^"]+)" (\w+)', self.conf)
        self.assertEqual(opened[0], (".", "refuse"))
        self.assertEqual([name for name, kind in opened[1:]], [zone + "." for zone in zones()] + ["app.example.com."])
        self.assertTrue(all(kind == "transparent" for name, kind in opened[1:]))

    def test_it_asks_no_other_resolver(self):
        # A forwarder at the address the guard redirects would be a loop.
        self.assertNotIn("forward", self.conf)
        self.assertNotIn("8.8.8.8", self.conf)

    def test_it_answers_from_the_address_it_was_asked_at(self):
        # A sandbox's lookup arrives at its own link's address; an answer from another address is not its answer.
        self.assertIn("interface-automatic: yes", self.conf)
        self.assertIn("port: 5335", self.conf)

    def test_only_the_sandboxes_and_this_machine_are_answered(self):
        # The guard and the firewall keep everyone else from the port; so does the resolver itself.
        allowed = re.findall(r"access-control: (\S+) (\w+)", self.conf)
        self.assertEqual(allowed, [("0.0.0.0/0", "refuse"), ("127.0.0.0/8", "allow"), ("10.11.0.0/16", "allow")])

    def test_the_apps_host_is_a_plain_name(self):
        second_line = 'app.example.com\n" refuse\nserver:\n\tlocal-zone: "." transparent\n#'
        for odd in ("", "https://app.example.com", "app.example.com/", "app.example.com:443", "*.example.com", 'x"\n\tlocal-zone: "." transparent', "localhost", second_line, "app.example.com\n", "App.Example.com"):
            done = resolver("conf", odd)
            self.assertEqual(done.returncode, 2, f"{odd!r} was taken as a host")
            self.assertEqual(done.stdout, "")


class TheGuard(unittest.TestCase):
    def test_without_the_setting_the_guard_knows_no_resolver(self):
        rules = guard_rules()
        self.assertNotIn("8.8.8.8", rules)
        self.assertNotIn("resolver", rules)
        self.assertNotIn("type nat", rules)

    def test_with_it_lookups_are_redirected_and_the_rest_is_refused(self):
        rules = guard_rules({"resolver.env": "RESOLVER_PORT=5335\nGATE_HOST=app.example.com\n"})
        for line in (
            # A sandbox's lookups, by its link and by its address.
            'iifname "e2b-*" ip daddr 8.8.8.8 udp dport 53 counter redirect to :5335',
            "ip saddr 10.11.0.0/16 ip daddr 8.8.8.8 udp dport 53 counter redirect to :5335",
            # Everything else to that address: dropped when passed on, and over TCP
            # (which leaves as this machine, through the runtime's proxy) refused.
            'iifname "e2b-*" ip daddr 8.8.8.8 counter drop',
            "ip saddr 10.11.0.0/16 ip daddr 8.8.8.8 counter drop",
            "ip daddr 8.8.8.8 meta l4proto tcp counter reject",
            # The resolver's port: redirected lookups only.
            'iifname "e2b-*" ip saddr 10.11.0.0/16 udp dport 5335 ct status dnat accept',
            "meta l4proto { tcp, udp } th dport 5335 counter drop",
        ):
            self.assertIn(line, rules)
        # No lookup over TCP is sent to the resolver: its answer would be addressed
        # to this machine's own address, which rule 1 refuses.
        self.assertNotIn("hook output priority -100", rules)
        self.assertEqual(rules.count("redirect to"), 2)

    def test_the_three_rules_stay_as_they_were(self):
        without = guard_rules()
        with_it = guard_rules({"resolver.env": "RESOLVER_PORT=5335\n"})
        for line in without.splitlines():
            if line.strip():
                self.assertIn(line.strip(), with_it)

    def test_a_setting_that_names_no_port_stops_the_guard(self):
        with tempfile.TemporaryDirectory() as folder:
            (Path(folder) / "resolver.env").write_text("RESOLVER_PORT=53; drop\n")
            done = subprocess.run(
                ["sh", str(SANDBOX / "guard.sh"), "render"],
                capture_output=True,
                text=True,
                env={"PATH": "/usr/bin:/bin", "NI_SANDBOX_SETTINGS_DIR": folder},
            )
        self.assertNotEqual(done.returncode, 0)
        self.assertEqual(done.stdout, "")

    def test_only_render_reads_another_folder(self):
        text = (SANDBOX / "guard.sh").read_text()
        self.assertIn('if [ "${1:-}" = render ] && [ -n "${NI_SANDBOX_SETTINGS_DIR:-}" ]; then', text)
        self.assertEqual(text.count("NI_SANDBOX_SETTINGS_DIR"), 2)


class TheImage(unittest.TestCase):
    def setUp(self):
        self.image = load_image()

    def guards_address(self) -> str:
        return re.search(r"^sandbox_resolver=(\S+)$", (SANDBOX / "guard.sh").read_text(), re.M).group(1)

    def test_a_sandbox_with_the_open_internet_never_asks_the_guards_address(self):
        # That address answers for the narrowed levels' names only, once the resolver is set up.
        self.assertNotIn(self.guards_address(), self.image.RESOLVERS)
        self.assertGreaterEqual(len(self.image.RESOLVERS), 2, "one resolver alone is one failure away from no lookups")
        self.assertLessEqual(len(self.image.RESOLVERS), 3, "a resolver file holds three at most")

    def test_the_app_points_a_narrowed_sandbox_at_the_guards_address(self):
        adapter = (ROOT / "web" / "agents" / "coding-agent" / "lib" / "runtime-sandbox.ts").read_text()
        named = re.search(r"^export const NARROWED_RESOLVER = '([^']+)'$", adapter, re.M).group(1)
        self.assertEqual(named, self.guards_address())
        check = (SANDBOX / "resolver_check.py").read_text()
        self.assertIn(f'RESOLVER = "{named}"', check)

    def test_the_checks_look_for_the_rules_by_the_names_the_guard_gives_them(self):
        rules = guard_rules({"resolver.env": "RESOLVER_PORT=5335\n"})
        check = (SANDBOX / "resolver_check.py").read_text()
        for comment in ("sandbox-link-to-resolver-address", "sandbox-range-to-resolver-address"):
            self.assertIn(f'comment "{comment}"', rules)
        self.assertIn("sandbox-(?:link|range)-to-resolver-address", check)
        # resolver.sh's own check asks for this chain by name.
        self.assertIn("chain resolver_lookups {", rules)
        self.assertIn("ni_sandbox_guard resolver_lookups", (SANDBOX / "resolver.sh").read_text())

    def test_the_image_is_built_with_that_list(self):
        written = [command for user, command in self.image.STEPS if "/etc/resolv.conf" in command]
        self.assertEqual(len(written), 1)
        # First: while an image is built, a later step that fetches something asks the list, not the runtime's own resolver.
        self.assertEqual(self.image.STEPS[0][1], written[0])
        for address in self.image.RESOLVERS:
            self.assertIn(f"nameserver {address}\\n", written[0])
        self.assertNotIn("%", written[0], "the list is printf's format: a percent sign would be read as one")

    def test_another_list_means_another_build(self):
        before = self.image.definition(16384)
        self.image.STEPS = self.image.STEPS[:1]
        self.assertNotEqual(before, self.image.definition(16384))


if __name__ == "__main__":
    unittest.main()
