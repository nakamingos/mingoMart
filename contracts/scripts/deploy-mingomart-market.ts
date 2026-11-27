/**
 * Deploys the Mingo Mart fixed-price market: Points (optional), the MingoMartMarket implementation
 * and the MingoMartMarketProxy that fronts it, then grants the market POINTS_MANAGER_ROLE and checks
 * the result.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-mingomart-market.ts --network <network>
 *
 * Env (all optional):
 *   POINTS_ADDRESS   Reuse an existing V1MingoMart Points contract instead of deploying one.
 *   MARKET_VERSION   contractVersion passed to initialize (default 1).
 *   NEW_OWNER        Hand everything to this address after deploying (e.g. a hardware wallet):
 *                    market ownership, the ProxyAdmin (upgrade rights) and, for a Points contract
 *                    deployed here, its admin role. The deployer's roles are renounced.
 *   DEPLOY_CONFIRM   Required on any non-local network; must equal the network name.
 *
 * Safety notes (why it's done this way):
 * - The latest implementation is deployed directly at version 1; there is no upgrade history.
 * - MingoMartMarketProxy runs initialize() inside its own constructor, so the proxy is never left
 *   uninitialised (no one can front-run initialize). Its ProxyAdmin is created owned by the deployer.
 * - The implementation's constructor calls _disableInitializers(); this script checks that both the
 *   proxy and the implementation reject a second initialize().
 * - The implementation is checked with OpenZeppelin's upgrade-safety validation before deploying, and
 *   the proxy is registered with the upgrades plugin (forceImport), so later upgrades can be checked
 *   against this storage layout.
 */
import fs from 'fs';
import path from 'path';
import hre, { ethers, upgrades } from 'hardhat';
import type { MingoMartMarket, Points as PointsContract } from '../typechain-types/contracts/V1MingoMart';

const MARKET = 'contracts/V1MingoMart/MingoMartMarket.sol:MingoMartMarket';
const POINTS = 'contracts/V1MingoMart/Points.sol:Points';
const PROXY = 'contracts/V1MingoMart/MingoMartProxy.sol:MingoMartMarketProxy';
// The implementation's only constructor code is _disableInitializers(), which is the safe pattern.
const UPGRADE_OPTS = { kind: 'transparent' as const, unsafeAllow: ['constructor' as const] };
const LOCAL_NETWORKS = new Set(['hardhat', 'localhost']);

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function envAddress(name: string): string | undefined {
  const value = process.env[name]?.trim();
  if (!value) return undefined;
  if (!ethers.isAddress(value) || value === ethers.ZeroAddress) {
    throw new Error(`${name} is not a valid non-zero address: ${value}`);
  }
  return ethers.getAddress(value);
}

/** Expects `call` to revert with InvalidInitialization. */
async function expectInitializeReverts(label: string, call: () => Promise<unknown>) {
  try {
    await call();
  } catch (error: any) {
    const text = `${error?.message ?? ''} ${error?.data ?? ''}`;
    // InvalidInitialization() selector
    if (text.includes('InvalidInitialization') || text.includes('0xf92ee8a9')) return;
    throw new Error(`${label}: initialize reverted for an unexpected reason: ${error?.message}`);
  }
  throw new Error(`${label}: initialize() did NOT revert — contract can be (re)initialised!`);
}

function check(condition: boolean, message: string) {
  if (!condition) throw new Error(`Check failed: ${message}`);
  console.log(`  ✓ ${message}`);
}

async function main() {
  const network = hre.network.name;
  const { chainId } = await ethers.provider.getNetwork();
  const [deployer] = await ethers.getSigners();
  const isLocal = LOCAL_NETWORKS.has(network);

  const existingPoints = envAddress('POINTS_ADDRESS');
  const newOwner = envAddress('NEW_OWNER');
  const version = BigInt(process.env.MARKET_VERSION || '1');

  console.log('=====================================================================');
  console.log(`Network:   ${network} (chainId ${chainId})`);
  console.log(`Deployer:  ${deployer.address} (${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH)`);
  console.log(`Points:    ${existingPoints ?? 'deploy a new one'}`);
  console.log(`Version:   ${version}`);
  console.log(`New owner: ${newOwner ?? '(none — deployer keeps ownership)'}`);
  console.log('=====================================================================');

  if (!isLocal) {
    if (process.env.DEPLOY_CONFIRM !== network) {
      throw new Error(`Refusing to deploy to "${network}" without DEPLOY_CONFIRM=${network}`);
    }
    console.log('Deploying in 15 seconds — Ctrl+C to cancel.');
    await delay(15_000);
  }

  // 1. Points ----------------------------------------------------------------------------------
  const Points = await ethers.getContractFactory(POINTS);
  let points: PointsContract;
  let deployedPoints = false;
  if (existingPoints) {
    points = Points.attach(existingPoints) as PointsContract;
  } else {
    points = (await Points.deploy()) as PointsContract;
    await points.waitForDeployment();
    deployedPoints = true;
    console.log(`Points deployed:          ${await points.getAddress()}`);
  }
  const pointsAddress = await points.getAddress();

  // 2. Market (implementation + proxy, initialised in the proxy constructor) -------------------
  const Market = await ethers.getContractFactory(MARKET);
  await upgrades.validateImplementation(Market, UPGRADE_OPTS);

  const implementation = (await Market.deploy()) as MingoMartMarket;
  await implementation.waitForDeployment();
  const implementationAddress = await implementation.getAddress();

  const Proxy = await ethers.getContractFactory(PROXY);
  const proxy = await Proxy.deploy(implementationAddress, version, pointsAddress);
  await proxy.waitForDeployment();
  const marketAddress = await proxy.getAddress();
  const deployReceipt = await proxy.deploymentTransaction()!.wait();
  const market = Market.attach(marketAddress) as MingoMartMarket;
  const proxyAdminAddress = await upgrades.erc1967.getAdminAddress(marketAddress);

  // Record the proxy in the upgrades plugin's manifest (.openzeppelin/) for future upgrade checks.
  await upgrades.forceImport(marketAddress, Market, UPGRADE_OPTS);
  console.log(`Market proxy deployed:    ${marketAddress}`);
  console.log(`Market implementation:    ${implementationAddress}`);
  console.log(`ProxyAdmin:               ${proxyAdminAddress}`);

  // 3. Points role -----------------------------------------------------------------------------
  const MANAGER_ROLE = await points.POINTS_MANAGER_ROLE();
  const ADMIN_ROLE = await points.DEFAULT_ADMIN_ROLE();
  const canGrant = await points.hasRole(ADMIN_ROLE, deployer.address);
  if (canGrant) {
    await (await points.grantRole(MANAGER_ROLE, marketAddress)).wait();
    console.log('Granted POINTS_MANAGER_ROLE to the market proxy');
  } else {
    console.log('\n!! Deployer is not a Points admin, so the role was NOT granted. A Points admin must call:');
    console.log(`   Points(${pointsAddress}).grantRole(${MANAGER_ROLE}, ${marketAddress})`);
    console.log('   Until then every sale with a fee will revert.\n');
  }

  // 4. Hand over ownership -----------------------------------------------------------------------
  const proxyAdmin = await ethers.getContractAt(
    ['function owner() view returns (address)', 'function transferOwnership(address newOwner)'],
    proxyAdminAddress
  );
  if (newOwner) {
    await (await market.transferOwnership(newOwner)).wait();
    await (await proxyAdmin.transferOwnership(newOwner)).wait();
    if (deployedPoints) {
      await (await points.grantRole(ADMIN_ROLE, newOwner)).wait();
      await (await points.renounceRole(MANAGER_ROLE, deployer.address)).wait();
      await (await points.renounceRole(ADMIN_ROLE, deployer.address)).wait();
    }
    console.log(`Ownership handed to ${newOwner}`);
  }

  // 5. Checks ------------------------------------------------------------------------------------
  console.log('\nChecks:');
  const expectedOwner = newOwner ?? deployer.address;
  check(
    (await upgrades.erc1967.getImplementationAddress(marketAddress)) === implementationAddress,
    'proxy points at the deployed implementation'
  );
  check((await market.owner()) === expectedOwner, `market owner is ${expectedOwner}`);
  check((await proxyAdmin.owner()) === expectedOwner, `ProxyAdmin (upgrade rights) owner is ${expectedOwner}`);
  check((await market.contractVersion()) === version, `contractVersion is ${version}`);
  check((await market.pointsAddress()) === pointsAddress, 'market points address is set');
  check((await market.marketplaceFeeBps()) === BigInt(0), 'marketplace fee starts at 0 bps');
  check(!(await market.paused()), 'market is not paused');
  if (canGrant) check(await points.hasRole(MANAGER_ROLE, marketAddress), 'market proxy holds POINTS_MANAGER_ROLE');
  if (deployedPoints) {
    check(await points.hasRole(ADMIN_ROLE, expectedOwner), `Points admin is ${expectedOwner}`);
    if (newOwner) {
      check(!(await points.hasRole(ADMIN_ROLE, deployer.address)), 'deployer no longer a Points admin');
      check(!(await points.hasRole(MANAGER_ROLE, deployer.address)), 'deployer no longer a Points manager');
    }
  }
  // Throws if the proxy isn't registered in the manifest or the layout check can't run.
  await upgrades.validateUpgrade(marketAddress, Market, UPGRADE_OPTS);
  console.log('  ✓ proxy is registered with the upgrades plugin (future upgrades can be validated)');
  await expectInitializeReverts('proxy', () => market.initialize.staticCall(version, pointsAddress));
  console.log('  ✓ proxy rejects a second initialize()');
  await expectInitializeReverts('implementation', () => implementation.initialize.staticCall(version, pointsAddress));
  console.log('  ✓ implementation rejects initialize() (initializers disabled)');

  // 6. Record ------------------------------------------------------------------------------------
  const record = {
    network,
    chainId: Number(chainId),
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    owner: expectedOwner,
    contractVersion: Number(version),
    market: {
      proxy: marketAddress,
      implementation: implementationAddress,
      proxyAdmin: proxyAdminAddress,
      deployBlock: deployReceipt?.blockNumber ?? null,
    },
    points: { address: pointsAddress, deployedHere: deployedPoints },
  };
  if (network !== 'hardhat') {
    const dir = path.join(__dirname, '..', 'deployments');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `mingomart-market.${network}.json`);
    fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
    console.log(`\nDeployment record written to ${path.relative(process.cwd(), file)}`);
  }

  console.log('\nIndexer env:');
  console.log(`  MARKET_ADDRESS_L1=${marketAddress.toLowerCase()}`);
  console.log(`  POINTS_ADDRESS_L1=${pointsAddress.toLowerCase()}`);
  console.log('Frontend environment:');
  console.log(`  marketAddress: '${marketAddress.toLowerCase()}'`);
  console.log(`  pointsAddress: '${pointsAddress.toLowerCase()}'`);
  if (!isLocal) {
    console.log('\nVerify with:');
    console.log(`  npx hardhat verify --network ${network} --contract ${MARKET} ${implementationAddress}`);
    console.log(
      `  npx hardhat verify --network ${network} --contract ${PROXY} ${marketAddress} ${implementationAddress} ${version} ${pointsAddress}`
    );
    console.log('  (The ProxyAdmin is created by the proxy; Etherscan usually matches it to OpenZeppelin\'s source.)');
    if (deployedPoints) console.log(`  npx hardhat verify --network ${network} --contract ${POINTS} ${pointsAddress}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
