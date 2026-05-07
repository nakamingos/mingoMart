export const ETHSCRIPTIONS_MARKET_ADDRESS_L1 = '0xd729a94d6366a4feac4a6869c8b3573cee4701a9' as const;
export const ETCH_MARKET_ADDRESS_L1 = '0x57b8792c775d34aa96092400983c3e112fcbc296' as const;
export const ETCH_MARKET_ORDER_EXECUTED_TOPIC = '0x93a6900c7e12c8592eb245abc171ff4709f08fcba2e290729cd16cfe71380260' as const;
export const ETHSCRIPTIONS_TRANSFER_PROXY_ADDRESS_L1 = '0xc33f8610941be56fb0d84e25894c0d928cc97dde' as const;
export const ETHSCRIPTIONS_TRANSFER_PROXY_INTERNAL_TRANSFER_TOPIC = '0xefeb5fded3e317a54beb4e7acfa51f2f2c8545f4c53ab5c96f67d85799a4bb1a' as const;
export const ORDEX_MARKET_ADDRESS_L1 = '0xc89c2e6fe008592d6a787efd02db7fdb8ea64020' as const;
export const EMBLEM_VAULT_WRAPPER_ADDRESS_L1 = '0x8c3c0274c33f263f0a55d129cfc8eaa3667a9e8b' as const;
export const EMBLEM_VAULT_METADATA_BASE_URL = 'https://v2.emblemvault.io/meta' as const;
export const BLUR_EXCHANGE_ADDRESS_L1 = '0x000000000000ad05ccc4f10045630fb830b95127' as const;
export const ETH_ADDRESS = '0x0000000000000000000000000000000000000000' as const;
export const WETH_ADDRESS_L1 = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' as const;

export const OPENSEA_SEAPORT_ADDRESSES_L1 = new Set([
  '0x0000000000000068f116a894984e2db1123eb395',
  '0x00000000000000adc04c56bf30ac9d3c0aaf14dc',
  '0x00000000000001ad428e4906ae43d8f9852d0dd6',
  '0x00000000006c3852cbef3e08e8df289169ede581',
]);

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

export const seaportL1 = [
  {
    anonymous: false,
    inputs: [
      {
        indexed: false,
        internalType: 'bytes32',
        name: 'orderHash',
        type: 'bytes32',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'offerer',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'zone',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'address',
        name: 'recipient',
        type: 'address',
      },
      {
        components: [
          {
            internalType: 'enum ItemType',
            name: 'itemType',
            type: 'uint8',
          },
          {
            internalType: 'address',
            name: 'token',
            type: 'address',
          },
          {
            internalType: 'uint256',
            name: 'identifier',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'amount',
            type: 'uint256',
          },
        ],
        indexed: false,
        internalType: 'struct SpentItem[]',
        name: 'offer',
        type: 'tuple[]',
      },
      {
        components: [
          {
            internalType: 'enum ItemType',
            name: 'itemType',
            type: 'uint8',
          },
          {
            internalType: 'address',
            name: 'token',
            type: 'address',
          },
          {
            internalType: 'uint256',
            name: 'identifier',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'amount',
            type: 'uint256',
          },
          {
            internalType: 'address payable',
            name: 'recipient',
            type: 'address',
          },
        ],
        indexed: false,
        internalType: 'struct ReceivedItem[]',
        name: 'consideration',
        type: 'tuple[]',
      },
    ],
    name: 'OrderFulfilled',
    type: 'event',
  },
] as const;

export const blurExchangeL1 = [
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'address',
        name: 'maker',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'taker',
        type: 'address',
      },
      {
        components: [
          {
            internalType: 'address',
            name: 'trader',
            type: 'address',
          },
          {
            internalType: 'enum Side',
            name: 'side',
            type: 'uint8',
          },
          {
            internalType: 'address',
            name: 'matchingPolicy',
            type: 'address',
          },
          {
            internalType: 'address',
            name: 'collection',
            type: 'address',
          },
          {
            internalType: 'uint256',
            name: 'tokenId',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'amount',
            type: 'uint256',
          },
          {
            internalType: 'address',
            name: 'paymentToken',
            type: 'address',
          },
          {
            internalType: 'uint256',
            name: 'price',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'listingTime',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'expirationTime',
            type: 'uint256',
          },
          {
            components: [
              {
                internalType: 'uint16',
                name: 'rate',
                type: 'uint16',
              },
              {
                internalType: 'address',
                name: 'recipient',
                type: 'address',
              },
            ],
            internalType: 'struct Fee[]',
            name: 'fees',
            type: 'tuple[]',
          },
          {
            internalType: 'uint256',
            name: 'salt',
            type: 'uint256',
          },
          {
            internalType: 'bytes',
            name: 'extraParams',
            type: 'bytes',
          },
        ],
        indexed: false,
        internalType: 'struct Order',
        name: 'sell',
        type: 'tuple',
      },
      {
        indexed: false,
        internalType: 'bytes32',
        name: 'sellHash',
        type: 'bytes32',
      },
      {
        components: [
          {
            internalType: 'address',
            name: 'trader',
            type: 'address',
          },
          {
            internalType: 'enum Side',
            name: 'side',
            type: 'uint8',
          },
          {
            internalType: 'address',
            name: 'matchingPolicy',
            type: 'address',
          },
          {
            internalType: 'address',
            name: 'collection',
            type: 'address',
          },
          {
            internalType: 'uint256',
            name: 'tokenId',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'amount',
            type: 'uint256',
          },
          {
            internalType: 'address',
            name: 'paymentToken',
            type: 'address',
          },
          {
            internalType: 'uint256',
            name: 'price',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'listingTime',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'expirationTime',
            type: 'uint256',
          },
          {
            components: [
              {
                internalType: 'uint16',
                name: 'rate',
                type: 'uint16',
              },
              {
                internalType: 'address',
                name: 'recipient',
                type: 'address',
              },
            ],
            internalType: 'struct Fee[]',
            name: 'fees',
            type: 'tuple[]',
          },
          {
            internalType: 'uint256',
            name: 'salt',
            type: 'uint256',
          },
          {
            internalType: 'bytes',
            name: 'extraParams',
            type: 'bytes',
          },
        ],
        indexed: false,
        internalType: 'struct Order',
        name: 'buy',
        type: 'tuple',
      },
      {
        indexed: false,
        internalType: 'bytes32',
        name: 'buyHash',
        type: 'bytes32',
      },
    ],
    name: 'OrdersMatched',
    type: 'event',
  },
] as const;
