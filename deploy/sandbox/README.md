# The sandbox server

A second server, apart from the app's, that runs the coding agent's sandboxes and (later) the cloud browsers. It is separate so that untrusted code never shares a machine with the app and its database, and so that it can grow by itself.

**Where this stands.** The server is set up and the runtime runs on it, tried by hand (see [What was tried](#what-was-tried)). [The tunnel](#the-tunnel) between it and the app's server is up at both ends since 2026-11-12, and the app's containers can reach the runtime through it. The app does not use this server yet: coding runs and cloud browsers still go to the hosted sandbox service ([`../README.md`](../README.md), "The coding agent"). What is still to build is listed under [Not done yet](#not-done-yet).

## What runs here

[E2B's open-source sandbox runtime](https://github.com/e2b-dev/runtime), in its single-machine package ("Embed", the Docker Compose shape), at the commit pinned in [`setup.sh`](setup.sh). Every sandbox is a small virtual machine (Firecracker), not a container: its own kernel, its own disk, its own network.

Two things to know about that package before relying on it:

- **Its makers call it an evaluation package, not a way to run production**, and point to their paid offering for that. What that means here: there is one machine, so a restart or an upgrade of the runtime ends every running sandbox (paused ones are kept), and when something breaks the fixing is ours.
- **It has no login of its own between its parts.** Twelve ports listen on every address of the machine, and one of them, the control port (5008), creates and kills sandboxes for anyone who reaches it. Keeping them out of reach is the operator's job. Here that is the firewall and [the guard](#the-guard).

## Set it up from nothing

1. A machine that can run virtual machines (`/dev/kvm`: a physical server, or one that passes virtualization through), with Ubuntu 24.04 and a user who can `sudo` and logs in with an SSH key.
2. The base setup, from your own machine, with the sandbox role (SSH is the only thing the firewall opens):

   ```bash
   ssh <user>@<sandbox-server> "sudo bash -s -- --login-user <user> --repo <https address of this repository> --role sandbox" < deploy/server/setup.sh
   ```

3. The runtime and its rules, on the server. The first run takes a few minutes: the runtime prepares the machine, fetches what it needs and builds its base image.

   ```bash
   cd /opt/native-intelligence/deploy/sandbox
   sudo ./setup.sh
   sudo ./check.sh
   ```

Both scripts are safe to run again. `setup.sh` handles one secret, the runtime's own API key, which the runtime makes on its first start: it lands in `/opt/e2b/sdk.env`, readable by root only, and is never shown. Do not print that file or the output of `docker compose logs ready`, which contains it too.

## The guard

Three rules of this server's own, kept in a firewall table of their own ([`guard.sh`](guard.sh)). Neither `ufw`, Docker nor a flush of the usual firewall tables touches that table, and a refusal in it is final whatever the other tables say.

**1. Nothing on this machine connects to one of this machine's own addresses, except IPv4 loopback.** The runtime sends every sandbox's outgoing connections through a proxy that runs on this machine, as this machine. The proxy refuses private and loopback addresses by itself, but not this machine's own public address: asked for that one, it connects to itself. On the first server, before the guard, a sandbox with the default network policy reached ten of the machine's ports that way, the control port and SSH among them. Rules about what comes in do not stop this, because the connection never comes in from outside. The runtime's parts talk to each other over IPv4 loopback only, so the rule is not in their way. IPv6 loopback is refused too: nothing here needs it, and the runtime's ports answer on it.

**2. The runtime's ports take connections from this machine and from the sandboxes, and from nowhere else.** `ufw` says the same. This rule is there so that the control port is not one switched-off firewall away from the internet.

**3. Nothing that comes from a sandbox is passed on to a private address.** A sandbox's connection to a port that a container publishes on this machine never reaches the proxy: Docker rewrites its address first, and the machine passes it straight on. So does anything that is not TCP. Containers, other sandboxes and, later, the tunnel to the app's server have private addresses; the internet does not.

How it is kept in place:

- It is loaded at boot before Docker, and again by Docker itself each time Docker starts. When that fails, Docker does not start, so no container and no sandbox runs without it.
- A timer looks every minute and loads it again if it is gone, or if its rules are no longer the ones that were loaded (a rule put in front, a chain moved).
- To load it by hand: `sudo ni-sandbox-guard apply`. That replaces the table in one step, with no moment without it.
- **Never enable or restart `nftables.service` on this server.** It empties every firewall table on the machine. The guard is back within a minute; Docker's and `ufw`'s rules are not, until those are restarted.

What [`check.sh`](check.sh) proves about it, each time it runs:

- From the machine itself, the runtime answers on loopback and on none of the machine's own addresses, IPv4 and IPv6.
- From inside a real sandbox with the widest network policy: none of the machine's addresses answers on any port that listens here; requests to an outside site that name this machine as the host are not answered by the runtime; datagrams to the machine do not arrive.
- The guard's own note of what it refused holds every address and port that was tried at a public address. Some listeners say nothing to a probe whether reached or not, so silence alone is not taken as proof.
- The internet is reached on a web port and on another port, and a datagram sent out is answered, so "nothing reached" cannot mean "nothing works".

IPv4 loopback is the one place the guard leaves to the runtime's proxy alone, since the runtime needs it. The proxy refused it in every way tried.

## The firewall

`ufw`, set by the base setup: everything that comes in is refused except SSH, for IPv4 and IPv6. `setup.sh` adds one rule, for the sandboxes' own address range to the six ports of the runtime's proxy, which is how a sandbox's traffic gets out. `check.sh` fails when `ufw` holds any other rule.

**A port that a container publishes is open to the internet whatever `ufw` says**: Docker sees to that itself. The runtime's own containers publish on loopback only. `check.sh` fails when any container publishes beyond loopback; the guard keeps sandboxes and this machine away from such a port, not the internet.

The app's server needs the runtime's API (3000) and the sandboxes' traffic port (3002). Those two are opened to that one server only, through [the tunnel](#the-tunnel), and never to the internet. Opening them takes a line in the guard's second rule as well as one in `ufw`: a `ufw` rule alone changes nothing, because the guard drops first. `tunnel.sh` sets both.

## The tunnel

A private link between the two servers ([`tunnel.sh`](tunnel.sh), WireGuard), with one address at each end: `10.200.77.1` for the app's server, `10.200.77.2` for this one. The app reaches the runtime at `http://10.200.77.2:3000` (its API) and `http://10.200.77.2:3002` (the sandboxes' traffic). The runtime speaks plain HTTP; the tunnel is what encrypts it and what says who is calling.

The two ends are not alike, on purpose:

- **The app's end dials out.** No port is opened on the app's server. Whatever arrives there through the tunnel is dropped unless it answers the app's own call, by a small firewall table of the tunnel's own that runs ahead of `ufw` and ahead of Docker. A `ufw` rule alone would not do it: Docker hands a connection for a port it publishes (the web's two, the calls' two) straight to its container, and `ufw`'s rules for what comes in never see it. `ufw` gets a matching rule as well, first in line, for whoever reads its list.
- **This end listens on one UDP port (51820)**, opened in `ufw` to the app server's address alone. From the tunnel it takes connections to ports 3000 and 3002, from the app's tunnel address, and nothing else.
- **Nothing here reaches into the tunnel.** The guard refuses everything this machine would send into it that does not answer the app's own call, and drops anything that would be passed on into it. So a sandbox cannot use this machine, or its proxy, to get at the app's server. One consequence for whoever wires the app: the runtime can never call the app back through the tunnel. Anything it must tell the app, the app asks for.

The second point and the third are two locks on the same door, held by different servers: this server's guard, which someone who took this server over could remove, and the app server's own table, which they could not.

To set it up, on each server from the repository's checkout:

```bash
sudo ./tunnel.sh key
```

That makes the end's key pair if it has none and prints its public key. The private key stays in a file only root can read and is never shown. It also installs the tunnel's package where it is missing, on the app's server too. Then give each end the other's public key:

```bash
# on the sandbox server
sudo ./tunnel.sh sandbox --peer-key <the app server's public key> --peer-address <the app server's public IPv4 address>
sudo ./check.sh

# on the app's server
sudo ./tunnel.sh app --peer-key <the sandbox server's public key> --endpoint <the sandbox server's public IPv4 address>
sudo ./tunnel.sh check
```

The app's step ends by asking the runtime for its health answer through the tunnel, and fails when none comes. `sudo ./tunnel.sh check` there changes nothing and says whether the way in is closed and the runtime answers. `sudo ./tunnel.sh status` shows, at either end, the other end's public key and when the two last spoke. Each step is safe to run again, and a role run again with another key or address replaces the earlier one.

On the app's server this installs a package, adds a network interface, a small firewall table and one `ufw` rule, and changes nothing else: no route but the one to this server's tunnel address, no port. Like everything done on that server, it is the owner's call.

When this server is down, a call through the tunnel does not fail: it waits. Whatever calls the runtime needs its own time limit.

**What the app's server now carries for it,** so that nobody takes these for strays: the package `wireguard-tools`, the network interface `ni-sandbox` (address `10.200.77.1`), three files in `/etc/wireguard` (`ni-sandbox.key`, `.conf`, `.nft`), the firewall table `inet ni_sandbox_tunnel`, the first rule in `ufw`'s list, and the unit `wg-quick@ni-sandbox`. To take the tunnel away there: `sudo systemctl disable --now wg-quick@ni-sandbox`, `sudo nft delete table inet ni_sandbox_tunnel`, `sudo ufw delete deny in on ni-sandbox`.

**When a package server is down.** `tunnel.sh key` installs `wireguard-tools` where it is missing, and gives up with an error when the machine's package server does not answer. The same package can then be fetched from Ubuntu's main archive and checked against the checksum the machine's own signed package list holds, before it is installed:

```bash
apt-cache show wireguard-tools | grep -E '^(Filename|SHA256):'
curl -fsS -o wireguard-tools.deb http://archive.ubuntu.com/ubuntu/<that Filename>
sha256sum wireguard-tools.deb          # must be that SHA256, to the letter
sudo dpkg -i wireguard-tools.deb
```

After that `tunnel.sh key` finds the tools in place and installs nothing.


## Memory, and how many sandboxes fit

The runtime sets memory aside for sandboxes when it starts, and nothing else on the machine can use it then. `setup.sh` sets aside half the machine's memory the first time, and afterwards keeps what was set unless told otherwise:

```bash
sudo ./setup.sh --pool-gib 16
```

A sandbox reserves its whole memory size from that pool when it starts (512 MiB for the base image; an image of ours can ask for more), and gives it back when it is paused or removed. A sandbox that does not fit is refused with a clear error. The runtime also has a limit of its own of 20 sandboxes running at once.

**Never run `docker compose up` by hand in `/opt/e2b`.** Without this server's settings the runtime falls back to its own default of 4 GiB and writes that down as the machine's setting. Use `sudo systemctl restart ni-sandbox-runtime`, which runs the same `up` with the settings.

## Day to day

| To | Do |
| --- | --- |
| See that all is well | `sudo ./check.sh` |
| Follow the runtime's logs | `cd /opt/e2b && sudo docker compose logs -f api orchestrator` |
| Start it after a reboot | Nothing: the unit `ni-sandbox-runtime` does it (the runtime's guide asks for an `up` after every boot) |
| Start or put right the runtime | `sudo systemctl restart ni-sandbox-runtime` (never `docker compose up` by hand: see above) |
| Load the guard again | `sudo ni-sandbox-guard apply` |
| Change the memory for sandboxes | `sudo ./setup.sh --pool-gib <n>` |
| Move to a newer runtime | Change the three pin lines at the top of `setup.sh` together (the commit and the two checksums), get that merged, `git pull` here, then `sudo ./setup.sh --upgrade`. **This ends every running sandbox.** |

### Checks

`check.sh` sees everything but the server from outside. From another machine, only SSH may answer. Each of these must fail, on both of the server's addresses:

```bash
for a in <sandbox-server IPv4> <sandbox-server IPv6>; do for p in 3000 3001 3002 3003 5007 5008 5009 5010 5011 5012 5016 5017 5018 5109 6060 6061; do nc -z -w 3 $a $p && echo "OPEN: $a $p"; done; done
```

## What was tried

On the first server (4 cores, 8 threads, 32 GB, two spinning disks mirrored), by hand, on 2026-11-11, with the runtime at the pinned commit:

- **Starting.** A sandbox from the base image is up in about 0.06 s; twenty were running after 1.1 s.
- **Ending.** A sandbox past its time is removed by the runtime (given 15 s, gone when looked at after 32 s).
- **Pausing.** Pause takes 0.4 to 1.1 s, resume 0.08 s. Files are kept, and so is memory: a program that was counting carried on from where it was.
- **Reaching in.** A port inside a sandbox is reached through the one traffic port (3002), named by a header. A WebSocket through it worked and survived 75 s of silence.
- **Between sandboxes.** One sandbox could not reach another, by any address tried.
- **The way out.** Three settings were tried. Open: the internet, and nothing private. A list of allowed names: only those names, and an allowed name cannot be used as a mask for another server (the proxy looks the name up itself). Closed: nothing, name lookups included. The setting can be changed on a running sandbox and takes effect at once.
- **The machine's own loopback.** Could not be reached from a sandbox by any of the tricks tried: requests to an outside site naming `localhost`, `[::1]`, `0.0.0.0` or this machine's addresses as the host; and, with a list of allowed names, names on that list that resolve to `127.0.0.1`, `::1`, `0.0.0.0` or this machine's public address. Do not rely on that last one: keep names whose address someone else decides off the lists.
- **The guard.** With it taken out by hand, `check.sh` fails: the runtime answers on the machine's own addresses. With a container made to publish a port, a sandbox reached that port before rule 3 existed and not after, and `check.sh` fails either way, because the port is open to the internet. From another machine only SSH answered, and the guard's own counter showed it had dropped the tries at the runtime's ports itself, ahead of `ufw`. A connection the guard refuses fails at once (0.007 s); in a first version the refusal's own error message was refused too, and the caller waited out its timeout.
- **A reboot.** Three times. The last, with the guard as it is now: the machine was back two minutes after the command; the guard was loaded 28 s into the boot, before Docker started; the runtime was ready by itself 3 min 45 s after the command, and `check.sh` passed with nothing done by hand. The first time, a sandbox paused before the reboot resumed after it in 1.4 s with its files and its running program. The one that was running was gone, and the runtime still listed it as running: whatever calls the runtime must expect that.
- **How many.** With 16 GiB set aside, twenty base sandboxes ran at once (the runtime's own limit).
- **The tunnel.** First this end alone, with a stand-in for the app server's key: the check passes, and a reboot brings the guard, the tunnel and the runtime back in that order. The app end's table was rehearsed here with a pretend link and a container publishing a port on it: without the table the far end reached the published port, which is what would have happened on the app's server with a `ufw` rule alone; with it nothing came in, and calls going out were still answered. Then both ends for real, on 2026-11-12: the app's step ended with the runtime's health answer through the tunnel, `tunnel.sh check` passed on the app's server, a request from inside the coding agent's own container was answered by the runtime, and this server's check says the app's server is connected. On the app's server nothing restarted and no port changed. Not seen: the app end's table dropping a real packet. Nothing can send it one while this server's guard stands, so that table is proven by the rehearsal alone. On the way, the app's server waited five minutes on a package server that was down and then gave up; the package came from Ubuntu's main archive instead, checked against the signed list (see "When a package server is down").
- **A browser.** An image from a registry with a browser in it was built in 42 s. A 2 GiB sandbox from it started in 0.07 s; the browser answered from outside, through the traffic port, 3.8 s later; it was driven over a WebSocket (it opened a page); and it still showed that page after a pause (1.2 s) and a resume (0.5 s).

## Known gaps

- **Rules that add a header on the way out are stored and not applied** by this package. The coding agent's sandbox relies on such a rule today: the hosted service adds the run's gate token to requests for the app's git gate, so the token never sits inside the sandbox. Here that needs another arrangement, to be decided when the coding agent is moved.
- **The runtime's own limits live in its database**, not in a settings file: 20 sandboxes at once, one hour of life for a sandbox at most, 8 processors and 8 GiB each at most, and 512 MiB of free disk on top of what an image holds. Installing a browser into an image failed on that last one, and a change of the value in the database did not take effect at once. An image of ours with a repository's dependencies in it needs more disk, and a long run may need more time: how to set these, from `setup.sh`, is to be worked out when the coding agent is moved.
- **Name lookups still leave with a list of allowed names**, through the resolver the sandbox is given. A program could pass a little data out that way, slowly. The closed setting has no such gap.
- **No names and no certificates** for a sandbox's ports: the runtime offers one plain port. A browser that a person's own computer must reach needs an address and a certificate from an edge of ours.
- **A program inside a sandbox can read** its own sandbox's id and a hash of its access token from the machine's metadata address. Neither opens anything by itself.
- **The runtime's databases have weak or no passwords** and are kept away from sandboxes by their private addresses alone: the proxy refuses those, and so does the guard's third rule.

## Not done yet

- The piece that lets the coding agent use this runtime in place of the hosted service, with its own image.
- The cloud browser on it.
- A second setup from nothing on a wiped machine, timed.
