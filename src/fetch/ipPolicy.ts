import ipaddr from 'ipaddr.js';

/**
 * True only for globally routable unicast addresses. Everything else —
 * loopback, RFC1918, link-local (incl. 169.254.169.254 cloud metadata),
 * CGNAT, unique-local v6, multicast, reserved, and v4-mapped v6 forms of
 * any of those — is refused.
 */
export function isPublicAddress(ip: string): boolean {
  if (!ipaddr.isValid(ip)) return false;
  let addr = ipaddr.parse(ip);
  if (addr.kind() === 'ipv6' && (addr as ipaddr.IPv6).isIPv4MappedAddress()) {
    addr = (addr as ipaddr.IPv6).toIPv4Address();
  }
  return addr.range() === 'unicast';
}
