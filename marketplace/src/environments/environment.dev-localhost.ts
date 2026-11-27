import { appConfig } from './app';
import { Environment } from './environment.interface';

/**
 * Local chain profile: `yarn start:localhost`.
 *
 * Talks to a local Anvil chain (chain ID 1337), the local indexer (`yarn start:localhost` in
 * indexer/) and local Supabase. Data lives in the *_sepolia tables, like any non-mainnet chain.
 * Contract addresses are what the deploy script produces as the first thing run on a fresh chain.
 * Everything here is local or public; never put a real key in this file.
 */
export const environment: Environment = {
  ...appConfig,

  env: 'dev-localhost',
  production: false,
  chainId: 1337,

  rpcHttpProvider: 'http://127.0.0.1:8545',
  explorerUrl: '',
  externalMarketUrl: '',

  magmaRpcHttpProvider: 'https://turbo.magma-rpc.com',

  pointsAddress: '0x5fbdb2315678afecb367f032d93f642f64180aa3',
  donationsAddress: '0x0000000000000000000000000000000000000000',
  marketAddress: '0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0',
  marketAddressL2: '0x0000000000000000000000000000000000000000',
  bridgeAddress: '0x0000000000000000000000000000000000000000',
  bridgeAddressL2: '0x0000000000000000000000000000000000000000',
  auctionHouseAddress: '0x0000000000000000000000000000000000000000',

  relayUrl: 'http://localhost:3003',
  staticUrl: 'http://127.0.0.1:54321/storage/v1/object/public',

  supabaseUrl: 'http://127.0.0.1:54321',
  // Supabase CLI's standard local anon key
  supabaseKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0',
};
