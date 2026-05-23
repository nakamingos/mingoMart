// SPDX-License-Identifier: GPL-3.0

/****************************
 * MingoMartAuctionHouse.sol
 *
 * Security model:
 * This contract follows the Ethscriptions event/indexer model. Ethscription
 * ownership cannot be verified on-chain here, so fallback deposits and auctions
 * are self-asserted signals. The canonical off-chain indexer is responsible for
 * validating that the depositor/auction seller owned the referenced ethscription
 * at the indexed block, and must not index deposits or auctions from non-owners.
 * Clients must consume indexer-validated auction state rather than treating
 * raw contract storage or events as proof of canonical ethscription ownership.
 ****************************/

pragma solidity 0.8.20;

import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "./interfaces/IAuctionHouse.sol";
import "./interfaces/IPoints.sol";

import "./EthscriptionsEscrower.sol";

contract MingoMartAuctionHouse is
    IAuctionHouse,
    EthscriptionsEscrower,
    Pausable,
    ReentrancyGuard,
    Ownable
{
    // Custom errors
    error InvalidPointsAddress();
    error SellersMustBeEOAs();
    error AuctionAlreadyExists();
    error AuctionDoesNotExist();
    error AuctionExpired();
    error AuctionNotCompleted();
    error AuctionAlreadySettled();
    error InvalidHashId();
    error InvalidDuration();
    error InvalidBidIncrement();
    error InvalidTimeBuffer();
    error InvalidAuctionSignature();
    error DataTooShort();
    error InvalidDataLength();
    error InsufficientBidAmount();
    error OwnerCannotBid();
    error BidderCannotOutbidSelf();
    error FailedToPayAuctionWinner();
    error NoPendingWithdrawals();
    error FailedToSendEther();
    error ContractPaused();
    error InvalidAuctionPointsFeeUnit(uint256 feeUnit);
    error InvalidMarketplaceFeeBps(uint256 feeBps);
    error InvalidMarketplaceFeeRecipient(address feeRecipient);

    bytes32 constant DEPOSIT_AND_AUCTION_SIGNATURE = keccak256("DEPOSIT_AND_AUCTION_SIGNATURE");
    uint256 public constant BASIS_POINTS = 10_000;
    uint256 public constant MAX_MARKETPLACE_FEE_BPS = 500;
    uint256 public auctionPointsFeeUnit = 0.00001 ether;
    uint256 public constant DEFAULT_AUCTION_DURATION = 1 days;
    uint8 public constant DEFAULT_MIN_BID_INCREMENT_PERCENTAGE = 10;
    uint256 public constant DEFAULT_TIME_BUFFER = 15 minutes;
    uint256 public constant DEFAULT_RESERVE_PRICE = 0;

    // Address of the Points contract
    address public pointsAddress;

    // The current auction ID
    uint256 public auctionId;

    // Marketplace fee configuration for successful auction settlements
    uint256 public marketplaceFeeBps;
    address public marketplaceFeeRecipient;

    mapping(address => mapping(bytes32 => IAuctionHouse.Auction)) public auctions;

    // Pending withdrawals for outbid bidders (fallback when push refund fails)
    mapping(address => uint256) public pendingWithdrawals;

    constructor(
        address _initialPointsAddress
    ) Ownable(msg.sender) {
        if (_initialPointsAddress == address(0)) revert InvalidPointsAddress();
        pointsAddress = _initialPointsAddress;
    }

    function _addPoints(address account, uint256 amount) internal {
        IPoints(pointsAddress).addPoints(account, amount);
    }

    /**
     * @notice Create an auction with custom duration.
     * @dev Store the auction details and emit an AuctionCreated event.
     */
    function _createAuction(
        bytes32 hashId,
        address owner,
        uint256 auctionDuration,
        uint8 minBidIncrementPercentage,
        uint256 timeBuffer,
        uint256 reservePrice
    ) internal {
        // Prevent contracts from creating auctions (sellers must be EOAs)
        if (owner.code.length != 0) revert SellersMustBeEOAs();

        IAuctionHouse.Auction memory _auction = auctions[owner][hashId];

        if (_auction.startTime != 0 && !_auction.settled) {
            revert AuctionAlreadyExists();
        }

        uint256 startTime = block.timestamp;
        uint256 endTime = startTime + auctionDuration;

        auctionId++;

        auctions[owner][hashId] = IAuctionHouse.Auction({
            hashId: hashId,
            owner: owner,
            amount: 0,
            startTime: startTime,
            endTime: endTime,
            bidder: payable(0),
            settled: false,
            auctionId: auctionId,
            duration: auctionDuration,
            minBidIncrementPercentage: minBidIncrementPercentage,
            timeBuffer: timeBuffer,
            reservePrice: reservePrice
        });

        emit AuctionCreated(
            hashId,
            owner,
            auctionId,
            startTime,
            endTime,
            auctionDuration,
            minBidIncrementPercentage,
            timeBuffer,
            reservePrice
        );
    }

    /**
     * @notice Settle an auction, finalizing the bid and paying out to the owner.
     */
    function settleAuction(bytes32 hashId, address owner) external nonReentrant {
        _settleAuction(hashId, owner);
    }

    /**
     * @notice Settle an auction, finalizing the bid and paying out to the owner.
     * @dev If there are no bids, the ethscription is returned to the owner.
     */
    function _settleAuction(bytes32 hashId, address owner) internal {
        IAuctionHouse.Auction memory _auction = auctions[owner][hashId];

        if (_auction.startTime == 0) revert AuctionDoesNotExist();
        if (_auction.settled) revert AuctionAlreadySettled();
        if (block.timestamp < _auction.endTime) revert AuctionNotCompleted();

        auctions[owner][hashId].settled = true;

        address dest = _auction.bidder == address(0)
            ? _auction.owner
            : _auction.bidder;

        uint256 fee = 0;
        if (_auction.amount > 0) {
            fee = (_auction.amount * marketplaceFeeBps) / BASIS_POINTS;
            uint256 sellerProceeds = _auction.amount - fee;

            if (sellerProceeds > 0) {
                _sendOrCredit(_auction.owner, sellerProceeds);
            }

            if (fee > 0) {
                _sendOrCredit(marketplaceFeeRecipient, fee);
            }
        }

        _transferEthscription(_auction.owner, dest, _auction.hashId);
        _awardSettlementPoints(_auction.owner, _auction.bidder, fee);

        emit AuctionSettled(
            _auction.hashId,
            _auction.auctionId,
            _auction.owner,
            _auction.bidder,
            _auction.amount
        );
    }

    function _awardSettlementPoints(
        address seller,
        address bidder,
        uint256 fee
    ) internal {
        if (bidder == address(0) || fee == 0) {
            return;
        }

        uint256 totalPoints = fee / auctionPointsFeeUnit;
        if (totalPoints == 0) {
            return;
        }

        uint256 sellerPoints = totalPoints / 2;
        uint256 bidderPoints = totalPoints - sellerPoints;

        if (sellerPoints > 0) {
            _addPoints(seller, sellerPoints);
        }
        if (bidderPoints > 0) {
            _addPoints(bidder, bidderPoints);
        }
    }

    /**
     * @notice Create a bid for an ethscription, with a given amount.
     * @dev This contract only accepts payment in ETH.
     */
    function createBid(bytes32 hashId, address owner) external payable override nonReentrant whenNotPaused {
        IAuctionHouse.Auction storage _auction = auctions[owner][hashId];

        if (_auction.startTime == 0) revert AuctionDoesNotExist();
        if (block.timestamp >= _auction.endTime) revert AuctionExpired();
        uint256 minimumBid = _auction.reservePrice;
        if (_auction.amount > 0) {
            uint256 minBidIncrement = (_auction.amount * _auction.minBidIncrementPercentage) / 100;
            if (minBidIncrement == 0) {
                minBidIncrement = 1;
            }
            minimumBid = _auction.amount + minBidIncrement;
        } else if (minimumBid == 0) {
            minimumBid = 1;
        }

        if (msg.value < minimumBid) {
            revert InsufficientBidAmount();
        }
        if (msg.sender == owner) revert OwnerCannotBid();
        if (msg.sender == _auction.bidder) revert BidderCannotOutbidSelf();

        address payable lastBidder = _auction.bidder;
        uint256 lastBidAmount = _auction.amount;

        // Try to refund immediately, fallback to pending withdrawals if it fails
        if (lastBidder != address(0)) {
            bool refundSuccess = _safeTransferETH(lastBidder, lastBidAmount);
            if (!refundSuccess) {
                // If push refund fails, add to pending withdrawals
                pendingWithdrawals[lastBidder] += lastBidAmount;
            }
        }

        // Update storage directly
        _auction.amount = msg.value;
        _auction.bidder = payable(msg.sender);

        // Extend the auction if the bid was received within `timeBuffer` of the auction end time
        bool extended = _auction.endTime - block.timestamp < _auction.timeBuffer;
        if (extended) {
            _auction.endTime = block.timestamp + _auction.timeBuffer;
        }

        emit AuctionBid(
            _auction.hashId,
            _auction.auctionId,
            msg.sender,
            msg.value,
            extended
        );

        if (extended) {
            emit AuctionExtended(
                _auction.hashId,
                _auction.auctionId,
                _auction.endTime
            );
        }
    }

    /**
     * @notice Transfer ETH and return the success status.
     * @dev This function only forwards 30,000 gas to the callee.
     */
    function _safeTransferETH(
        address to,
        uint256 amount
    ) internal returns (bool) {
        (bool success, ) = to.call{value: amount, gas: 30_000}(new bytes(0));
        return success;
    }

    function _sendOrCredit(address recipient, uint256 amount) internal {
        if (!_safeTransferETH(recipient, amount)) {
            pendingWithdrawals[recipient] += amount;
        }
    }

    /**
     * @notice Withdraw pending refunds.
     * @dev Allows users to withdraw their pending refunds when push refund failed.
     */
    function withdraw() external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender];
        if (amount == 0) revert NoPendingWithdrawals();

        // Zero out the pending withdrawal before transfer
        pendingWithdrawals[msg.sender] = 0;

        (bool success, ) = payable(msg.sender).call{value: amount}("");
        if (!success) revert FailedToSendEther();

        emit Withdrawal(msg.sender, amount);
    }

    /**
     * @notice Pause the MingoMart auction house.
     * @dev This function can only be called by the owner when the
     * contract is unpaused. While no new auctions can be started when paused,
     * anyone can settle an ongoing auction.
     */
    function pause() external override onlyOwner {
        _pause();
    }

    /**
     * @notice Unpause the MingoMart auction house.
     * @dev This function can only be called by the owner when the
     * contract is paused. If required, this function will start a new auction.
     */
    function unpause() external override onlyOwner {
        _unpause();
    }

    /**
     * @notice Get auction details
     * @dev This function returns the auction details for a given owner and hashId
     */
    function getAuction(address owner, bytes32 hashId) external view returns (IAuctionHouse.Auction memory) {
        return auctions[owner][hashId];
    }

    /**
     * @notice Set the points address.
     * @dev This function can only be called by the owner.
     */
    function setPointsAddress(address _pointsAddress) external onlyOwner {
        if (_pointsAddress == address(0)) revert InvalidPointsAddress();
        address previousPointsAddress = pointsAddress;
        pointsAddress = _pointsAddress;
        emit PointsAddressUpdated(previousPointsAddress, _pointsAddress);
    }

    /**
     * @notice Set the marketplace fee amount required to award one auction point.
     * @dev This function can only be called by the owner.
     */
    function setAuctionPointsFeeUnit(uint256 _auctionPointsFeeUnit) external onlyOwner {
        if (_auctionPointsFeeUnit == 0) {
            revert InvalidAuctionPointsFeeUnit(_auctionPointsFeeUnit);
        }

        auctionPointsFeeUnit = _auctionPointsFeeUnit;
        emit AuctionPointsFeeUnitUpdated(_auctionPointsFeeUnit);
    }

    /**
     * @notice Set the marketplace fee in basis points.
     * @dev This function can only be called by the owner.
     */
    function setMarketplaceFeeBps(uint256 _marketplaceFeeBps) external onlyOwner {
        if (_marketplaceFeeBps > MAX_MARKETPLACE_FEE_BPS) {
            revert InvalidMarketplaceFeeBps(_marketplaceFeeBps);
        }
        if (
            _marketplaceFeeBps != 0 &&
            marketplaceFeeRecipient == address(0)
        ) {
            revert InvalidMarketplaceFeeRecipient(marketplaceFeeRecipient);
        }

        marketplaceFeeBps = _marketplaceFeeBps;
        emit MarketplaceFeeBpsUpdated(_marketplaceFeeBps);
    }

    /**
     * @notice Set the marketplace fee recipient.
     * @dev This function can only be called by the owner.
     */
    function setMarketplaceFeeRecipient(
        address _marketplaceFeeRecipient
    ) external onlyOwner {
        if (_marketplaceFeeRecipient == address(0)) {
            revert InvalidMarketplaceFeeRecipient(_marketplaceFeeRecipient);
        }

        marketplaceFeeRecipient = _marketplaceFeeRecipient;
        emit MarketplaceFeeRecipientUpdated(_marketplaceFeeRecipient);
    }

    /**
     * @notice Replacement escrower function that takes bytes32 rather than calldata (bytes)
     */
    function _onPotentialDeposit(
      address previousOwner,
      bytes32 hashId
    ) internal {
        if (hashId == bytes32(0)) revert InvalidEthscriptionLength();

        if (
            userEthscriptionPossiblyStored(previousOwner, hashId)
        ) {
            revert EthscriptionAlreadyReceivedFromSender();
        }

        EthscriptionsEscrowerStorage.s().ethscriptionReceivedOnBlockNumber[
            previousOwner
        ][hashId] = block.number;
    }

    fallback() external {
        if (paused()) revert ContractPaused();

        if (msg.data.length < 64) revert DataTooShort(); // hashId + signature required
        if (msg.data.length > 192 || msg.data.length % 32 != 0) revert InvalidDataLength();

        bytes32 hashId;
        bytes32 signature;
        uint256 duration = DEFAULT_AUCTION_DURATION;
        uint256 minBidIncrementPercentageRaw = DEFAULT_MIN_BID_INCREMENT_PERCENTAGE;
        uint256 timeBuffer = DEFAULT_TIME_BUFFER;
        uint256 reservePrice = DEFAULT_RESERVE_PRICE;

        assembly {
            hashId := calldataload(0)
            signature := calldataload(32)
        }

        if (signature != DEPOSIT_AND_AUCTION_SIGNATURE) {
            revert InvalidAuctionSignature();
        }

        if (msg.data.length >= 96) {
            assembly {
                duration := calldataload(64)
            }
        }
        if (msg.data.length >= 128) {
            assembly {
                minBidIncrementPercentageRaw := calldataload(96)
            }
        }
        if (msg.data.length >= 160) {
            assembly {
                timeBuffer := calldataload(128)
            }
        }
        if (msg.data.length >= 192) {
            assembly {
                reservePrice := calldataload(160)
            }
        }

        // Validate parameters
        if (hashId == bytes32(0)) revert InvalidHashId();
        if (duration < 1 hours || duration > 30 days) revert InvalidDuration();
        if (minBidIncrementPercentageRaw == 0 || minBidIncrementPercentageRaw > 100) revert InvalidBidIncrement();
        if (timeBuffer < 5 minutes || timeBuffer > 1 hours) revert InvalidTimeBuffer();

        // Create a new auction
        _createAuction(
            hashId,
            msg.sender,
            duration,
            uint8(minBidIncrementPercentageRaw),
            timeBuffer,
            reservePrice
        );
        // Escrow the ethscription
        _onPotentialDeposit(msg.sender, hashId);
    }
}
