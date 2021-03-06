/* global artifacts */
const ethers = require("ethers");
const truffleAssert = require("truffle-assertions");

const GuardianManager = artifacts.require("GuardianManager");
const LockStorage = artifacts.require("LockStorage");
const GuardianStorage = artifacts.require("GuardianStorage");
const Proxy = artifacts.require("Proxy");
const BaseWallet = artifacts.require("BaseWallet");
const RelayerManager = artifacts.require("RelayerManager");
const VersionManager = artifacts.require("VersionManager");
const Registry = artifacts.require("ModuleRegistry");
const TestFeature = artifacts.require("TestFeature");
const TransferStorage = artifacts.require("TransferStorage");
const LimitStorage = artifacts.require("LimitStorage");
const TokenPriceRegistry = artifacts.require("TokenPriceRegistry");
const TransferManager = artifacts.require("TransferManager");
const UpgraderToVersionManager = artifacts.require("UpgraderToVersionManager");

const RelayManager = require("../utils/relay-manager");

contract("VersionManager", (accounts) => {
  const manager = new RelayManager(accounts);
  const owner = accounts[1];

  let wallet;
  let walletImplementation;
  let registry;
  let lockStorage;
  let guardianStorage;
  let guardianManager;
  let relayerManager;
  let versionManager;
  let testFeature;

  before(async () => {
    walletImplementation = await BaseWallet.new();
  });

  beforeEach(async () => {
    registry = await Registry.new();
    lockStorage = await LockStorage.new();
    guardianStorage = await GuardianStorage.new();
    versionManager = await VersionManager.new(
      registry.address,
      lockStorage.address,
      guardianStorage.address,
      ethers.constants.AddressZero,
      ethers.constants.AddressZero);
    relayerManager = await RelayerManager.new(
      lockStorage.address,
      guardianStorage.address,
      ethers.constants.AddressZero,
      ethers.constants.AddressZero,
      versionManager.address);
    guardianManager = await GuardianManager.new(
      lockStorage.address,
      guardianStorage.address,
      versionManager.address,
      24,
      12);
    testFeature = await TestFeature.new(
      lockStorage.address,
      versionManager.address,
      42);
    await versionManager.addVersion([guardianManager.address, relayerManager.address, testFeature.address], []);
    await manager.setRelayerManager(relayerManager);

    const proxy = await Proxy.new(walletImplementation.address);
    wallet = await BaseWallet.at(proxy.address);
    await wallet.init(owner, [versionManager.address]);
    await versionManager.upgradeWallet(wallet.address, await versionManager.lastVersion(), { from: owner });
  });

  describe("VersionManager owner", () => {
    it("should not let the VersionManager owner add a storage twice", async () => {
      await truffleAssert.reverts(versionManager.addStorage(lockStorage.address), "VM: storage already added");
    });

    it("should not let the VersionManager owner add an inconsistent version", async () => {
      // Should fail: the _featuresToInit array includes a feature not listed in the _features array
      await truffleAssert.reverts(
        versionManager.addVersion([relayerManager.address], [guardianManager.address]),
        "VM: invalid _featuresToInit",
      );
    });
  });

  describe("Wallet owner", () => {
    it("should make unsupported static call fail", async () => {
      // add a new version without TestFeature's static calls
      await versionManager.addVersion([guardianManager.address, relayerManager.address], []);
      await versionManager.upgradeWallet(wallet.address, await versionManager.lastVersion(), { from: owner });
      const walletAsTestFeature = await TestFeature.at(wallet.address);
      await truffleAssert.reverts(
        walletAsTestFeature.getBoolean(),
        "VM: static call not supported for wallet version");
      // cleanup: re-add previous version
      await versionManager.addVersion([guardianManager.address, relayerManager.address, testFeature.address], []);
    });

    it("should skip init() when feature was already authorised in previous version", async () => {
      const numInitsBefore = await testFeature.numInits(wallet.address);
      await versionManager.addVersion(
        [guardianManager.address, relayerManager.address, testFeature.address], [testFeature.address]
      );
      await versionManager.upgradeWallet(wallet.address, await versionManager.lastVersion(), { from: owner });
      const numInitsAfter = await testFeature.numInits(wallet.address);
      assert.isTrue(numInitsBefore.eq(numInitsAfter), "numInits should be unchanged");
    });

    it("should not let the relayer call a forbidden method", async () => {
      await truffleAssert.reverts(
        manager.relay(versionManager, "setOwner", [wallet.address, owner], wallet, [owner]),
        "VM: unknown method",
      );
    });

    it("should not let non-feature call setOwner", async () => {
      await truffleAssert.reverts(
        versionManager.setOwner(wallet.address, owner),
        "VM: sender should be authorized feature",
      );
    });

    it("should not let non-feature call invokeStorage", async () => {
      await truffleAssert.reverts(
        versionManager.invokeStorage(wallet.address, owner, "0x"),
        "VM: sender may not invoke storage",
      );
    });

    it("should not let non-feature call checkAuthorisedFeatureAndInvokeWallet", async () => {
      await truffleAssert.reverts(
        versionManager.checkAuthorisedFeatureAndInvokeWallet(wallet.address, owner, 0, "0x"),
        "VM: sender may not invoke wallet",
      );
    });

    it("should not let non-feature call upgradeWallet", async () => {
      await truffleAssert.reverts(
        versionManager.upgradeWallet(wallet.address, 0),
        "VM: sender may not upgrade wallet",
      );
    });

    it("should fail to upgrade a wallet with an invalid version", async () => {
      await truffleAssert.reverts(
        versionManager.upgradeWallet(wallet.address, 666, { from: owner }),
        "VM: invalid _toVersion",
      );
    });

    it("should fail to upgrade a wallet when already on the last version", async () => {
      const lastVersion = await versionManager.lastVersion();
      await truffleAssert.reverts(
        versionManager.upgradeWallet(wallet.address, lastVersion, { from: owner }),
        "VM: already on new version",
      );
    });

    it("should not let a feature call an unauthorised storage", async () => {
      // Note: we are calling the deprecated GuardianStorage.setLock so this particular method gets touched by coverage
      const data1 = guardianStorage.contract.methods.setLock(wallet.address, 1).encodeABI();

      await testFeature.invokeStorage(wallet.address, guardianStorage.address, data1, { from: owner });
      let lock = await guardianStorage.getLock(wallet.address);
      assert.equal(lock, 1, "Lock should have been set");
      const data0 = guardianStorage.contract.methods.setLock(wallet.address, 0).encodeABI();

      await testFeature.invokeStorage(wallet.address, guardianStorage.address, data0, { from: owner });
      lock = await guardianStorage.getLock(wallet.address);
      assert.equal(lock, 0, "Lock should have been unset");

      const newGuardianStorage = await GuardianStorage.new(); // not authorised in VersionManager
      await truffleAssert.reverts(
        testFeature.invokeStorage(wallet.address, newGuardianStorage.address, data1, { from: owner }),
        "VM: invalid storage invoked",
      );
      lock = await newGuardianStorage.getLock(wallet.address);
      assert.equal(lock, 0, "Lock should not be set");
    });

    it("should not let a feature call a storage using bad data", async () => {
      const badData = guardianStorage.contract.methods.setLock(accounts[2], 1).encodeABI(); // bad wallet address
      await truffleAssert.reverts(
        testFeature.invokeStorage(wallet.address, ethers.constants.AddressZero, badData, { from: owner }),
        "VM: target of _data != _wallet",
      );
    });

    it("should not let a feature call a storage using bad data", async () => {
      let badData = guardianStorage.contract.methods.setLock(wallet.address, 1).encodeABI();
      badData = `0x11223344${badData.slice(10)}`; // bad method signature
      await truffleAssert.reverts(
        testFeature.invokeStorage(wallet.address, guardianStorage.address, badData, { from: owner }),
        "VM: _storage failed",
      );
    });

    it("should not allow the fallback to be called via a non-static call", async () => {
      // Deploy new VersionManager with TransferManager
      const versionManager2 = await VersionManager.new(
        registry.address,
        lockStorage.address,
        guardianStorage.address,
        ethers.constants.AddressZero,
        ethers.constants.AddressZero);
      const tokenPriceRegistry = await TokenPriceRegistry.new();
      const transferStorage = await TransferStorage.new();
      const limitStorage = await LimitStorage.new();
      const transferManager = await TransferManager.new(
        lockStorage.address,
        transferStorage.address,
        limitStorage.address,
        tokenPriceRegistry.address,
        versionManager2.address,
        3600,
        3600,
        10000,
        ethers.constants.AddressZero);
      await versionManager2.addVersion([transferManager.address], []);
      await registry.registerModule(versionManager2.address, ethers.utils.formatBytes32String("VersionManager2"));

      // Deploy Upgrader to new VersionManager
      const upgrader = await UpgraderToVersionManager.new(
        registry.address,
        lockStorage.address,
        [versionManager.address], // toDisable
        versionManager2.address);
      await registry.registerModule(upgrader.address, ethers.utils.formatBytes32String("Upgrader"));

      // Upgrade wallet to new VersionManger
      await versionManager.addModule(wallet.address, upgrader.address, { from: owner });

      // Attempt to call a malicious (non-static) call on the old VersionManager
      const data = await testFeature.contract.methods.badStaticCall().encodeABI();
      await truffleAssert.reverts(
        transferManager.callContract(wallet.address, versionManager.address, 0, data, { from: owner }),
        "VM: not in a staticcall",
      );
    });
  });
});
