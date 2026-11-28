import { parseAbi } from 'viem';

// Kept free of app imports so scripts can use the exact ABIs the frontend sends.

/** Deployed EtherPhunksMarketV2_1 (behind a proxy). Not the ...V2 functions in V2_2.sol, which were never deployed. */
export const etherPhunksMarketAbi = parseAbi([
  'function withdrawPhunk(bytes32 phunkId)',
  'function withdrawBatchPhunks(bytes32[] phunkIds)',
  'function phunkNoLongerForSale(bytes32 phunkId)',
  'function withdraw()',
  'function pendingWithdrawals(address) view returns (uint256)',
]);

/**
 * Etch's market (implementation unverified). With Etch's backend gone, expiration 0 and an empty
 * signature are accepted. The contract does not check the caller: it emits an ESIP-2 transfer back
 * to msg.sender, which only takes effect when msg.sender really deposited the item, so only offer
 * this to the item's previous owner.
 */
export const etchMarketAbi = parseAbi([
  'function withdrawEthscription(bytes32 ethscriptionId, uint64 expiration, bytes trustedSign)',
  'function withdrawMultipleEthscriptions(bytes32[] ethscriptionIds, uint64 expiration, bytes trustedSign)',
]);

/** ethscriptions.com's EthscriptionsMarketV3. Withdrawals are behind its 'withdraw' feature flag. */
export const ethscriptionsMarketAbi = parseAbi([
  'function withdrawEthscription(bytes32 ethscriptionId)',
  'function featureIsEnabled(string feature) view returns (bool)',
]);
