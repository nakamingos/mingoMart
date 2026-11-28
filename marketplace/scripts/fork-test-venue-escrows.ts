/**
 * Mainnet-fork test for the other-market actions the frontend offers (withdraw, batch withdraw,
 * delist, claim proceeds), using the exact ABIs the frontend sends
 * (marketplace/src/app/constants/escrow-venue-abis.ts) and real depositors.
 *
 * Nothing touches mainnet: it needs an Anvil fork, and impersonating accounts only works there.
 *
 *   anvil --fork-url <mainnet RPC> --port 8546
 *   npx esbuild scripts/fork-test-venue-escrows.ts --bundle --platform=node --format=esm --outfile=/tmp/fork-test.mjs
 *   node /tmp/fork-test.mjs <fixtures.json>
 *
 * fixtures.json (pick current depositors from the DB; items must still be escrowed on the fork):
 *   {
 *     "etherphunks":  { "depositor": "0x…", "hashIds": ["0x…", …], "listed": "0x…" | null },
 *     "etch":         { "depositor": "0x…", "hashIds": ["0x…", "0x…"] },
 *     "ethscriptions":{ "depositor": "0x…", "hashIds": ["0x…"] },
 *     "etherphunksSellers": ["0x…", …]   // candidates for unclaimed proceeds
 *   }
 */
import { readFileSync } from 'fs';
import {
  createPublicClient, createTestClient, createWalletClient, http, keccak256, parseAbi, parseEther, toBytes,
  type Hex,
} from 'viem';
import { mainnet } from 'viem/chains';

import {
  etchMarketAbi, etherPhunksMarketAbi, ethscriptionsMarketAbi,
} from '../src/app/constants/escrow-venue-abis';

const RPC_URL = process.env.FORK_RPC_URL || 'http://127.0.0.1:8546';
const ETHERPHUNKS = '0xd3418772623be1a3cc6b6d45cb46420cedd9154a' as Hex;
const ETCH = '0x57b8792c775d34aa96092400983c3e112fcbc296' as Hex;
const ETHSCRIPTIONS = '0xd729a94d6366a4feac4a6869c8b3573cee4701a9' as Hex;
const STRANGER = '0x000000000000000000000000000000000000dead' as Hex;
const ESIP2_TOPIC = keccak256(toBytes('ethscriptions_protocol_TransferEthscriptionForPreviousOwner(address,address,bytes32)'));

/** Read-only helpers for checking state; not used by the frontend. */
const etherPhunksReadAbi = parseAbi([
  'function phunksOfferedForSale(bytes32) view returns (bool isForSale, bytes32 phunkId, address seller, uint256 minValue, address onlySellTo)',
]);

type RawLog = { address: string; topics: readonly Hex[] };

let failures = 0;
function check(condition: boolean, message: string, detail?: unknown) {
  if (condition) return console.log(`  ✓ ${message}`);
  failures++;
  console.log(`  ✗ ${message}`);
  if (detail !== undefined) console.log('      got:', detail);
}

const transport = http(RPC_URL);
const publicClient = createPublicClient({ chain: mainnet, transport });
const testClient = createTestClient({ chain: mainnet, mode: 'anvil', transport });

/** Impersonates `address`, topping it up for gas only when low (so balance checks stay exact). */
async function asAccount(address: Hex) {
  await testClient.impersonateAccount({ address });
  if (await publicClient.getBalance({ address }) < parseEther('1')) {
    await testClient.setBalance({ address, value: parseEther('10') });
  }
  return createWalletClient({ account: address, chain: mainnet, transport }) as any;
}

/** Sends a call from `from` and returns the receipt (throws on revert). */
async function send(from: Hex, address: Hex, abi: readonly unknown[], functionName: string, args: unknown[]) {
  const wallet = await asAccount(from);
  const { request } = await publicClient.simulateContract({ account: from, address, abi: abi as any, functionName, args } as any);
  const hash: Hex = await wallet.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`${functionName} reverted`);
  // viem's receipt log type here omits topics, which the RPC does return.
  return receipt as typeof receipt & { logs: RawLog[] };
}

async function reverts(from: Hex, address: Hex, abi: readonly unknown[], functionName: string, args: unknown[]) {
  try {
    await publicClient.simulateContract({ account: from, address, abi: abi as any, functionName, args } as any);
    return false;
  } catch {
    return true;
  }
}

/** ESIP-2 releases in `logs` emitted by `venue`. */
function releases(logs: readonly RawLog[], venue: Hex) {
  const address = (topic?: Hex) => ('0x' + (topic ?? '').slice(-40)).toLowerCase();
  return logs
    .filter((log) => log.address.toLowerCase() === venue && log.topics[0] === ESIP2_TOPIC)
    .map((log) => ({ previousOwner: address(log.topics[1]), recipient: address(log.topics[2]), hashId: log.topics[3]!.toLowerCase() }));
}

function releasedTo(logs: readonly RawLog[], venue: Hex, depositor: string, hashIds: string[]) {
  const got = releases(logs, venue);
  return hashIds.every((hashId) => got.some((r) =>
    r.hashId === hashId.toLowerCase() && r.previousOwner === depositor.toLowerCase() && r.recipient === depositor.toLowerCase()));
}

async function main() {
  const fixtures = JSON.parse(readFileSync(process.argv[2], 'utf8'));

  const chainId = await publicClient.getChainId();
  if (chainId !== 1) throw new Error(`Expected a mainnet fork, got chain ${chainId}`);
  await testClient.getAutomine().catch(() => { throw new Error(`${RPC_URL} is not an Anvil fork`); });
  console.log(`Fork at block ${await publicClient.getBlockNumber()}\n`);

  // EtherPhunks -----------------------------------------------------------------------------------
  {
    const { depositor, hashIds, listed } = fixtures.etherphunks;
    console.log(`EtherPhunks (depositor ${depositor}, ${hashIds.length} items)`);
    check(await reverts(STRANGER, ETHERPHUNKS, etherPhunksMarketAbi, 'withdrawPhunk', [hashIds[0]]),
      'someone else cannot withdraw the item (reverts)');

    if (listed) {
      const before = await publicClient.readContract({ address: ETHERPHUNKS, abi: etherPhunksReadAbi, functionName: 'phunksOfferedForSale', args: [listed] });
      check(before[0] === true, 'the listed item is for sale before delisting', before);
      await send(depositor, ETHERPHUNKS, etherPhunksMarketAbi, 'phunkNoLongerForSale', [listed]);
      const after = await publicClient.readContract({ address: ETHERPHUNKS, abi: etherPhunksReadAbi, functionName: 'phunksOfferedForSale', args: [listed] });
      check(after[0] === false, 'phunkNoLongerForSale delists it (item stays in escrow)', after);
    }

    const [first, ...rest] = hashIds as Hex[];
    const single = await send(depositor, ETHERPHUNKS, etherPhunksMarketAbi, 'withdrawPhunk', [first]);
    check(releasedTo(single.logs, ETHERPHUNKS, depositor, [first]), 'withdrawPhunk releases the item to the depositor');
    if (rest.length) {
      const batch = await send(depositor, ETHERPHUNKS, etherPhunksMarketAbi, 'withdrawBatchPhunks', [rest]);
      check(releasedTo(batch.logs, ETHERPHUNKS, depositor, rest), `withdrawBatchPhunks releases ${rest.length} item(s) to the depositor`);
    }

    let claimed = false;
    for (const seller of fixtures.etherphunksSellers as Hex[]) {
      const pending = await publicClient.readContract({ address: ETHERPHUNKS, abi: etherPhunksMarketAbi, functionName: 'pendingWithdrawals', args: [seller] });
      if (pending === BigInt(0)) continue;
      await asAccount(seller);
      const balanceBefore = await publicClient.getBalance({ address: seller });
      const receipt = await send(seller, ETHERPHUNKS, etherPhunksMarketAbi, 'withdraw', []);
      const balanceAfter = await publicClient.getBalance({ address: seller });
      const gas = receipt.gasUsed * receipt.effectiveGasPrice;
      const left = await publicClient.readContract({ address: ETHERPHUNKS, abi: etherPhunksMarketAbi, functionName: 'pendingWithdrawals', args: [seller] });
      check(balanceAfter - balanceBefore + gas === pending && left === BigInt(0),
        `withdraw() pays a seller their unclaimed ${Number(pending) / 1e18} ETH`);
      claimed = true;
      break;
    }
    if (!claimed) console.log('  - no candidate seller has unclaimed proceeds; claim not exercised');
  }

  // Etch -----------------------------------------------------------------------------------------
  {
    const { depositor, hashIds } = fixtures.etch;
    console.log(`\nEtch (depositor ${depositor}, ${hashIds.length} items)`);
    const [first, ...rest] = hashIds as Hex[];
    const stranger = await send(STRANGER, ETCH, etchMarketAbi, 'withdrawEthscription', [first, BigInt(0), '0x']);
    check(!releasedTo(stranger.logs, ETCH, depositor, [first]),
      'a stranger\'s call "succeeds" but names the stranger, not the depositor (indexers ignore it)');
    const single = await send(depositor, ETCH, etchMarketAbi, 'withdrawEthscription', [first, BigInt(0), '0x']);
    check(releasedTo(single.logs, ETCH, depositor, [first]), 'withdrawEthscription(id, 0, 0x) releases the item to the depositor');
    if (rest.length) {
      const batch = await send(depositor, ETCH, etchMarketAbi, 'withdrawMultipleEthscriptions', [rest, BigInt(0), '0x']);
      check(releasedTo(batch.logs, ETCH, depositor, rest), `withdrawMultipleEthscriptions releases ${rest.length} item(s) to the depositor`);
    }
  }

  // ethscriptions.com ----------------------------------------------------------------------------
  {
    const { depositor, hashIds } = fixtures.ethscriptions;
    console.log(`\nEthscriptions.com (depositor ${depositor})`);
    const enabled = await publicClient.readContract({ address: ETHSCRIPTIONS, abi: ethscriptionsMarketAbi, functionName: 'featureIsEnabled', args: ['withdraw'] });
    check(enabled === true, 'withdrawals are switched on', enabled);
    check(await reverts(STRANGER, ETHSCRIPTIONS, ethscriptionsMarketAbi, 'withdrawEthscription', [hashIds[0]]),
      'someone else cannot withdraw the item (reverts)');
    const receipt = await send(depositor, ETHSCRIPTIONS, ethscriptionsMarketAbi, 'withdrawEthscription', [hashIds[0]]);
    check(releasedTo(receipt.logs, ETHSCRIPTIONS, depositor, [hashIds[0]]), 'withdrawEthscription releases the item to the depositor');
  }

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
  if (failures) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
