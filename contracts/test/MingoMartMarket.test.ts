import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import {
  MingoMartMarket,
  MockPoints,
  ToggleRejectEtherSeller,
} from "../typechain-types";

describe("MingoMartMarket", function () {
  let market: MingoMartMarket;
  let points: MockPoints;
  let owner: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let charlie: HardhatEthersSigner;

  const itemA = ethers.id("mingomart-market-item-A");
  const itemB = ethers.id("mingomart-market-item-B");
  const itemC = ethers.id("mingomart-market-item-C");
  const priceA = ethers.parseEther("1");
  const priceB = ethers.parseEther("0.25");
  const feeBps = 250n;
  const DEPOSIT_AND_LIST_SIGNATURE = ethers.id("DEPOSIT_AND_LIST_SIGNATURE");

  async function escrow(
    signer: HardhatEthersSigner,
    ...hashIds: string[]
  ) {
    return signer.sendTransaction({
      to: await market.getAddress(),
      data: ethers.concat(hashIds),
    });
  }

  async function depositAndList(
    signer: HardhatEthersSigner,
    hashId: string,
    price: bigint,
    onlySellTo = ethers.ZeroAddress
  ) {
    return signer.sendTransaction({
      to: await market.getAddress(),
      data: ethers.concat([
        hashId,
        DEPOSIT_AND_LIST_SIGNATURE,
        ethers.zeroPadValue(ethers.toBeHex(price), 32),
        ethers.zeroPadValue(onlySellTo, 32),
      ]),
    });
  }

  async function mineCooldownBlocks() {
    for (let i = 0; i < 5; i++) {
      await ethers.provider.send("evm_mine", []);
    }
  }

  async function deployRejectingSeller() {
    const factory = await ethers.getContractFactory("ToggleRejectEtherSeller");
    return (await factory.deploy()) as ToggleRejectEtherSeller;
  }

  beforeEach(async function () {
    [owner, alice, bob, charlie] = await ethers.getSigners();

    const pointsFactory = await ethers.getContractFactory("MockPoints");
    points = (await pointsFactory.deploy()) as MockPoints;

    const marketFactory = await ethers.getContractFactory("MingoMartMarket");
    const implementation = (await marketFactory.deploy()) as MingoMartMarket;
    const proxyFactory = await ethers.getContractFactory("MingoMartMarketProxy");
    const proxy = await proxyFactory.deploy(
      await implementation.getAddress(),
      1,
      await points.getAddress()
    );
    market = marketFactory.attach(await proxy.getAddress()) as MingoMartMarket;
  });

  describe("initialize and admin", function () {
    it("initializes version, points address, and owner", async function () {
      expect(await market.contractVersion()).to.equal(1);
      expect(await market.pointsAddress()).to.equal(await points.getAddress());
      expect(await market.owner()).to.equal(owner.address);
      expect(await market.marketplaceFeeBps()).to.equal(0);
      expect(await market.marketplacePointsFeeUnit()).to.equal(
        ethers.parseEther("0.00001")
      );
      expect(await market.marketplaceFeeRecipient()).to.equal(
        ethers.ZeroAddress
      );
    });

    it("does not allow initialize to run twice", async function () {
      await expect(
        market.initialize(2, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(market, "InvalidInitialization");
    });

    it("rejects a zero points address during proxy initialization", async function () {
      const marketFactory = await ethers.getContractFactory("MingoMartMarket");
      const implementation = (await marketFactory.deploy()) as MingoMartMarket;
      const proxyFactory = await ethers.getContractFactory("MingoMartMarketProxy");

      await expect(
        proxyFactory.deploy(
          await implementation.getAddress(),
          1,
          ethers.ZeroAddress
        )
      ).to.be.revertedWithCustomError(implementation, "InvalidPointsAddress");
    });

    it("initializes through the proxy constructor", async function () {
      expect(await market.contractVersion()).to.equal(1);
      expect(await market.pointsAddress()).to.equal(await points.getAddress());
      expect(await market.owner()).to.equal(owner.address);
    });

    it("allows the owner to update the points address", async function () {
      await expect(market.setPointsAddress(charlie.address))
        .to.emit(market, "PointsAddressUpdated")
        .withArgs(await points.getAddress(), charlie.address);

      expect(await market.pointsAddress()).to.equal(charlie.address);
    });

    it("rejects the zero address as points address", async function () {
      await expect(market.setPointsAddress(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(market, "InvalidPointsAddress");
    });

    it("allows the owner to update the marketplace points fee unit", async function () {
      const feeUnit = ethers.parseEther("0.00002");

      await expect(market.setMarketplacePointsFeeUnit(feeUnit))
        .to.emit(market, "MarketplacePointsFeeUnitUpdated")
        .withArgs(feeUnit);

      expect(await market.marketplacePointsFeeUnit()).to.equal(feeUnit);
    });

    it("rejects a zero marketplace points fee unit", async function () {
      await expect(market.setMarketplacePointsFeeUnit(0))
        .to.be.revertedWithCustomError(
          market,
          "InvalidMarketplacePointsFeeUnit"
        )
        .withArgs(0);
    });

    it("allows the owner to update the marketplace fee", async function () {
      await market.setMarketplaceFeeRecipient(charlie.address);

      await expect(market.setMarketplaceFeeBps(feeBps))
        .to.emit(market, "MarketplaceFeeBpsUpdated")
        .withArgs(feeBps);

      expect(await market.marketplaceFeeBps()).to.equal(feeBps);
    });

    it("allows the owner to update the marketplace fee recipient", async function () {
      await expect(market.setMarketplaceFeeRecipient(charlie.address))
        .to.emit(market, "MarketplaceFeeRecipientUpdated")
        .withArgs(charlie.address);

      expect(await market.marketplaceFeeRecipient()).to.equal(charlie.address);
    });

    it("allows the owner to set the marketplace fee to the 5% cap", async function () {
      const maxFeeBps = await market.MAX_MARKETPLACE_FEE_BPS();
      await market.setMarketplaceFeeRecipient(charlie.address);

      await expect(market.setMarketplaceFeeBps(maxFeeBps))
        .to.emit(market, "MarketplaceFeeBpsUpdated")
        .withArgs(maxFeeBps);

      expect(await market.marketplaceFeeBps()).to.equal(maxFeeBps);
    });

    it("rejects marketplace fees above 5%", async function () {
      const invalidFeeBps = 501n;

      await expect(market.setMarketplaceFeeBps(invalidFeeBps))
        .to.be.revertedWithCustomError(market, "InvalidMarketplaceFeeBps")
        .withArgs(invalidFeeBps);
    });

    it("rejects nonzero marketplace fees before a recipient is set", async function () {
      await expect(market.setMarketplaceFeeBps(feeBps))
        .to.be.revertedWithCustomError(
          market,
          "InvalidMarketplaceFeeRecipient"
        )
        .withArgs(ethers.ZeroAddress);
    });

    it("rejects the zero address as marketplace fee recipient", async function () {
      await expect(market.setMarketplaceFeeRecipient(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(
          market,
          "InvalidMarketplaceFeeRecipient"
        )
        .withArgs(ethers.ZeroAddress);
    });

    it("keeps the marketplace fee config when ownership is renounced", async function () {
      await market.setMarketplaceFeeRecipient(charlie.address);
      await market.setMarketplaceFeeBps(feeBps);
      await market.renounceOwnership();

      expect(await market.owner()).to.equal(ethers.ZeroAddress);
      expect(await market.marketplaceFeeRecipient()).to.equal(charlie.address);
      expect(await market.marketplaceFeeBps()).to.equal(feeBps);
    });

    it("restricts admin functions to the owner", async function () {
      await expect(
        market.connect(alice).setPointsAddress(charlie.address)
      )
        .to.be.revertedWithCustomError(market, "OwnableUnauthorizedAccount")
        .withArgs(alice.address);

      await expect(market.connect(alice).setMarketplaceFeeBps(feeBps))
        .to.be.revertedWithCustomError(market, "OwnableUnauthorizedAccount")
        .withArgs(alice.address);

      await expect(market.connect(alice).setMarketplacePointsFeeUnit(1))
        .to.be.revertedWithCustomError(market, "OwnableUnauthorizedAccount")
        .withArgs(alice.address);

      await expect(
        market.connect(alice).setMarketplaceFeeRecipient(charlie.address)
      )
        .to.be.revertedWithCustomError(market, "OwnableUnauthorizedAccount")
        .withArgs(alice.address);

      await expect(market.connect(alice).pause())
        .to.be.revertedWithCustomError(market, "OwnableUnauthorizedAccount")
        .withArgs(alice.address);

      await expect(market.connect(alice).unpause())
        .to.be.revertedWithCustomError(market, "OwnableUnauthorizedAccount")
        .withArgs(alice.address);
    });

    it("pauses and unpauses fallback deposits and buys", async function () {
      await market.pause();

      await expect(
        alice.sendTransaction({
          to: await market.getAddress(),
          data: itemA,
        })
      ).to.be.revertedWithCustomError(market, "EnforcedPause");

      await expect(
        market.connect(bob).batchBuyHash([alice.address], [itemA], [priceA], {
          value: priceA,
        })
      ).to.be.revertedWithCustomError(market, "EnforcedPause");

      await market.unpause();
      await expect(
        alice.sendTransaction({
          to: await market.getAddress(),
          data: itemA,
        })
      ).not.to.be.reverted;
    });
  });

  describe("escrow deposits", function () {
    it("escrows a single hash through the fallback", async function () {
      await escrow(alice, itemA);

      expect(
        await market.userEthscriptionPossiblyStored(alice.address, itemA)
      ).to.equal(true);
      expect(
        await market.blocksRemainingUntilValidTransfer(alice.address, itemA)
      ).to.equal(5);
    });

    it("escrows multiple hashes through the fallback", async function () {
      await escrow(alice, itemA, itemB, itemC);

      expect(
        await market.userEthscriptionPossiblyStored(alice.address, itemA)
      ).to.equal(true);
      expect(
        await market.userEthscriptionPossiblyStored(alice.address, itemB)
      ).to.equal(true);
      expect(
        await market.userEthscriptionPossiblyStored(alice.address, itemC)
      ).to.equal(true);
    });

    it("rejects invalid calldata length", async function () {
      await expect(
        alice.sendTransaction({
          to: await market.getAddress(),
          data: "0x1234",
        })
      ).to.be.revertedWithCustomError(market, "InvalidEthscriptionLength");
    });

    it("rejects duplicate deposits from the same sender", async function () {
      await escrow(alice, itemA);

      await expect(escrow(alice, itemA)).to.be.revertedWithCustomError(
        market,
        "EthscriptionAlreadyReceivedFromSender"
      );
    });

    it("allows different senders to escrow the same hash independently", async function () {
      await escrow(alice, itemA);
      await escrow(bob, itemA);

      expect(
        await market.userEthscriptionPossiblyStored(alice.address, itemA)
      ).to.equal(true);
      expect(
        await market.userEthscriptionPossiblyStored(bob.address, itemA)
      ).to.equal(true);
    });
  });

  describe("listings", function () {
    it("lists an escrowed hash for public sale", async function () {
      await escrow(alice, itemA);

      await expect(market.connect(alice).offerHashForSale(itemA, priceA))
        .to.emit(market, "HashOffered")
        .withArgs(itemA, alice.address, priceA, ethers.ZeroAddress);

      const offer = await market.hashesOfferedForSale(alice.address, itemA);
      expect(offer.isForSale).to.equal(true);
      expect(offer.hashId).to.equal(itemA);
      expect(offer.seller).to.equal(alice.address);
      expect(offer.minValue).to.equal(priceA);
      expect(offer.onlySellTo).to.equal(ethers.ZeroAddress);
    });

    it("lists multiple escrowed hashes in a batch", async function () {
      await escrow(alice, itemA, itemB);

      await market
        .connect(alice)
        .batchOfferHashForSale([itemA, itemB], [priceA, priceB]);

      expect(
        (await market.hashesOfferedForSale(alice.address, itemA)).minValue
      ).to.equal(priceA);
      expect(
        (await market.hashesOfferedForSale(alice.address, itemB)).minValue
      ).to.equal(priceB);
    });

    it("keeps listings for the same hash isolated by seller", async function () {
      await escrow(alice, itemA);
      await escrow(bob, itemA);

      await market.connect(alice).offerHashForSale(itemA, priceA);
      await market.connect(bob).offerHashForSale(itemA, priceB);

      const aliceOffer = await market.hashesOfferedForSale(
        alice.address,
        itemA
      );
      const bobOffer = await market.hashesOfferedForSale(bob.address, itemA);

      expect(aliceOffer.isForSale).to.equal(true);
      expect(aliceOffer.seller).to.equal(alice.address);
      expect(aliceOffer.minValue).to.equal(priceA);
      expect(bobOffer.isForSale).to.equal(true);
      expect(bobOffer.seller).to.equal(bob.address);
      expect(bobOffer.minValue).to.equal(priceB);
    });

    it("rejects batch listing length mismatches", async function () {
      await escrow(alice, itemA);

      await expect(
        market.connect(alice).batchOfferHashForSale([itemA], [])
      ).to.be.revertedWithCustomError(market, "ArrayLengthMismatch");
    });

    it("lists an escrowed hash for a specific buyer", async function () {
      await escrow(alice, itemA);

      await expect(
        market
          .connect(alice)
          .offerHashForSaleToAddress(itemA, priceA, bob.address)
      )
        .to.emit(market, "HashOffered")
        .withArgs(itemA, alice.address, priceA, bob.address);

      expect(
        (await market.hashesOfferedForSale(alice.address, itemA)).onlySellTo
      ).to.equal(bob.address);
    });

    it("rejects listing hashes the caller has not escrowed", async function () {
      await expect(
        market.connect(alice).offerHashForSale(itemA, priceA)
      ).to.be.revertedWithCustomError(market, "NotEthscriptionOwner");

      await escrow(alice, itemA);

      await expect(
        market.connect(bob).offerHashForSaleToAddress(itemA, priceA, bob.address)
      ).to.be.revertedWithCustomError(market, "NotEthscriptionOwner");
    });

    it("cancels a listing", async function () {
      await escrow(alice, itemA);
      await market.connect(alice).offerHashForSale(itemA, priceA);

      await expect(market.connect(alice).hashNoLongerForSale(itemA))
        .to.emit(market, "HashNoLongerForSale")
        .withArgs(itemA, alice.address);

      const offer = await market.hashesOfferedForSale(alice.address, itemA);
      expect(offer.isForSale).to.equal(false);
      expect(offer.seller).to.equal(alice.address);
      expect(offer.minValue).to.equal(0);
    });

    it("requires escrow ownership to cancel a listing", async function () {
      await escrow(alice, itemA);
      await market.connect(alice).offerHashForSale(itemA, priceA);

      await expect(
        market.connect(bob).hashNoLongerForSale(itemA)
      ).to.be.revertedWithCustomError(market, "NotEthscriptionOwner");
    });
  });

  describe("deposit and list fallback", function () {
    it("escrows and lists publicly in one transaction", async function () {
      await expect(depositAndList(alice, itemA, priceA))
        .to.emit(market, "HashOffered")
        .withArgs(itemA, alice.address, priceA, ethers.ZeroAddress);

      const offer = await market.hashesOfferedForSale(alice.address, itemA);
      expect(offer.isForSale).to.equal(true);
      expect(offer.seller).to.equal(alice.address);
      expect(offer.minValue).to.equal(priceA);
      expect(offer.onlySellTo).to.equal(ethers.ZeroAddress);
      expect(
        await market.userEthscriptionPossiblyStored(alice.address, itemA)
      ).to.equal(true);
    });

    it("escrows and lists to a specific buyer in one transaction", async function () {
      await expect(depositAndList(alice, itemA, priceA, bob.address))
        .to.emit(market, "HashOffered")
        .withArgs(itemA, alice.address, priceA, bob.address);

      expect(
        (await market.hashesOfferedForSale(alice.address, itemA)).onlySellTo
      ).to.equal(bob.address);
    });

    it("rejects short deposit-and-list calldata", async function () {
      await expect(
        alice.sendTransaction({
          to: await market.getAddress(),
          data: ethers.concat([itemA, DEPOSIT_AND_LIST_SIGNATURE]),
        })
      ).to.be.revertedWithCustomError(market, "InvalidEthscriptionLength");

      await expect(
        alice.sendTransaction({
          to: await market.getAddress(),
          data: ethers.concat([
            itemA,
            DEPOSIT_AND_LIST_SIGNATURE,
            ethers.zeroPadValue(ethers.toBeHex(priceA), 32),
          ]),
        })
      ).to.be.revertedWithCustomError(market, "InvalidEthscriptionLength");
    });

    it("rejects deposit-and-list calldata with trailing words", async function () {
      await expect(
        alice.sendTransaction({
          to: await market.getAddress(),
          data: ethers.concat([
            itemA,
            DEPOSIT_AND_LIST_SIGNATURE,
            ethers.zeroPadValue(ethers.toBeHex(priceA), 32),
            ethers.zeroPadValue(ethers.ZeroAddress, 32),
            ethers.ZeroHash,
          ]),
        })
      ).to.be.revertedWithCustomError(market, "InvalidEthscriptionLength");
    });

    it("rejects deposit-and-list calldata with a non-canonical address word", async function () {
      const nonCanonicalAddressWord = ethers.toBeHex(
        (1n << 160n) + BigInt(bob.address),
        32
      );

      await expect(
        alice.sendTransaction({
          to: await market.getAddress(),
          data: ethers.concat([
            itemA,
            DEPOSIT_AND_LIST_SIGNATURE,
            ethers.zeroPadValue(ethers.toBeHex(priceA), 32),
            nonCanonicalAddressWord,
          ]),
        })
      )
        .to.be.revertedWithCustomError(market, "InvalidAddressWord")
        .withArgs(nonCanonicalAddressWord);
    });

    it("rejects duplicate deposit-and-list attempts", async function () {
      await depositAndList(alice, itemA, priceA);

      await expect(
        depositAndList(alice, itemA, priceA)
      ).to.be.revertedWithCustomError(
        market,
        "EthscriptionAlreadyReceivedFromSender"
      );
    });
  });

  describe("buying", function () {
    beforeEach(async function () {
      await depositAndList(alice, itemA, priceA);
      await mineCooldownBlocks();
    });

    it("buys a listed hash, credits the seller, emits transfers, and does not add points without fees", async function () {
      const tx = market
        .connect(bob)
        .batchBuyHash([alice.address], [itemA], [priceA], {
          value: priceA,
        });

      await expect(tx)
        .to.emit(market, "ethscriptions_protocol_TransferEthscriptionForPreviousOwner")
        .withArgs(alice.address, bob.address, itemA);
      await expect(tx)
        .to.emit(market, "HashBought")
        .withArgs(itemA, priceA, alice.address, bob.address);
      await expect(tx).to.changeEtherBalances(
        [market, bob],
        [priceA, -priceA]
      );

      const offer = await market.hashesOfferedForSale(alice.address, itemA);
      expect(offer.isForSale).to.equal(false);
      expect(offer.seller).to.equal(alice.address);
      expect(
        await market.userEthscriptionDefinitelyNotStored(alice.address, itemA)
      ).to.equal(true);
      expect(await points.points(alice.address)).to.equal(0);
      expect(await points.points(bob.address)).to.equal(0);
      expect(await market.pendingWithdrawals(alice.address)).to.equal(priceA);
    });

    it("credits the configured fee recipient and seller proceeds when fees are enabled", async function () {
      await market.setMarketplaceFeeRecipient(charlie.address);
      await market.setMarketplaceFeeBps(feeBps);

      const fee = (priceA * feeBps) / 10_000n;
      const sellerProceeds = priceA - fee;

      await expect(
        market.connect(bob).batchBuyHash([alice.address], [itemA], [priceA], {
          value: priceA,
        })
      ).to.changeEtherBalances(
        [market, bob],
        [priceA, -priceA]
      );

      expect(await market.pendingWithdrawals(charlie.address)).to.equal(fee);
      expect(await market.pendingWithdrawals(alice.address)).to.equal(
        sellerProceeds
      );
    });

    it("awards fee-based points to the seller and buyer when fees are enabled", async function () {
      await market.setMarketplaceFeeRecipient(charlie.address);
      await market.setMarketplaceFeeBps(feeBps);

      const fee = (priceA * feeBps) / 10_000n;
      const totalPoints = fee / (await market.marketplacePointsFeeUnit());
      const sellerPoints = totalPoints / 2n;
      const buyerPoints = totalPoints - sellerPoints;

      await market
        .connect(bob)
        .batchBuyHash([alice.address], [itemA], [priceA], {
          value: priceA,
        });

      expect(await points.points(alice.address)).to.equal(sellerPoints);
      expect(await points.points(bob.address)).to.equal(buyerPoints);
    });

    it("uses the marketplace points fee unit active at purchase time", async function () {
      const feeUnit = ethers.parseEther("0.005");

      await market.setMarketplaceFeeRecipient(charlie.address);
      await market.setMarketplaceFeeBps(feeBps);
      await market.setMarketplacePointsFeeUnit(feeUnit);

      const fee = (priceA * feeBps) / 10_000n;
      const totalPoints = fee / feeUnit;
      const sellerPoints = totalPoints / 2n;
      const buyerPoints = totalPoints - sellerPoints;

      await market
        .connect(bob)
        .batchBuyHash([alice.address], [itemA], [priceA], {
          value: priceA,
        });

      expect(await points.points(alice.address)).to.equal(sellerPoints);
      expect(await points.points(bob.address)).to.equal(buyerPoints);
    });

    it("credits the configured fee recipient after ownership is transferred", async function () {
      await market.setMarketplaceFeeRecipient(charlie.address);
      await market.setMarketplaceFeeBps(feeBps);
      await market.transferOwnership(bob.address);

      const fee = (priceA * feeBps) / 10_000n;
      const sellerProceeds = priceA - fee;

      await expect(
        market.connect(bob).batchBuyHash([alice.address], [itemA], [priceA], {
          value: priceA,
        })
      ).to.changeEtherBalances(
        [market, bob],
        [priceA, -priceA]
      );

      expect(await market.owner()).to.equal(bob.address);
      expect(await market.marketplaceFeeRecipient()).to.equal(charlie.address);
      expect(await market.pendingWithdrawals(charlie.address)).to.equal(fee);
      expect(await market.pendingWithdrawals(alice.address)).to.equal(
        sellerProceeds
      );
    });

    it("does not burn fees after ownership is renounced", async function () {
      await market.setMarketplaceFeeRecipient(charlie.address);
      await market.setMarketplaceFeeBps(feeBps);
      await market.renounceOwnership();

      const fee = (priceA * feeBps) / 10_000n;
      const sellerProceeds = priceA - fee;

      await expect(
        market.connect(bob).batchBuyHash([alice.address], [itemA], [priceA], {
          value: priceA,
        })
      ).to.changeEtherBalances(
        [market, bob],
        [priceA, -priceA]
      );

      expect(await market.marketplaceFeeRecipient()).to.equal(charlie.address);
      expect(await market.marketplaceFeeBps()).to.equal(feeBps);
      expect(await market.pendingWithdrawals(charlie.address)).to.equal(fee);
      expect(await market.pendingWithdrawals(alice.address)).to.equal(
        sellerProceeds
      );
    });

    it("buys multiple listings in a batch", async function () {
      await depositAndList(alice, itemB, priceB);
      await mineCooldownBlocks();

      const total = priceA + priceB;

      await expect(
        market
          .connect(bob)
          .batchBuyHash(
            [alice.address, alice.address],
            [itemA, itemB],
            [priceA, priceB],
            {
              value: total,
            }
          )
      )
        .to.emit(market, "HashBought")
        .withArgs(itemA, priceA, alice.address, bob.address)
        .and.to.emit(market, "HashBought")
        .withArgs(itemB, priceB, alice.address, bob.address);

      expect(
        (await market.hashesOfferedForSale(alice.address, itemA)).isForSale
      ).to.equal(false);
      expect(
        (await market.hashesOfferedForSale(alice.address, itemB)).isForSale
      ).to.equal(false);
      expect(await points.points(alice.address)).to.equal(0);
      expect(await points.points(bob.address)).to.equal(0);
      expect(await market.pendingWithdrawals(alice.address)).to.equal(total);
    });

    it("credits fees for every item in a batch buy", async function () {
      await depositAndList(alice, itemB, priceB);
      await mineCooldownBlocks();

      await market.setMarketplaceFeeRecipient(charlie.address);
      await market.setMarketplaceFeeBps(feeBps);

      const total = priceA + priceB;
      const expectedFee = (total * feeBps) / 10_000n;
      const expectedSellerProceeds = total - expectedFee;

      await market
        .connect(bob)
        .batchBuyHash(
          [alice.address, alice.address],
          [itemA, itemB],
          [priceA, priceB],
          { value: total }
        );

      expect(await market.pendingWithdrawals(charlie.address)).to.equal(
        expectedFee
      );
      expect(await market.pendingWithdrawals(alice.address)).to.equal(
        expectedSellerProceeds
      );

      const feeA = (priceA * feeBps) / 10_000n;
      const feeB = (priceB * feeBps) / 10_000n;
      const feeUnit = await market.marketplacePointsFeeUnit();
      const totalPointsA = feeA / feeUnit;
      const totalPointsB = feeB / feeUnit;
      const sellerPoints = totalPointsA / 2n + totalPointsB / 2n;
      const buyerPoints =
        (totalPointsA - totalPointsA / 2n) +
        (totalPointsB - totalPointsB / 2n);

      expect(await points.points(alice.address)).to.equal(sellerPoints);
      expect(await points.points(bob.address)).to.equal(buyerPoints);
    });

    it("rounds fee-based points down to zero for tiny fees", async function () {
      const tinyPrice = 39n;
      await depositAndList(alice, itemB, tinyPrice);
      await mineCooldownBlocks();
      await market.setMarketplaceFeeRecipient(charlie.address);
      await market.setMarketplaceFeeBps(feeBps);

      await market
        .connect(bob)
        .batchBuyHash([alice.address], [itemB], [tinyPrice], {
          value: tinyPrice,
        });

      expect(await points.points(alice.address)).to.equal(0);
      expect(await points.points(bob.address)).to.equal(0);
    });

    it("blocks purchases when fee-based points awarding fails", async function () {
      await market.setMarketplaceFeeRecipient(charlie.address);
      await market.setMarketplaceFeeBps(feeBps);
      await points.setRejectAdds(true);

      await expect(
        market.connect(bob).batchBuyHash([alice.address], [itemA], [priceA], {
          value: priceA,
        })
      ).to.be.revertedWith("Points rejected");

      expect(
        (await market.hashesOfferedForSale(alice.address, itemA)).isForSale
      ).to.equal(true);
      expect(await points.points(alice.address)).to.equal(0);
      expect(await points.points(bob.address)).to.equal(0);
      expect(await market.pendingWithdrawals(alice.address)).to.equal(0);
      expect(await market.pendingWithdrawals(charlie.address)).to.equal(0);
    });

    it("enforces the ethscription transfer cooldown", async function () {
      await depositAndList(bob, itemB, priceB);

      await expect(
        market.connect(alice).batchBuyHash([bob.address], [itemB], [priceB], {
          value: priceB,
        })
      ).to.be.revertedWithCustomError(market, "AdditionalCooldownRequired");
    });

    it("rejects array length mismatches", async function () {
      await expect(
        market.connect(bob).batchBuyHash([alice.address], [itemA], [], {
          value: priceA,
        })
      ).to.be.revertedWithCustomError(market, "ArrayLengthMismatch");

      await expect(
        market.connect(bob).batchBuyHash([], [itemA], [priceA], {
          value: priceA,
        })
      ).to.be.revertedWithCustomError(market, "ArrayLengthMismatch");
    });

    it("rejects incorrect ether values", async function () {
      await expect(
        market.connect(bob).batchBuyHash([alice.address], [itemA], [priceA], {
          value: priceA + 1n,
        })
      )
        .to.be.revertedWithCustomError(market, "IncorrectEtherValue")
        .withArgs(priceA + 1n, priceA);
    });

    it("rejects unlisted hashes", async function () {
      await expect(
        market.connect(bob).batchBuyHash([alice.address], [itemB], [priceB], {
          value: priceB,
        })
      )
        .to.be.revertedWithCustomError(market, "HashNotListedForSale")
        .withArgs(itemB);
    });

    it("rejects buying your own listing", async function () {
      await expect(
        market.connect(alice).batchBuyHash([alice.address], [itemA], [priceA], {
          value: priceA,
        })
      ).to.be.revertedWithCustomError(market, "CannotBuyOwnListing");
    });

    it("rejects a price mismatch", async function () {
      await expect(
        market
          .connect(bob)
          .batchBuyHash([alice.address], [itemA], [priceA - 1n], {
            value: priceA - 1n,
          })
      )
        .to.be.revertedWithCustomError(market, "PriceMismatch")
        .withArgs(priceA - 1n, priceA);
    });

    it("enforces private buyer restrictions", async function () {
      await depositAndList(alice, itemB, priceB, bob.address);
      await mineCooldownBlocks();

      await expect(
        market
          .connect(charlie)
          .batchBuyHash([alice.address], [itemB], [priceB], {
            value: priceB,
          })
      ).to.be.revertedWithCustomError(market, "OfferBuyerNotAuthorized");

      await expect(
        market.connect(bob).batchBuyHash([alice.address], [itemB], [priceB], {
          value: priceB,
        })
      ).to.emit(market, "HashBought");
    });

    it("buys the targeted seller listing when two sellers list the same hash", async function () {
      await depositAndList(bob, itemA, priceB);
      await mineCooldownBlocks();

      await expect(
        market
          .connect(charlie)
          .batchBuyHash([bob.address], [itemA], [priceB], {
            value: priceB,
          })
      )
        .to.emit(market, "HashBought")
        .withArgs(itemA, priceB, bob.address, charlie.address);

      expect(
        (await market.hashesOfferedForSale(bob.address, itemA)).isForSale
      ).to.equal(false);
      expect(
        (await market.hashesOfferedForSale(alice.address, itemA)).isForSale
      ).to.equal(true);
    });
  });

  describe("payment withdrawals", function () {
    it("credits pending fee and seller payments without sending directly", async function () {
      const feeRecipient = await deployRejectingSeller();
      const seller = await deployRejectingSeller();

      await market.setMarketplaceFeeRecipient(await feeRecipient.getAddress());
      await market.setMarketplaceFeeBps(feeBps);

      await seller.depositAndList(
        await market.getAddress(),
        itemA,
        DEPOSIT_AND_LIST_SIGNATURE,
        priceA,
        ethers.ZeroAddress
      );
      await mineCooldownBlocks();

      await market
        .connect(bob)
        .batchBuyHash([await seller.getAddress()], [itemA], [priceA], {
          value: priceA,
        });

      const fee = (priceA * feeBps) / 10_000n;
      expect(await market.pendingWithdrawals(await seller.getAddress())).to.equal(
        priceA - fee
      );
      expect(
        await market.pendingWithdrawals(await feeRecipient.getAddress())
      ).to.equal(fee);
      expect(await ethers.provider.getBalance(await market.getAddress())).to.equal(
        priceA
      );
    });

    it("credits seller payments for withdrawal", async function () {
      const seller = await deployRejectingSeller();

      await seller.depositAndList(
        await market.getAddress(),
        itemA,
        DEPOSIT_AND_LIST_SIGNATURE,
        priceA,
        ethers.ZeroAddress
      );
      await mineCooldownBlocks();

      await expect(
        market
          .connect(bob)
          .batchBuyHash([await seller.getAddress()], [itemA], [priceA], {
            value: priceA,
          })
      ).to.emit(market, "HashBought");

      expect(await market.pendingWithdrawals(await seller.getAddress())).to.equal(
        priceA
      );
      expect(await ethers.provider.getBalance(await market.getAddress())).to.equal(
        priceA
      );
    });

    it("lets a seller withdraw pending payments once they can receive ether", async function () {
      const seller = await deployRejectingSeller();

      await seller.depositAndList(
        await market.getAddress(),
        itemA,
        DEPOSIT_AND_LIST_SIGNATURE,
        priceA,
        ethers.ZeroAddress
      );
      await mineCooldownBlocks();

      await market
        .connect(bob)
        .batchBuyHash([await seller.getAddress()], [itemA], [priceA], {
          value: priceA,
        });

      await expect(
        seller.withdrawPayments(await market.getAddress())
      ).to.be.revertedWithCustomError(market, "EtherTransferFailed");

      await seller.setRejectEther(false);

      await expect(
        seller.withdrawPayments(await market.getAddress())
      ).to.changeEtherBalances([seller], [priceA]);

      expect(await market.pendingWithdrawals(await seller.getAddress())).to.equal(
        0
      );
    });

    it("lets a seller redirect pending payments to a payable recipient", async function () {
      const seller = await deployRejectingSeller();

      await seller.depositAndList(
        await market.getAddress(),
        itemA,
        DEPOSIT_AND_LIST_SIGNATURE,
        priceA,
        ethers.ZeroAddress
      );
      await mineCooldownBlocks();

      await market
        .connect(bob)
        .batchBuyHash([await seller.getAddress()], [itemA], [priceA], {
          value: priceA,
        });

      await expect(
        seller.withdrawPayments(await market.getAddress())
      ).to.be.revertedWithCustomError(market, "EtherTransferFailed");

      await expect(
        seller.withdrawPaymentsTo(await market.getAddress(), alice.address)
      ).to.changeEtherBalances([alice], [priceA]);

      expect(await market.pendingWithdrawals(await seller.getAddress())).to.equal(
        0
      );
    });

    it("rejects withdrawals when there is nothing to withdraw", async function () {
      await expect(market.connect(alice).withdraw()).to.be.revertedWithCustomError(
        market,
        "NothingToWithdraw"
      );
    });

    it("rejects withdrawal redirects to the zero address", async function () {
      await depositAndList(alice, itemA, priceA);
      await mineCooldownBlocks();

      await market.connect(bob).batchBuyHash([alice.address], [itemA], [priceA], {
        value: priceA,
      });

      await expect(
        market.connect(alice).withdrawTo(ethers.ZeroAddress)
      )
        .to.be.revertedWithCustomError(market, "InvalidWithdrawalRecipient")
        .withArgs(ethers.ZeroAddress);
    });
  });

  describe("ethscription withdrawals", function () {
    it("withdraws an escrowed hash after cooldown", async function () {
      await escrow(alice, itemA);
      await mineCooldownBlocks();

      await expect(market.connect(alice).withdrawHash(itemA))
        .to.emit(market, "ethscriptions_protocol_TransferEthscriptionForPreviousOwner")
        .withArgs(alice.address, alice.address, itemA);

      expect(
        await market.userEthscriptionDefinitelyNotStored(alice.address, itemA)
      ).to.equal(true);
    });

    it("invalidates an active listing when the seller withdraws the hash", async function () {
      await depositAndList(alice, itemA, priceA);
      await mineCooldownBlocks();

      await expect(market.connect(alice).withdrawHash(itemA))
        .to.emit(market, "HashNoLongerForSale")
        .withArgs(itemA, alice.address);

      expect(
        (await market.hashesOfferedForSale(alice.address, itemA)).isForSale
      ).to.equal(false);
    });

    it("withdraws multiple hashes in a batch", async function () {
      await escrow(alice, itemA, itemB);
      await mineCooldownBlocks();

      const tx = market.connect(alice).withdrawBatchHashes([itemA, itemB]);

      await expect(tx)
        .to.emit(market, "ethscriptions_protocol_TransferEthscriptionForPreviousOwner")
        .withArgs(alice.address, alice.address, itemA);
      await expect(tx)
        .to.emit(market, "ethscriptions_protocol_TransferEthscriptionForPreviousOwner")
        .withArgs(alice.address, alice.address, itemB);
    });

    it("rejects withdraws by non-owners or before cooldown", async function () {
      await escrow(alice, itemA);

      await expect(
        market.connect(bob).withdrawHash(itemA)
      ).to.be.revertedWithCustomError(market, "NotEthscriptionOwner");

      await expect(
        market.connect(alice).withdrawHash(itemA)
      ).to.be.revertedWithCustomError(market, "AdditionalCooldownRequired");
    });
  });
});
