// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.20;

interface IAuctionHouse {
    struct Auction {
        // ID for the inscription
        bytes32 hashId;
        // Owner of the ethscription
        address owner;
        // The current highest bid amount
        uint256 amount;
        // The time that the auction started
        uint256 startTime;
        // The time that the auction is scheduled to end
        uint256 endTime;
        // The address of the current highest bid
        address payable bidder;
        // Whether or not the auction has been settled
        bool settled;
        // Auction ID number
        uint256 auctionId;
        // Duration of this specific auction
        uint256 duration;
        // Minimum bid increment percentage
        uint8 minBidIncrementPercentage;
        // The minimum amount of time left in an auction after a new bid is created
        uint256 timeBuffer;
        // Minimum opening bid amount in wei
        uint256 reservePrice;
    }

    event AuctionCreated(
        bytes32 indexed hashId,
        address indexed owner,
        uint256 auctionId,
        uint256 startTime,
        uint256 endTime,
        uint256 duration,
        uint8 minBidIncrementPercentage,
        uint256 timeBuffer,
        uint256 reservePrice
    );

    event AuctionBid(bytes32 indexed hashId, uint256 auctionId, address sender, uint256 value, bool extended);

    event AuctionExtended(bytes32 indexed hashId, uint256 auctionId, uint256 endTime);

    event AuctionSettled(bytes32 indexed hashId, uint256 auctionId, address indexed owner, address winner, uint256 amount);

    event PointsAddressUpdated(address indexed previousPointsAddress, address indexed newPointsAddress);

    event AuctionPointsFeeUnitUpdated(uint256 feeUnit);

    event Withdrawal(address indexed account, uint256 amount);

    event MarketplaceFeeBpsUpdated(uint256 feeBps);

    event MarketplaceFeeRecipientUpdated(address indexed feeRecipient);

    function settleAuction(bytes32 hashId, address owner) external;

    function createBid(bytes32 hashId, address owner) external payable;

    function pause() external;

    function unpause() external;

    function setPointsAddress(address _pointsAddress) external;

    function setAuctionPointsFeeUnit(uint256 _auctionPointsFeeUnit) external;

    function setMarketplaceFeeBps(uint256 _marketplaceFeeBps) external;

    function setMarketplaceFeeRecipient(address _marketplaceFeeRecipient) external;

    function getAuction(address owner, bytes32 hashId) external view returns (Auction memory);

    function withdraw() external;
}
