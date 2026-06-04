import { describe, it, expect } from 'vitest';
import { createPinnedLookup } from '../../src/tools/payments.js';

/** Proves the DNS-rebinding pin: the lookup returns ONLY the pre-validated public IP(s),
 *  regardless of the hostname an attacker-controlled DNS record might (re)resolve to. */
describe('createPinnedLookup (F9 DNS-rebinding pin)', () => {
  it('resolves to the validated pinned IP, ignoring the hostname (single-address form)', () => {
    const lookup = createPinnedLookup(['203.0.113.7']);
    let captured: { err: unknown; address: unknown; family: unknown } | undefined;
    lookup('attacker-rebound.example', undefined, (err, address, family) => {
      captured = { err, address, family };
    });
    // Even though the host "could" rebind to 169.254.x at connect time, the socket is
    // forced to the pre-validated public IP.
    expect(captured).toEqual({ err: null, address: '203.0.113.7', family: 4 });
  });

  it('returns all pinned IPs in the { all } form, never an attacker-resolved address', () => {
    const lookup = createPinnedLookup(['203.0.113.7', '198.51.100.9']);
    let addresses: unknown;
    lookup('attacker-rebound.example', { all: true }, (_err, addr) => {
      addresses = addr;
    });
    expect(addresses).toEqual([
      { address: '203.0.113.7', family: 4 },
      { address: '198.51.100.9', family: 4 },
    ]);
  });
});
