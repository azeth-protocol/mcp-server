/**
 * Pre-computed 4-byte error selectors for Azeth contracts.
 * Maps selector hex (0x + 8 chars) → human-readable name + description.
 *
 * Selectors are derived from keccak256 of each custom error signature.
 * Pre-computed to avoid runtime dependency on viem's keccak256 (which
 * breaks in test environments where viem is mocked).
 *
 * To regenerate: `pnpm exec tsx scripts/compute-selectors.ts`
 */

interface ErrorInfo {
  name: string;
  description: string;
  suggestion?: string;
}

/** Decoded error with human-readable message and optional remediation suggestion */
export interface DecodedError {
  message: string;
  suggestion?: string;
}

/** Pre-computed selector → error info */
const SELECTOR_MAP: Record<string, ErrorInfo | undefined> = {
  // AzethAccount
  '0xacfdb444': { name: 'ExecutionFailed', description: 'Smart account execution failed.' },
  '0x5fc483c5': { name: 'OnlyOwner', description: 'Only the account owner can perform this action.' },
  '0xbd07c551': { name: 'OnlyEntryPoint', description: 'Only the EntryPoint contract can call this function.' },
  '0x7fb6be02': { name: 'OnlyExecutor', description: 'Only an installed executor module can call this function.' },
  '0xea8e4eb5': { name: 'NotAuthorized', description: 'The caller is not authorized for this operation.' },
  '0x49e27cff': { name: 'InvalidOwner', description: 'Invalid owner address.' },
  '0x17e37b5c': { name: 'BatchLengthMismatch', description: 'Batch call arrays have mismatched lengths.' },
  '0xcfc917be': { name: 'MaxHooksReached', description: 'Maximum number of hooks already installed.' },
  '0xd393448a': { name: 'MismatchModuleTypeId', description: 'Module type ID does not match the expected type.' },
  '0x172c3c6a': { name: 'ModuleAlreadyInstalled', description: 'This module is already installed on the account.' },
  '0xbe601672': { name: 'ModuleNotInstalled', description: 'This module is not installed on the account.' },

  // GuardianModule
  '0xaf9aa1e0': { name: 'NotSmartAccount', description: 'The caller is not a recognized Azeth smart account.' },
  '0xef6d0f02': { name: 'NotGuardian', description: 'Only the guardian can perform this operation.' },
  '0x5684d698': { name: 'InvalidGuardrails', description: 'The guardrail parameters are invalid.' },
  '0xa3fef2f8': { name: 'NoPendingChange', description: 'No guardrail change is pending.' },
  '0x621e25c3': { name: 'TimelockNotExpired', description: 'The timelock period has not elapsed yet.' },
  '0x0bbfcdcc': { name: 'NotTightening', description: 'Only tightening (reducing limits) can bypass the timelock.' },
  '0x6320ab2b': { name: 'NoPendingEmergency', description: 'No emergency withdrawal is pending.' },
  '0x4806710a': { name: 'ChangeAlreadyPending', description: 'A guardrail change is already pending.' },
  '0x24831e77': { name: 'ExecutorSpendExceedsLimit', description: 'Payment amount exceeds the guardian daily spend limit.', suggestion: 'Check your limits with azeth_get_guardrails. Wait until tomorrow or increase the daily limit via the guardian.' },

  // PaymentAgreementModule
  '0x95a68634': { name: 'SelfAgreement', description: 'Cannot create a payment agreement with yourself.' },
  '0xf84835a0': { name: 'TokenNotWhitelisted', description: 'The token is not in the guardian whitelist.', suggestion: 'Use azeth_whitelist_token to add the token to your guardian whitelist before retrying.' },
  '0xb5c6c3ab': { name: 'AgreementNotExists', description: 'The specified agreement does not exist.' },
  '0xfe1da89a': { name: 'InvalidAgreement', description: 'The agreement is invalid (already cancelled or completed).' },
  '0x9563bcf0': { name: 'GuardianLimitExceeded', description: 'The payment exceeds guardian spending limits.', suggestion: 'Check your limits with azeth_get_guardrails. Split into smaller amounts or increase limits via the guardian.' },
  '0x90b8ec18': { name: 'TransferFailed', description: 'The token transfer failed.' },

  // ReputationModule
  '0xae525b83': { name: 'InsufficientPaymentUSD', description: 'You must pay at least $1 USD to the target before rating.', suggestion: 'Payments via azeth_pay, azeth_smart_pay, azeth_transfer, and payment agreements all count toward the $1 minimum. Use azeth_get_net_paid to check your payment history.' },
  '0xcb02f599': { name: 'SelfRatingNotAllowed', description: 'You cannot rate yourself.' },
  '0x645c0b06': { name: 'SiblingRatingNotAllowed', description: 'You cannot rate accounts owned by the same EOA.' },
  '0x565c8a5a': { name: 'InvalidValueDecimals', description: 'Value decimals must be between 0 and 18.' },
  '0xe6394a77': { name: 'InvalidAgentId', description: 'The agent ID is not registered in the trust registry.' },
  '0x15bebd27': { name: 'NotAzethAccount', description: 'The caller is not an Azeth smart account deployed by the factory.' },

  // TrustRegistryModule
  '0x3a81d6fc': { name: 'AlreadyRegistered', description: 'This account is already registered in the trust registry.' },
  '0xaba47339': { name: 'NotRegistered', description: 'This account is not registered in the trust registry.' },
  '0x3ba01911': { name: 'InvalidURI', description: 'The metadata URI is invalid.' },

  // Factory
  '0x30116425': { name: 'DeploymentFailed', description: 'Smart account deployment failed.' },
  '0x367e9639': { name: 'AccountAlreadyDeployed', description: 'A smart account is already deployed at this address.' },
  '0x99d0d56b': { name: 'MaxAccountsPerOwnerReached', description: 'Maximum accounts per owner has been reached.' },

  // Oracle
  '0x1f8f95a0': { name: 'InvalidOraclePrice', description: 'The oracle returned an invalid price.' },
  '0xbf16aab6': { name: 'UnsupportedToken', description: 'The oracle does not support this token.' },
  '0xf4d678b8': { name: 'InsufficientBalance', description: 'The smart account has insufficient token balance for this operation.', suggestion: 'Use azeth_deposit to fund your smart account, or use the smartAccount parameter to select a different account. Run azeth_accounts to see all your accounts and their balances.' },

  // Common (shared across multiple contracts)
  '0x0dc149f0': { name: 'AlreadyInitialized', description: 'This module is already initialized for the account.' },
  '0x87138d5c': { name: 'NotInitialized', description: 'The account has not been initialized on this module.' },
  '0xe6c4247b': { name: 'InvalidAddress', description: 'An invalid address was provided.' },
  '0x0c6d42ae': { name: 'OnlyFactory', description: 'Only the AzethFactory can call this function.' },
};

/** Well-known Solidity revert selectors (not Azeth-specific) */
const ERROR_STRING_SELECTOR = '08c379a0'; // Error(string)
const PANIC_SELECTOR = '4e487b71';         // Panic(uint256)

/** Attempt to decode a 4-byte error selector from an error message string.
 *  Returns a human-readable description if a known selector is found.
 *
 *  Handles three cases:
 *  1. Standalone selectors: 0x1f8f95a0
 *  2. Outer selector of long hex: first 8 chars of 0x1f8f95a0000000...
 *  3. Inner selectors in ABI-encoded revert data: EntryPoint wraps module errors
 *     in FailedOpWithRevert(uint256,string,bytes), so the actual Azeth error
 *     selector is buried inside the hex at a 32-byte ABI boundary.
 *  4. Error(string) decoding: extracts the revert string from standard Solidity reverts
 */
export function decodeErrorSelector(message: string): DecodedError | undefined {
  const hexMatches = message.matchAll(/0x([0-9a-fA-F]{8,})/g);
  for (const match of hexMatches) {
    const hexData = match[1]!.toLowerCase();

    // Pass 1: Check the outer selector (first 8 chars)
    const outerSelector = `0x${hexData.slice(0, 8)}`;
    const outerKnown = SELECTOR_MAP[outerSelector];
    if (outerKnown) return { message: `${outerKnown.name}: ${outerKnown.description}`, suggestion: outerKnown.suggestion };

    // Pass 1b: Try to decode Error(string) at the outer level
    const outerString = tryDecodeErrorString(hexData);
    if (outerString) return { message: outerString };

    // Pass 2: Scan interior at 64-char (32-byte) ABI word boundaries for known
    // selectors. ERC-4337 EntryPoint wraps inner reverts in FailedOpWithRevert
    // where the actual error selector is ABI-encoded at a word boundary.
    for (let i = 64; i + 8 <= hexData.length; i += 64) {
      const innerSelector = `0x${hexData.slice(i, i + 8)}`;
      const innerKnown = SELECTOR_MAP[innerSelector];
      if (innerKnown) return { message: `${innerKnown.name}: ${innerKnown.description}`, suggestion: innerKnown.suggestion };

      // Try to decode inner Error(string) — common in EntryPoint FailedOpWithRevert
      const innerString = tryDecodeErrorString(hexData.slice(i));
      if (innerString) return { message: innerString };
    }
  }
  return undefined;
}

/** Try to ABI-decode an Error(string) or Panic(uint256) from raw hex data.
 *  Returns a human-readable string if successful, undefined otherwise.
 *
 *  Error(string) layout: 08c379a0 + offset(32B) + length(32B) + utf8 data
 *  Panic(uint256) layout: 4e487b71 + code(32B)
 */
function tryDecodeErrorString(hexData: string): string | undefined {
  const selector = hexData.slice(0, 8);

  if (selector === ERROR_STRING_SELECTOR && hexData.length >= 8 + 128) {
    // Error(string): skip selector(8) + offset(64), read length(64), then string data
    try {
      const lengthHex = hexData.slice(72, 136);
      const length = parseInt(lengthHex, 16);
      if (length > 0 && length <= 256 && hexData.length >= 136 + length * 2) {
        const strHex = hexData.slice(136, 136 + length * 2);
        const bytes = new Uint8Array(length);
        for (let i = 0; i < length; i++) {
          bytes[i] = parseInt(strHex.slice(i * 2, i * 2 + 2), 16);
        }
        const decoded = new TextDecoder().decode(bytes);
        // Only return if it's printable ASCII (not garbage)
        if (/^[\x20-\x7E]+$/.test(decoded)) {
          return `Revert: ${decoded}`;
        }
      }
    } catch {
      // Malformed — fall through
    }
  }

  if (selector === PANIC_SELECTOR && hexData.length >= 72) {
    const codeHex = hexData.slice(8, 72);
    const code = parseInt(codeHex, 16);
    const panicReasons: Record<number, string> = {
      0x00: 'generic compiler panic',
      0x01: 'assertion failed',
      0x11: 'arithmetic overflow/underflow',
      0x12: 'division by zero',
      0x21: 'invalid enum value',
      0x22: 'invalid storage encoding',
      0x31: 'empty array pop',
      0x32: 'array index out of bounds',
      0x41: 'out of memory',
      0x51: 'invalid internal function call',
    };
    return `Panic(${code}): ${panicReasons[code] ?? 'unknown panic code'}`;
  }

  return undefined;
}
