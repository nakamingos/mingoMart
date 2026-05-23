// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

interface IMingoMartMarketInitializable {
    function initialize(
        uint256 contractVersion,
        address initialPointsAddress
    ) external;
}

contract MingoMartMarketProxy is TransparentUpgradeableProxy {
    constructor(
        address implementation,
        uint256 contractVersion,
        address initialPointsAddress
    ) TransparentUpgradeableProxy(
        implementation,
        msg.sender,
        abi.encodeCall(
            IMingoMartMarketInitializable.initialize,
            (contractVersion, initialPointsAddress)
        )
    ) {}
}
