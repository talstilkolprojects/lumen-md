//! Small network helpers with std only: the local-network rule, randomness
//! from the OS (through std's randomly keyed SipHash), a constant-time
//! comparison, and a UDP socket on the mDNS port that shares it with the
//! operating system's own responder (SO_REUSEADDR / SO_REUSEPORT on Unix).

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4, UdpSocket};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// The local network, as src/sync/e2ee/lan/address.ts has it: private IPv4,
/// link-local, loopback; IPv6 loopback, link-local fe80::/10, unique local fc00::/7.
pub fn is_lan_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            a == 10 || a == 127 || (a == 172 && (16..=31).contains(&b)) || (a == 192 && b == 168) || (a == 169 && b == 254)
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_lan_ip(IpAddr::V4(v4));
            }
            let s = v6.segments();
            v6.is_loopback() || (s[0] & 0xffc0) == 0xfe80 || (s[0] & 0xfe00) == 0xfc00
        }
    }
}

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// 64 random bits. Each `RandomState` is keyed from the OS's random source
/// (std seeds it with getrandom / BCryptGenRandom); the clock and a counter
/// make each call distinct even when std reuses keys within a thread.
pub fn random_u64() -> u64 {
    let mut h = RandomState::new().build_hasher();
    h.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
    h.write_u128(SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    h.finish()
}

/// A 128-bit token, hex: it ties an answer to the offer it answers.
pub fn token() -> String {
    format!("{:016x}{:016x}", random_u64(), random_u64())
}

/// Equal without an early exit (the token is compared as a secret would be).
pub fn same_secret(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |d, (x, y)| d | (x ^ y)) == 0
}

/// A UDP socket bound to 0.0.0.0:5353, sharing the port with the OS's own
/// mDNS responder where the platform allows it.
pub fn bind_mdns() -> std::io::Result<UdpSocket> {
    #[cfg(any(target_os = "linux", target_os = "android", target_os = "macos", target_os = "ios"))]
    {
        if let Ok(s) = unix::bind_reuse(crate::MDNS_PORT) {
            return Ok(s);
        }
    }
    UdpSocket::bind(SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, crate::MDNS_PORT)))
}

#[cfg(any(target_os = "linux", target_os = "android", target_os = "macos", target_os = "ios"))]
mod unix {
    //! socket(2) + setsockopt(2) + bind(2) by hand, so the reuse options are set
    //! before the bind (std binds in one step). The C library is linked by std.
    use std::net::UdpSocket;
    use std::os::fd::FromRawFd;
    use std::os::raw::{c_int, c_void};

    const AF_INET: c_int = 2;
    const SOCK_DGRAM: c_int = 2;
    #[cfg(any(target_os = "linux", target_os = "android"))]
    const SOL_SOCKET: c_int = 1;
    #[cfg(any(target_os = "linux", target_os = "android"))]
    const SO_REUSEADDR: c_int = 2;
    #[cfg(any(target_os = "linux", target_os = "android"))]
    const SO_REUSEPORT: c_int = 15;
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    const SOL_SOCKET: c_int = 0xffff;
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    const SO_REUSEADDR: c_int = 0x0004;
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    const SO_REUSEPORT: c_int = 0x0200;

    /// struct sockaddr_in (Linux: sin_family is 16 bits; BSD: sin_len then an 8-bit family).
    #[repr(C)]
    struct SockaddrIn {
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        sin_len: u8,
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        sin_family: u8,
        #[cfg(any(target_os = "linux", target_os = "android"))]
        sin_family: u16,
        sin_port: u16,
        sin_addr: u32,
        sin_zero: [u8; 8],
    }

    extern "C" {
        fn socket(domain: c_int, ty: c_int, protocol: c_int) -> c_int;
        fn setsockopt(fd: c_int, level: c_int, name: c_int, value: *const c_void, len: u32) -> c_int;
        fn bind(fd: c_int, addr: *const SockaddrIn, len: u32) -> c_int;
        fn close(fd: c_int) -> c_int;
    }

    pub fn bind_reuse(port: u16) -> std::io::Result<UdpSocket> {
        // SAFETY: plain syscalls on a descriptor this function owns until it is
        // handed to UdpSocket (or closed on every error path).
        unsafe {
            let fd = socket(AF_INET, SOCK_DGRAM, 0);
            if fd < 0 {
                return Err(std::io::Error::last_os_error());
            }
            let one: c_int = 1;
            for opt in [SO_REUSEADDR, SO_REUSEPORT] {
                if setsockopt(fd, SOL_SOCKET, opt, &one as *const c_int as *const c_void, std::mem::size_of::<c_int>() as u32) != 0 {
                    let e = std::io::Error::last_os_error();
                    close(fd);
                    return Err(e);
                }
            }
            let addr = SockaddrIn {
                #[cfg(any(target_os = "macos", target_os = "ios"))]
                sin_len: std::mem::size_of::<SockaddrIn>() as u8,
                #[cfg(any(target_os = "macos", target_os = "ios"))]
                sin_family: AF_INET as u8,
                #[cfg(any(target_os = "linux", target_os = "android"))]
                sin_family: AF_INET as u16,
                sin_port: port.to_be(),
                sin_addr: 0,
                sin_zero: [0; 8],
            };
            if bind(fd, &addr, std::mem::size_of::<SockaddrIn>() as u32) != 0 {
                let e = std::io::Error::last_os_error();
                close(fd);
                return Err(e);
            }
            Ok(UdpSocket::from_raw_fd(fd))
        }
    }
}
