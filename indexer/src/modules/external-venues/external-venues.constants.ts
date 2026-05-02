export const ETHSCRIPTIONS_MARKET_ADDRESS_L1 = '0xd729a94d6366a4feac4a6869c8b3573cee4701a9' as const;
export const ETCH_MARKET_ADDRESS_L1 = '0x57b8792c775d34aa96092400983c3e112fcbc296' as const;
export const ETCH_MARKET_ORDER_EXECUTED_TOPIC = '0x93a6900c7e12c8592eb245abc171ff4709f08fcba2e290729cd16cfe71380260' as const;
export const ETHSCRIPTIONS_TRANSFER_PROXY_ADDRESS_L1 = '0xc33f8610941be56fb0d84e25894c0d928cc97dde' as const;
export const ETHSCRIPTIONS_TRANSFER_PROXY_INTERNAL_TRANSFER_TOPIC = '0xefeb5fded3e317a54beb4e7acfa51f2f2c8545f4c53ab5c96f67d85799a4bb1a' as const;
export const ORDEX_MARKET_ADDRESS_L1 = '0xc89c2e6fe008592d6a787efd02db7fdb8ea64020' as const;
export const ETH_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

export const SUPPORTED_ETHSCRIPTIONS_MARKET_EVENTS = new Set([
  'EthscriptionPurchased',
]);

export const SUPPORTED_ETCH_MARKET_EVENTS = new Set([
  'EthscriptionOrderExecuted',
]);

export const SUPPORTED_ETHSCRIPTIONS_TRANSFER_PROXY_EVENTS = new Set([
  'InternalItemTransfer',
]);

export const ethscriptionsMarketL1 = [
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'address',
        name: 'seller',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'buyer',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'bytes32',
        name: 'ethscriptionId',
        type: 'bytes32',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'price',
        type: 'uint256',
      },
      {
        indexed: false,
        internalType: 'bytes32',
        name: 'listingId',
        type: 'bytes32',
      },
    ],
    name: 'EthscriptionPurchased',
    type: 'event',
  },
] as const;

export const etchMarketL1 = [
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'bytes32',
        name: 'orderHash',
        type: 'bytes32',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'orderNonce',
        type: 'uint256',
      },
      {
        indexed: false,
        internalType: 'bytes32',
        name: 'ethscriptionId',
        type: 'bytes32',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'quantity',
        type: 'uint256',
      },
      {
        indexed: false,
        internalType: 'address',
        name: 'seller',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'address',
        name: 'buyer',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'address',
        name: 'currency',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'price',
        type: 'uint256',
      },
      {
        indexed: false,
        internalType: 'uint64',
        name: 'endTime',
        type: 'uint64',
      },
    ],
    name: 'EthscriptionOrderExecuted',
    type: 'event',
  },
] as const;

export const ethscriptionsTransferProxyL1 = [
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'address',
        name: 'from',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'to',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'uint256',
        name: 'itemId',
        type: 'uint256',
      },
    ],
    name: 'InternalItemTransfer',
    type: 'event',
  },
] as const;

export const ordexMarketL1 = [
  {
    anonymous: false,
    inputs: [
      {
        indexed: false,
        internalType: 'bytes32',
        name: 'leftHash',
        type: 'bytes32',
      },
      {
        indexed: false,
        internalType: 'bytes32',
        name: 'rightHash',
        type: 'bytes32',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'newLeftFill',
        type: 'uint256',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'newRightFill',
        type: 'uint256',
      },
    ],
    name: 'Match',
    type: 'event',
  },
] as const;
