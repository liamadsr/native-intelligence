//! Where the agent's browser may go through this Mac (web
//! docs/plans/cloud-browser.md, C4 "Destination policy on the Mac"): the
//! public internet on ports 80 and 443, and nothing of this Mac's or its
//! network's. The name is resolved here, every address is checked, and the
//! connection goes to a checked address; it is never resolved again.
//!
//! Refused: private, loopback, link-local, CGNAT, multicast, documentation and
//! other special ranges; the networks of this Mac's interfaces (and the /56
//! around each of its global IPv6 addresses); its public IP as the hub sees it
//! (a router would hairpin it back home).
//!
//! An IPv4 address inside IPv6 (`::ffff:a.b.c.d`, NAT64 `64:ff9b::a.b.c.d`) is
//! judged by its IPv4 address: a blanket `::ffff:0:0/96` rule would refuse
//! the whole IPv4 internet (the spike's Node BlockList trap).

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use crate::mux::Refusal;

/// The only ports a stream may open.
pub const PORTS: [u16; 2] = [80, 443];

/// A network: an address and its prefix length.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Net {
    pub addr: IpAddr,
    pub prefix: u8,
}

impl Net {
    pub const fn v4(a: u8, b: u8, c: u8, d: u8, prefix: u8) -> Net {
        Net { addr: IpAddr::V4(Ipv4Addr::new(a, b, c, d)), prefix }
    }

    pub fn contains(&self, ip: IpAddr) -> bool {
        match (self.addr, ip) {
            (IpAddr::V4(net), IpAddr::V4(ip)) => prefix_eq(&net.octets(), &ip.octets(), self.prefix),
            (IpAddr::V6(net), IpAddr::V6(ip)) => prefix_eq(&net.octets(), &ip.octets(), self.prefix),
            _ => false,
        }
    }
}

fn prefix_eq(a: &[u8], b: &[u8], prefix: u8) -> bool {
    let bits = (prefix as usize).min(a.len() * 8);
    let (whole, rest) = (bits / 8, bits % 8);
    if a[..whole] != b[..whole] {
        return false;
    }
    rest == 0 || (a[whole] ^ b[whole]) >> (8 - rest) == 0
}

/// IPv4 ranges never reached through the Mac.
const V4_REFUSED: [Net; 16] = [
    Net::v4(0, 0, 0, 0, 8),       // "this" network
    Net::v4(10, 0, 0, 0, 8),      // private
    Net::v4(100, 64, 0, 0, 10),   // CGNAT
    Net::v4(127, 0, 0, 0, 8),     // loopback
    Net::v4(169, 254, 0, 0, 16),  // link-local (and cloud metadata)
    Net::v4(172, 16, 0, 0, 12),   // private
    Net::v4(192, 0, 0, 0, 24),    // IETF protocol assignments
    Net::v4(192, 0, 2, 0, 24),    // documentation
    Net::v4(192, 88, 99, 0, 24),  // 6to4 relay anycast
    Net::v4(192, 168, 0, 0, 16),  // private
    Net::v4(198, 18, 0, 0, 15),   // benchmarking
    Net::v4(198, 51, 100, 0, 24), // documentation
    Net::v4(203, 0, 113, 0, 24),  // documentation
    Net::v4(224, 0, 0, 0, 4),     // multicast
    Net::v4(240, 0, 0, 0, 4),     // reserved, and broadcast
    Net::v4(255, 255, 255, 255, 32),
];

fn v6(segments: [u16; 8], prefix: u8) -> Net {
    let [a, b, c, d, e, f, g, h] = segments;
    Net { addr: IpAddr::V6(Ipv6Addr::new(a, b, c, d, e, f, g, h)), prefix }
}

/// IPv6 ranges never reached through the Mac (embedded IPv4 is judged separately).
fn v6_refused() -> [Net; 10] {
    [
        v6([0, 0, 0, 0, 0, 0, 0, 0], 128),              // unspecified
        v6([0, 0, 0, 0, 0, 0, 0, 1], 128),              // loopback
        v6([0x100, 0, 0, 0, 0, 0, 0, 0], 64),           // discard
        v6([0x2001, 0, 0, 0, 0, 0, 0, 0], 23),          // IETF protocol assignments (Teredo among them)
        v6([0x2001, 0xdb8, 0, 0, 0, 0, 0, 0], 32),      // documentation
        v6([0x2002, 0, 0, 0, 0, 0, 0, 0], 16),          // 6to4
        v6([0xfc00, 0, 0, 0, 0, 0, 0, 0], 7),           // unique local
        v6([0xfe80, 0, 0, 0, 0, 0, 0, 0], 10),          // link-local
        v6([0xfec0, 0, 0, 0, 0, 0, 0, 0], 10),          // site-local (deprecated)
        v6([0xff00, 0, 0, 0, 0, 0, 0, 0], 8),           // multicast
    ]
}

/// The IPv4 address an IPv6 one carries: IPv4-mapped (`::ffff:0:0/96`),
/// IPv4-compatible (`::/96`, deprecated) or NAT64 (`64:ff9b::/96`).
fn embedded_v4(ip: Ipv6Addr) -> Option<Ipv4Addr> {
    let s = ip.segments();
    let tail = Ipv4Addr::new((s[6] >> 8) as u8, s[6] as u8, (s[7] >> 8) as u8, s[7] as u8);
    match s[..6] {
        [0, 0, 0, 0, 0, 0xffff] | [0x64, 0xff9b, 0, 0, 0, 0] => Some(tail),
        [0, 0, 0, 0, 0, 0] if ip.segments()[6] != 0 => Some(tail),
        _ => None,
    }
}

/// This Mac's own places: its interfaces' networks and its public IPs.
#[derive(Debug, Clone, Default)]
pub struct Blocklist {
    pub local: Vec<Net>,
    pub public: Vec<Net>,
}

impl Blocklist {
    /// This Mac's interfaces, read now ([`local_networks`]).
    pub fn of_this_mac() -> Blocklist {
        Blocklist { local: local_networks(), public: Vec::new() }
    }

    /// The same public IPs, with this Mac's interfaces read again: a VPN or a
    /// new network since the tunnel came up is refused too.
    pub fn refreshed(&self) -> Blocklist {
        Blocklist { local: local_networks(), public: self.public.clone() }
    }

    /// A public IP of this Mac's (the server's view of it, and the hub's), and
    /// for IPv6 the /56 around it.
    pub fn add_public(&mut self, ip: IpAddr) {
        self.public.push(around(ip));
    }

    /// Ok for an address the browser may reach through this Mac.
    pub fn check_ip(&self, ip: IpAddr) -> Result<(), Refusal> {
        let ip = match ip {
            IpAddr::V6(v6) => embedded_v4(v6).map(IpAddr::V4).unwrap_or(ip),
            ip => ip,
        };
        let special = match ip {
            IpAddr::V4(_) => V4_REFUSED.iter().any(|net| net.contains(ip)),
            IpAddr::V6(_) => v6_refused().iter().any(|net| net.contains(ip)),
        };
        if special || self.local.iter().chain(&self.public).any(|net| net.contains(ip)) {
            return Err(Refusal::Blocked);
        }
        Ok(())
    }
}

pub fn check_port(port: u16) -> Result<(), Refusal> {
    if PORTS.contains(&port) {
        Ok(())
    } else {
        Err(Refusal::Port)
    }
}

/// An address's own neighbourhood: itself for IPv4, its /56 for IPv6 (a home
/// gets a /56 or /48; the /56 holds every other device's address in it).
fn around(ip: IpAddr) -> Net {
    match ip {
        IpAddr::V4(_) => Net { addr: ip, prefix: 32 },
        IpAddr::V6(v6) => match embedded_v4(v6) {
            Some(v4) => Net { addr: IpAddr::V4(v4), prefix: 32 },
            None => Net { addr: ip, prefix: 56 },
        },
    }
}

#[cfg_attr(not(unix), allow(dead_code))]
fn mask_len(mask: &[u8]) -> u8 {
    mask.iter().map(|byte| byte.count_ones() as u8).sum()
}

/// Every network this Mac's interfaces are on: each IPv4 address with its
/// netmask, and each IPv6 address with its prefix and its /56.
#[cfg(unix)]
pub fn local_networks() -> Vec<Net> {
    let mut nets = Vec::new();
    let mut head: *mut libc::ifaddrs = std::ptr::null_mut();
    // SAFETY: getifaddrs fills `head` with a list freed by freeifaddrs below;
    // each sockaddr is read by the family it says it is.
    unsafe {
        if libc::getifaddrs(&mut head) != 0 {
            return nets;
        }
        let mut cursor = head;
        while !cursor.is_null() {
            let entry = &*cursor;
            cursor = entry.ifa_next;
            if entry.ifa_addr.is_null() || entry.ifa_netmask.is_null() {
                continue;
            }
            match (*entry.ifa_addr).sa_family as i32 {
                libc::AF_INET => {
                    let addr = &*(entry.ifa_addr as *const libc::sockaddr_in);
                    let mask = &*(entry.ifa_netmask as *const libc::sockaddr_in);
                    let ip = Ipv4Addr::from(u32::from_be(addr.sin_addr.s_addr));
                    let prefix = mask_len(&u32::from_be(mask.sin_addr.s_addr).to_be_bytes());
                    nets.push(Net { addr: IpAddr::V4(ip), prefix });
                }
                libc::AF_INET6 => {
                    let addr = &*(entry.ifa_addr as *const libc::sockaddr_in6);
                    let mask = &*(entry.ifa_netmask as *const libc::sockaddr_in6);
                    let ip = IpAddr::V6(Ipv6Addr::from(addr.sin6_addr.s6_addr));
                    nets.push(Net { addr: ip, prefix: mask_len(&mask.sin6_addr.s6_addr) });
                    nets.push(around(ip));
                }
                _ => {}
            }
        }
        libc::freeifaddrs(head);
    }
    nets
}

/// Every network this PC's adapters are on (Windows): each unicast address
/// with its on-link prefix, and each IPv6 address's /56, as on the Mac.
#[cfg(windows)]
pub fn local_networks() -> Vec<Net> {
    use windows_sys::Win32::Foundation::{ERROR_BUFFER_OVERFLOW, NO_ERROR};
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetAdaptersAddresses, GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER, GAA_FLAG_SKIP_FRIENDLY_NAME,
        GAA_FLAG_SKIP_MULTICAST, IP_ADAPTER_ADDRESSES_LH,
    };
    use windows_sys::Win32::Networking::WinSock::{AF_INET, AF_INET6, AF_UNSPEC, SOCKADDR_IN, SOCKADDR_IN6};

    let mut nets = Vec::new();
    let flags = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER | GAA_FLAG_SKIP_FRIENDLY_NAME;
    // 15 KB is Microsoft's suggested first size; the call says how much it
    // needs if that's short, and an adapter can appear between two calls.
    let mut size: u32 = 15 * 1024;
    let mut buf: Vec<u64>; // 8-byte aligned, as IP_ADAPTER_ADDRESSES_LH needs
    let mut tries = 0;
    loop {
        buf = vec![0u64; (size as usize).div_ceil(8)];
        // SAFETY: `buf` holds `size` writable bytes, suitably aligned.
        let rc = unsafe {
            GetAdaptersAddresses(
                AF_UNSPEC as u32,
                flags,
                std::ptr::null(),
                buf.as_mut_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>(),
                &mut size,
            )
        };
        tries += 1;
        match rc {
            NO_ERROR => break,
            ERROR_BUFFER_OVERFLOW if tries < 4 => continue,
            _ => return nets,
        }
    }
    // SAFETY: on NO_ERROR, `buf` holds a linked list of adapters, each with a
    // linked list of unicast addresses whose sockaddrs are read by the family
    // they say they are; every pointer points into `buf` or is null.
    unsafe {
        let mut adapter = buf.as_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>();
        while !adapter.is_null() {
            let mut unicast = (*adapter).FirstUnicastAddress;
            while !unicast.is_null() {
                let entry = &*unicast;
                unicast = entry.Next;
                let sockaddr = entry.Address.lpSockaddr;
                if sockaddr.is_null() {
                    continue;
                }
                let prefix = entry.OnLinkPrefixLength;
                match (*sockaddr).sa_family {
                    AF_INET => {
                        let addr = &*(sockaddr as *const SOCKADDR_IN);
                        // In memory in network order, as the octets read.
                        let ip = Ipv4Addr::from(addr.sin_addr.S_un.S_addr.to_ne_bytes());
                        nets.push(Net { addr: IpAddr::V4(ip), prefix: prefix.min(32) });
                    }
                    AF_INET6 => {
                        let addr = &*(sockaddr as *const SOCKADDR_IN6);
                        let ip = IpAddr::V6(Ipv6Addr::from(addr.sin6_addr.u.Byte));
                        nets.push(Net { addr: ip, prefix: prefix.min(128) });
                        nets.push(around(ip));
                    }
                    _ => {}
                }
            }
            adapter = (*adapter).Next;
        }
    }
    nets
}

#[cfg(not(any(unix, windows)))]
pub fn local_networks() -> Vec<Net> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(text: &str) -> IpAddr {
        text.parse().unwrap()
    }

    #[test]
    fn the_public_internet_is_allowed() {
        let list = Blocklist::default();
        for ok in ["93.184.216.34", "8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "2a00:1450:4001::200e"] {
            assert_eq!(list.check_ip(ip(ok)), Ok(()), "{ok}");
        }
    }

    #[test]
    fn private_local_and_special_ranges_are_refused() {
        let list = Blocklist::default();
        for refused in [
            "10.0.0.1", "192.168.1.1", "172.16.5.4", "172.31.255.255", "127.0.0.1", "169.254.169.254", "100.64.0.1",
            "100.127.255.254", "0.0.0.0", "224.0.0.251", "239.255.255.250", "255.255.255.255", "192.0.2.1", "198.18.0.1",
            "::1", "::", "fe80::1", "fd12:3456::1", "fc00::1", "ff02::fb", "2001:db8::1", "2002:c0a8:101::1", "2001:0:4136:e378::1",
        ] {
            assert_eq!(list.check_ip(ip(refused)), Err(Refusal::Blocked), "{refused}");
        }
    }

    /// The spike's trap: a v4-mapped rule must not refuse every IPv4 address.
    #[test]
    fn ipv4_inside_ipv6_is_judged_by_its_ipv4() {
        let list = Blocklist::default();
        assert_eq!(list.check_ip(ip("::ffff:93.184.216.34")), Ok(()));
        assert_eq!(list.check_ip(ip("64:ff9b::808:808")), Ok(()), "NAT64 of 8.8.8.8");
        assert_eq!(list.check_ip(ip("::ffff:192.168.1.1")), Err(Refusal::Blocked));
        assert_eq!(list.check_ip(ip("::ffff:127.0.0.1")), Err(Refusal::Blocked));
        assert_eq!(list.check_ip(ip("64:ff9b::a00:1")), Err(Refusal::Blocked), "NAT64 of 10.0.0.1");
        assert_eq!(list.check_ip(ip("::7f00:1")), Err(Refusal::Blocked), "IPv4-compatible loopback");
    }

    #[test]
    fn this_macs_networks_and_public_ip_are_refused() {
        let mut list = Blocklist { local: vec![Net::v4(203, 1, 0, 0, 24), v6([0x2a01, 0xe0a, 0x1d0, 0x40, 0, 0, 0, 0x10], 64)], public: vec![] };
        list.add_public(ip("24.193.1.2"));
        list.add_public(ip("2a02:1210:5a00:1000::1"));
        assert_eq!(list.check_ip(ip("203.1.0.77")), Err(Refusal::Blocked), "the Mac's own LAN");
        assert_eq!(list.check_ip(ip("2a01:e0a:1d0:40::9")), Err(Refusal::Blocked), "the Mac's own IPv6 subnet");
        assert_eq!(list.check_ip(ip("24.193.1.2")), Err(Refusal::Blocked), "its public IP (hairpin)");
        assert_eq!(list.check_ip(ip("::ffff:24.193.1.2")), Err(Refusal::Blocked));
        assert_eq!(list.check_ip(ip("2a02:1210:5a00:10ff::7")), Err(Refusal::Blocked), "the home's /56");
        assert_eq!(list.check_ip(ip("24.193.1.3")), Ok(()), "a neighbour's IPv4 is public");
        assert_eq!(list.check_ip(ip("2a02:1210:5a00:1100::1")), Ok(()), "outside the /56");
    }

    #[test]
    fn only_web_ports() {
        assert_eq!(check_port(443), Ok(()));
        assert_eq!(check_port(80), Ok(()));
        for port in [22, 25, 53, 8080, 8443, 0] {
            assert_eq!(check_port(port), Err(Refusal::Port), "{port}");
        }
    }

    #[test]
    fn prefixes_match_bit_by_bit() {
        let net = Net::v4(172, 16, 0, 0, 12);
        assert!(net.contains(ip("172.31.0.1")));
        assert!(!net.contains(ip("172.32.0.1")));
        assert!(!net.contains(ip("::ffff:172.16.0.1")), "a family never matches the other");
        assert!(Net::v4(0, 0, 0, 0, 0).contains(ip("8.8.8.8")));
    }

    #[test]
    fn reads_this_macs_interfaces() {
        let nets = local_networks();
        assert!(nets.iter().any(|net| net.contains(ip("127.0.0.1"))), "{nets:?}");
    }
}
