import { describe, it, expect } from 'vitest';
import { validatePrivateKey, validateAddress } from '../../src/utils/client.js';

describe('validatePrivateKey', () => {
  it('accepts a valid 0x-prefixed 64-char hex key', () => {
    const key =
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
    expect(validatePrivateKey(key)).toBe(true);
  });

  it('accepts uppercase hex characters', () => {
    const key =
      '0xAC0974BEC39A17E36BA4A6B4D238FF944BACB478CBED5EFCAE784D7BF4F2FF80';
    expect(validatePrivateKey(key)).toBe(true);
  });

  it('accepts mixed-case hex characters', () => {
    const key =
      '0xAc0974bec39a17E36ba4a6b4d238ff944bacb478cbed5efcAE784d7bf4f2ff80';
    expect(validatePrivateKey(key)).toBe(true);
  });

  it('rejects key without 0x prefix', () => {
    const key =
      'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
    expect(validatePrivateKey(key)).toBe(false);
  });

  it('rejects key that is too short', () => {
    const key =
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff';
    expect(validatePrivateKey(key)).toBe(false);
  });

  it('rejects key that is too long', () => {
    const key =
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff8000';
    expect(validatePrivateKey(key)).toBe(false);
  });

  it('rejects key with non-hex characters', () => {
    const key =
      '0xzz0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
    expect(validatePrivateKey(key)).toBe(false);
  });

  it('rejects empty string', () => {
    expect(validatePrivateKey('')).toBe(false);
  });

  it('rejects just the prefix', () => {
    expect(validatePrivateKey('0x')).toBe(false);
  });

  it('rejects an Ethereum address (40 hex chars, not 64)', () => {
    expect(
      validatePrivateKey('0x70997970C51812dc3A010C7d01b50e0d17dc79C8'),
    ).toBe(false);
  });
});

describe('validateAddress', () => {
  it('accepts a valid 0x-prefixed 40-char hex address', () => {
    const addr = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
    expect(validateAddress(addr)).toBe(true);
  });

  it('accepts all-lowercase address', () => {
    const addr = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
    expect(validateAddress(addr)).toBe(true);
  });

  it('accepts all-uppercase address', () => {
    const addr = '0x70997970C51812DC3A010C7D01B50E0D17DC79C8';
    expect(validateAddress(addr)).toBe(true);
  });

  it('rejects address without 0x prefix', () => {
    const addr = '70997970C51812dc3A010C7d01b50e0d17dc79C8';
    expect(validateAddress(addr)).toBe(false);
  });

  it('rejects address that is too short', () => {
    const addr = '0x70997970C51812dc3A010C7d01b50e0d17dc79C';
    expect(validateAddress(addr)).toBe(false);
  });

  it('rejects address that is too long', () => {
    const addr = '0x70997970C51812dc3A010C7d01b50e0d17dc79C800';
    expect(validateAddress(addr)).toBe(false);
  });

  it('rejects address with non-hex characters', () => {
    const addr = '0xzz997970C51812dc3A010C7d01b50e0d17dc79C8';
    expect(validateAddress(addr)).toBe(false);
  });

  it('rejects empty string', () => {
    expect(validateAddress('')).toBe(false);
  });

  it('rejects a private key (64 hex chars, not 40)', () => {
    expect(
      validateAddress(
        '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
      ),
    ).toBe(false);
  });
});
