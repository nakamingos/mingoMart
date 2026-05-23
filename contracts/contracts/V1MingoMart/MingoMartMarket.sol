// SPDX-License-Identifier: MIT

/****************************
 * MingoMartMarket.sol
 *
 * Security model:
 * This contract follows the Ethscriptions event/indexer model. Ethscription
 * ownership cannot be verified on-chain here, so fallback deposits and listings
 * are self-asserted signals. The canonical off-chain indexer is responsible for
 * validating that the depositor/listing seller owned the referenced ethscription
 * at the indexed block, and must not index deposits or listings from non-owners.
 * Clients must consume indexer-validated marketplace state rather than treating
 * raw contract storage or events as proof of canonical ethscription ownership.
 ****************************/

pragma solidity 0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";

import "./interfaces/IPoints.sol";
import "./EthscriptionsEscrower.sol";

contract MingoMartMarket is
    Initializable,
    PausableUpgradeable,
    OwnableUpgradeable,
    ReentrancyGuardUpgradeable,
    EthscriptionsEscrower
{
    error ArrayLengthMismatch();
    error IncorrectEtherValue(uint256 sent, uint256 expected);
    error NotEthscriptionOwner();
    error HashNotListedForSale(bytes32 hashId);
    error OfferBuyerNotAuthorized();
    error PriceMismatch(uint256 provided, uint256 expected);
    error CannotBuyOwnListing();
    error NothingToWithdraw();
    error EtherTransferFailed();
    error InvalidAddressWord(bytes32 addressWord);
    error InvalidPointsAddress();
    error InvalidMarketplacePointsFeeUnit(uint256 feeUnit);
    error InvalidMarketplaceFeeBps(uint256 feeBps);
    error InvalidMarketplaceFeeRecipient(address feeRecipient);
    error InvalidWithdrawalRecipient(address recipient);

    bytes32 constant DEPOSIT_AND_LIST_SIGNATURE = keccak256("DEPOSIT_AND_LIST_SIGNATURE");
    uint256 public constant BASIS_POINTS = 10_000;
    uint256 public constant MAX_MARKETPLACE_FEE_BPS = 500;
    uint256 public constant DEFAULT_MARKETPLACE_POINTS_FEE_UNIT = 0.00001 ether;

    uint256 public contractVersion;
    address public pointsAddress;
    uint256 public marketplaceFeeBps;
    address public marketplaceFeeRecipient;

    struct Offer {
        bool isForSale;
        bytes32 hashId;
        address seller;
        uint minValue;
        address onlySellTo;
    }

    mapping(address => mapping(bytes32 => Offer)) public hashesOfferedForSale;
    mapping(address => uint) public pendingWithdrawals;
    uint256 public marketplacePointsFeeUnit;

    event HashOffered(
        bytes32 indexed hashId,
        address indexed seller,
        uint minValue,
        address indexed toAddress
    );
    event HashBought(
        bytes32 indexed hashId,
        uint value,
        address indexed fromAddress,
        address indexed toAddress
    );
    event HashNoLongerForSale(
      bytes32 indexed hashId,
      address indexed seller
    );
    event MarketplaceFeeBpsUpdated(uint256 feeBps);
    event MarketplaceFeeRecipientUpdated(address indexed feeRecipient);
    event PointsAddressUpdated(
        address indexed previousPointsAddress,
        address indexed newPointsAddress
    );
    event MarketplacePointsFeeUnitUpdated(uint256 feeUnit);

    constructor() {
        _disableInitializers();
    }

    function initialize(
        uint256 _contractVersion,
        address _initialPointsAddress
    ) public initializer {
        if (_initialPointsAddress == address(0)) {
            revert InvalidPointsAddress();
        }

        __Ownable_init(msg.sender);
        __Pausable_init();
        __ReentrancyGuard_init();

        contractVersion = _contractVersion;
        pointsAddress = _initialPointsAddress;
        marketplaceFeeRecipient = address(0x0);
        marketplacePointsFeeUnit = DEFAULT_MARKETPLACE_POINTS_FEE_UNIT;
    }

    function offerHashForSale(
        bytes32 hashId,
        uint minSalePriceInWei
    ) external nonReentrant {
        _offerHashForSale(hashId, minSalePriceInWei);
    }

    function batchOfferHashForSale(
        bytes32[] calldata hashIds,
        uint[] calldata minSalePricesInWei
    ) external nonReentrant {
        if (hashIds.length != minSalePricesInWei.length) {
            revert ArrayLengthMismatch();
        }

        for (uint i = 0; i < hashIds.length; i++) {
            _offerHashForSale(hashIds[i], minSalePricesInWei[i]);
        }
    }

    function offerHashForSaleToAddress(
        bytes32 hashId,
        uint minSalePriceInWei,
        address toAddress
    ) public nonReentrant {
        if (userEthscriptionDefinitelyNotStored(msg.sender, hashId)) {
            revert NotEthscriptionOwner();
        }

        hashesOfferedForSale[msg.sender][hashId] = Offer(
            true,
            hashId,
            msg.sender,
            minSalePriceInWei,
            toAddress
        );

        emit HashOffered(hashId, msg.sender, minSalePriceInWei, toAddress);
    }

    function _offerHashForSale(
        bytes32 hashId,
        uint minSalePriceInWei
    ) internal {
        if (userEthscriptionDefinitelyNotStored(msg.sender, hashId)) {
            revert NotEthscriptionOwner();
        }

        hashesOfferedForSale[msg.sender][hashId] = Offer(
            true,
            hashId,
            msg.sender,
            minSalePriceInWei,
            address(0x0)
        );

        emit HashOffered(hashId, msg.sender, minSalePriceInWei, address(0x0));
    }

    function hashNoLongerForSale(bytes32 hashId) external {
        if (userEthscriptionDefinitelyNotStored(msg.sender, hashId)) {
            revert NotEthscriptionOwner();
        }

        _invalidateListing(msg.sender, hashId);
    }

    function _buyHash(
        address previousOwner,
        bytes32 hashId,
        uint minSalePriceInWei,
        address feeRecipient,
        uint256 feeBps
    ) internal {
        Offer memory offer = hashesOfferedForSale[previousOwner][hashId];

        if (!offer.isForSale) {
            revert HashNotListedForSale(hashId);
        }
        if (offer.seller == msg.sender) {
            revert CannotBuyOwnListing();
        }
        if (
            offer.onlySellTo != address(0x0) &&
            offer.onlySellTo != msg.sender
        ) {
            revert OfferBuyerNotAuthorized();
        }
        if (minSalePriceInWei != offer.minValue) {
            revert PriceMismatch(minSalePriceInWei, offer.minValue);
        }

        address seller = offer.seller;

        hashesOfferedForSale[seller][hashId] = Offer(
            false,
            hashId,
            seller,
            0,
            address(0x0)
        );

        _transferEthscription(seller, msg.sender, hashId);

        uint256 fee = (minSalePriceInWei * feeBps) / BASIS_POINTS;
        uint256 sellerProceeds = minSalePriceInWei - fee;

        if (sellerProceeds != 0) {
            _storePendingPayment(seller, sellerProceeds);
        }
        if (fee != 0) {
            _storePendingPayment(feeRecipient, fee);
        }

        emit HashBought(hashId, minSalePriceInWei, seller, msg.sender);

        _awardSalePoints(seller, msg.sender, fee);
    }

    function batchBuyHash(
        address[] calldata previousOwners,
        bytes32[] calldata hashIds,
        uint[] calldata minSalePricesInWei
    ) external payable whenNotPaused nonReentrant {
        if (
            previousOwners.length != hashIds.length ||
            hashIds.length != minSalePricesInWei.length
        ) {
            revert ArrayLengthMismatch();
        }

        address feeRecipient = marketplaceFeeRecipient;
        uint256 feeBps = marketplaceFeeBps;
        uint totalSalePrice = 0;
        for (uint i = 0; i < hashIds.length; i++) {
            _buyHash(
                previousOwners[i],
                hashIds[i],
                minSalePricesInWei[i],
                feeRecipient,
                feeBps
            );
            totalSalePrice += minSalePricesInWei[i];
        }

        if (msg.value != totalSalePrice) {
            revert IncorrectEtherValue(msg.value, totalSalePrice);
        }
    }

    function withdraw() public nonReentrant {
        _withdrawTo(payable(msg.sender));
    }

    function withdrawTo(address payable recipient) public nonReentrant {
        if (recipient == address(0x0)) {
            revert InvalidWithdrawalRecipient(recipient);
        }

        _withdrawTo(recipient);
    }

    function _withdrawTo(address payable recipient) internal {
        uint256 amount = pendingWithdrawals[msg.sender];
        if (amount == 0) {
            revert NothingToWithdraw();
        }

        pendingWithdrawals[msg.sender] = 0;

        (bool sent, ) = recipient.call{value: amount}("");
        if (!sent) {
            revert EtherTransferFailed();
        }
    }

    function withdrawHash(bytes32 hashId) public {
        if (userEthscriptionDefinitelyNotStored(msg.sender, hashId)) {
            revert NotEthscriptionOwner();
        }

        super.withdrawEthscription(hashId);

        Offer memory offer = hashesOfferedForSale[msg.sender][hashId];
        if (offer.isForSale) {
            _invalidateListing(msg.sender, hashId);
        }
    }

    function withdrawBatchHashes(bytes32[] calldata hashIds) external {
        for (uint i = 0; i < hashIds.length; i++) {
            withdrawHash(hashIds[i]);
        }
    }

    function _onPotentialEthscriptionDeposit(
        address previousOwner,
        bytes calldata userCalldata
    ) internal override {
        if (userCalldata.length % 32 != 0) {
            revert InvalidEthscriptionLength();
        }

        for (uint256 i = 0; i < userCalldata.length / 32; i++) {
            bytes32 potentialEthscriptionId = abi.decode(slice(userCalldata, i * 32, 32), (bytes32));

            if (userEthscriptionPossiblyStored(previousOwner, potentialEthscriptionId)) {
                revert EthscriptionAlreadyReceivedFromSender();
            }

            EthscriptionsEscrowerStorage.s().ethscriptionReceivedOnBlockNumber[
                previousOwner
            ][potentialEthscriptionId] = block.number;
        }
    }

    function _onPotentialSingleEthscriptionDeposit(
        address previousOwner,
        bytes32 hashId
    ) internal {
        if (userEthscriptionPossiblyStored(previousOwner, hashId)) {
            revert EthscriptionAlreadyReceivedFromSender();
        }

        EthscriptionsEscrowerStorage.s().ethscriptionReceivedOnBlockNumber[
            previousOwner
        ][hashId] = block.number;
    }

    function _invalidateListing(address previousOwner, bytes32 hashId) internal {
        hashesOfferedForSale[previousOwner][hashId] = Offer(
            false,
            hashId,
            previousOwner,
            0,
            address(0x0)
        );
        emit HashNoLongerForSale(hashId, previousOwner);
    }

    function _addPoints(
        address account,
        uint256 amount
    ) internal {
        IPoints pointsContract = IPoints(pointsAddress);
        pointsContract.addPoints(account, amount);
    }

    function _awardSalePoints(
        address seller,
        address buyer,
        uint256 fee
    ) internal {
        if (fee == 0) {
            return;
        }

        uint256 feeUnit = marketplacePointsFeeUnit;
        if (feeUnit == 0) {
            feeUnit = DEFAULT_MARKETPLACE_POINTS_FEE_UNIT;
        }

        uint256 totalPoints = fee / feeUnit;
        if (totalPoints == 0) {
            return;
        }

        uint256 sellerPoints = totalPoints / 2;
        uint256 buyerPoints = totalPoints - sellerPoints;

        if (sellerPoints > 0) {
            _addPoints(seller, sellerPoints);
        }
        if (buyerPoints > 0) {
            _addPoints(buyer, buyerPoints);
        }
    }

    function _storePendingPayment(
        address recipient,
        uint256 amount
    ) internal {
        pendingWithdrawals[recipient] += amount;
    }

    function setPointsAddress(address _pointsAddress) public onlyOwner {
        if (_pointsAddress == address(0)) {
            revert InvalidPointsAddress();
        }
        address previousPointsAddress = pointsAddress;
        pointsAddress = _pointsAddress;
        emit PointsAddressUpdated(previousPointsAddress, _pointsAddress);
    }

    function setMarketplacePointsFeeUnit(
        uint256 _marketplacePointsFeeUnit
    ) public onlyOwner {
        if (_marketplacePointsFeeUnit == 0) {
            revert InvalidMarketplacePointsFeeUnit(_marketplacePointsFeeUnit);
        }

        marketplacePointsFeeUnit = _marketplacePointsFeeUnit;
        emit MarketplacePointsFeeUnitUpdated(_marketplacePointsFeeUnit);
    }

    function setMarketplaceFeeBps(uint256 _marketplaceFeeBps) public onlyOwner {
        if (_marketplaceFeeBps > MAX_MARKETPLACE_FEE_BPS) {
            revert InvalidMarketplaceFeeBps(_marketplaceFeeBps);
        }
        if (
            _marketplaceFeeBps != 0 &&
            marketplaceFeeRecipient == address(0x0)
        ) {
            revert InvalidMarketplaceFeeRecipient(marketplaceFeeRecipient);
        }

        marketplaceFeeBps = _marketplaceFeeBps;

        emit MarketplaceFeeBpsUpdated(_marketplaceFeeBps);
    }

    function setMarketplaceFeeRecipient(
        address _marketplaceFeeRecipient
    ) public onlyOwner {
        if (_marketplaceFeeRecipient == address(0x0)) {
            revert InvalidMarketplaceFeeRecipient(_marketplaceFeeRecipient);
        }

        marketplaceFeeRecipient = _marketplaceFeeRecipient;

        emit MarketplaceFeeRecipientUpdated(_marketplaceFeeRecipient);
    }

    function pause() public onlyOwner {
        _pause();
    }

    function unpause() public onlyOwner {
        _unpause();
    }

    function slice(bytes memory data, uint256 start, uint256 len) internal pure returns (bytes memory) {
        bytes memory b = new bytes(len);
        for (uint256 i = 0; i < len; i++) {
            b[i] = data[i + start];
        }
        return b;
    }

    fallback() external {
        if (paused()) {
            revert EnforcedPause();
        }

        bytes32 signature;
        assembly {
            signature := calldataload(32)
        }

        if (signature == DEPOSIT_AND_LIST_SIGNATURE) {
            if (msg.data.length != 128) {
                revert InvalidEthscriptionLength();
            }

            bytes32 hashId;
            bytes32 listingPrice;
            bytes32 toAddress;

            assembly {
                hashId := calldataload(0)
                listingPrice := calldataload(64)
                toAddress := calldataload(96)
            }

            if (uint256(toAddress) > type(uint160).max) {
                revert InvalidAddressWord(toAddress);
            }

            address addrToAddress = address(uint160(uint256(toAddress)));

            if (addrToAddress != address(0x0)) {
                _onPotentialSingleEthscriptionDeposit(msg.sender, hashId);
                offerHashForSaleToAddress(hashId, uint256(listingPrice), addrToAddress);
                return;
            }

            _onPotentialSingleEthscriptionDeposit(msg.sender, hashId);
            _offerHashForSale(hashId, uint256(listingPrice));
            return;
        }

        _onPotentialEthscriptionDeposit(msg.sender, msg.data);
    }
}
