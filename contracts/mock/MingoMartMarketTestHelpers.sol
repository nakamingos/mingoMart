// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "../MingoMartMarket.sol";
import "../MingoMartAuctionHouse.sol";
import "../interfaces/IPoints.sol";

contract MockPoints is IPoints {
    mapping(address => uint256) public points;
    bool public rejectAdds;

    event PointsAdded(address indexed user, uint256 amount);

    function setRejectAdds(bool _rejectAdds) external {
        rejectAdds = _rejectAdds;
    }

    function addPoints(address user, uint256 amount) external override {
        require(!rejectAdds, "Points rejected");
        points[user] += amount;
        emit PointsAdded(user, amount);
    }
}

contract ToggleRejectEtherSeller {
    error CannotReceiveEther();

    bool public rejectEther = true;

    function setRejectEther(bool _rejectEther) external {
        rejectEther = _rejectEther;
    }

    function depositAndList(
        address market,
        bytes32 hashId,
        bytes32 depositAndListSignature,
        uint256 price,
        address onlySellTo
    ) external {
        bytes32 priceWord = bytes32(price);
        bytes32 toAddressWord = bytes32(uint256(uint160(onlySellTo)));

        (bool ok, ) = market.call(
            abi.encodePacked(
                hashId,
                depositAndListSignature,
                priceWord,
                toAddressWord
            )
        );
        require(ok, "deposit and list failed");
    }

    function withdrawPayments(address market) external {
        MingoMartMarket(market).withdraw();
    }

    function withdrawPaymentsTo(address market, address payable recipient) external {
        MingoMartMarket(market).withdrawTo(recipient);
    }

    function setMarketplaceFeeBps(
        address market,
        uint256 feeBps
    ) external {
        MingoMartMarket(market).setMarketplaceFeeBps(feeBps);
    }

    receive() external payable {
        if (rejectEther) revert CannotReceiveEther();
    }
}

contract ToggleRejectEtherAuctionParticipant {
    error CannotReceiveEther();

    bool public rejectEther = true;

    function setRejectEther(bool _rejectEther) external {
        rejectEther = _rejectEther;
    }

    function depositAndAuction(
        address auctionHouse,
        bytes32 hashId,
        bytes32 depositAndAuctionSignature,
        uint256 duration,
        uint8 minBidIncrementPercentage,
        uint256 timeBuffer
    ) external {
        bytes32 durationWord = bytes32(duration);
        bytes32 minBidIncrementWord = bytes32(uint256(minBidIncrementPercentage));
        bytes32 timeBufferWord = bytes32(timeBuffer);

        (bool ok, bytes memory reason) = auctionHouse.call(
            abi.encodePacked(
                hashId,
                depositAndAuctionSignature,
                durationWord,
                minBidIncrementWord,
                timeBufferWord
            )
        );
        if (!ok) {
            assembly {
                revert(add(reason, 32), mload(reason))
            }
        }
    }

    function bid(
        address auctionHouse,
        bytes32 hashId,
        address owner
    ) external payable {
        MingoMartAuctionHouse(auctionHouse).createBid{value: msg.value}(
            hashId,
            owner
        );
    }

    function withdrawPayments(address auctionHouse) external {
        MingoMartAuctionHouse(auctionHouse).withdraw();
    }

    receive() external payable {
        if (rejectEther) revert CannotReceiveEther();
    }
}

contract FeeMutatingOwner {
    address public market;
    uint256 public mutatedFeeBps;
    bool public mutateOnReceive;
    bool public hasMutated;

    function setMarketplaceFeeBps(
        address _market,
        uint256 feeBps
    ) external {
        MingoMartMarket(_market).setMarketplaceFeeBps(feeBps);
    }

    function enableFeeMutationOnReceive(
        address _market,
        uint256 _mutatedFeeBps
    ) external {
        market = _market;
        mutatedFeeBps = _mutatedFeeBps;
        mutateOnReceive = true;
        hasMutated = false;
    }

    receive() external payable {
        if (mutateOnReceive && !hasMutated) {
            hasMutated = true;
            MingoMartMarket(market).setMarketplaceFeeBps(mutatedFeeBps);
        }
    }
}
