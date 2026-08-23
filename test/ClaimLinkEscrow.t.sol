// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ClaimLinkEscrow} from "../src/ClaimLinkEscrow.sol";

contract ClaimLinkEscrowTest is Test {
    uint256 private constant ONE_USDC_NATIVE = 1e18;
    uint256 private constant CLAIM_SIGNER_KEY = 0xA11CE;
    uint256 private constant OTHER_SIGNER_KEY = 0xB0B;
    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    ClaimLinkEscrow private escrow;
    address private sender;
    address private otherSender;
    address private recipient;
    address private attacker;
    address private claimSigner;

    event ClaimLinkCreated(
        bytes32 indexed linkId, address indexed sender, address indexed claimSigner, uint256 amount, uint256 expiresAt
    );
    event ClaimLinkClaimed(bytes32 indexed linkId, address indexed recipient, uint256 amount);
    event ClaimLinkRefunded(bytes32 indexed linkId, address indexed sender, uint256 amount);

    function setUp() public {
        vm.warp(1_700_000_000);
        escrow = new ClaimLinkEscrow();
        sender = makeAddr("sender");
        otherSender = makeAddr("other sender");
        recipient = makeAddr("recipient");
        attacker = makeAddr("attacker");
        claimSigner = vm.addr(CLAIM_SIGNER_KEY);
        vm.deal(sender, 100 * ONE_USDC_NATIVE);
        vm.deal(otherSender, 100 * ONE_USDC_NATIVE);
    }

    function testCreateStoresExactPaymentAndDeterministicId() public {
        bytes32 expectedLinkId = keccak256(abi.encode(sender, claimSigner));
        uint256 expectedExpiry = block.timestamp + 7 days;

        vm.expectEmit(true, true, true, true, address(escrow));
        emit ClaimLinkCreated(expectedLinkId, sender, claimSigner, 3 * ONE_USDC_NATIVE, expectedExpiry);
        vm.prank(sender);
        bytes32 linkId = escrow.createClaimLink{value: 3 * ONE_USDC_NATIVE}(claimSigner);

        assertEq(linkId, expectedLinkId);
        assertEq(escrow.computeLinkId(sender, claimSigner), expectedLinkId);
        (
            address storedSender,
            address storedClaimSigner,
            uint256 amount,
            uint256 expiresAt,
            ClaimLinkEscrow.PaymentStatus status
        ) = escrow.payments(linkId);
        assertEq(storedSender, sender);
        assertEq(storedClaimSigner, claimSigner);
        assertEq(amount, 3 * ONE_USDC_NATIVE);
        assertEq(expiresAt, expectedExpiry);
        assertEq(uint256(status), uint256(ClaimLinkEscrow.PaymentStatus.Active));
        assertEq(address(escrow).balance, 3 * ONE_USDC_NATIVE);
        assertEq(escrow.senderLinkCount(sender), 1);
        assertEq(escrow.senderLinkAt(sender, 0), linkId);
    }

    function testCreateRejectsZeroAmount() public {
        vm.prank(sender);
        vm.expectRevert(ClaimLinkEscrow.ZeroAmount.selector);
        escrow.createClaimLink(claimSigner);
    }

    function testCreateRejectsZeroClaimSigner() public {
        vm.prank(sender);
        vm.expectRevert(ClaimLinkEscrow.InvalidClaimSigner.selector);
        escrow.createClaimLink{value: ONE_USDC_NATIVE}(address(0));
    }

    function testCannotReuseSenderAndClaimSignerAfterCreation() public {
        bytes32 linkId = _create(sender, CLAIM_SIGNER_KEY, ONE_USDC_NATIVE);

        vm.prank(sender);
        vm.expectRevert(abi.encodeWithSelector(ClaimLinkEscrow.LinkAlreadyExists.selector, linkId));
        escrow.createClaimLink{value: ONE_USDC_NATIVE}(claimSigner);
    }

    function testCannotReuseSenderAndClaimSignerAfterClaim() public {
        bytes32 linkId = _create(sender, CLAIM_SIGNER_KEY, ONE_USDC_NATIVE);
        bytes memory signature = _signature(escrow, linkId, recipient, CLAIM_SIGNER_KEY);
        vm.prank(recipient);
        escrow.claim(linkId, signature);

        vm.prank(sender);
        vm.expectRevert(abi.encodeWithSelector(ClaimLinkEscrow.LinkAlreadyExists.selector, linkId));
        escrow.createClaimLink{value: ONE_USDC_NATIVE}(claimSigner);
    }

    function testCannotReuseSenderAndClaimSignerAfterRefund() public {
        bytes32 linkId = _create(sender, CLAIM_SIGNER_KEY, ONE_USDC_NATIVE);
        (,,, uint256 expiresAt,) = escrow.payments(linkId);
        vm.warp(expiresAt);
        vm.prank(sender);
        escrow.refund(linkId);

        vm.prank(sender);
        vm.expectRevert(abi.encodeWithSelector(ClaimLinkEscrow.LinkAlreadyExists.selector, linkId));
        escrow.createClaimLink{value: ONE_USDC_NATIVE}(claimSigner);
    }

    function testSameClaimSignerHasIndependentIdsForDifferentSenders() public {
        bytes32 first = _create(sender, CLAIM_SIGNER_KEY, ONE_USDC_NATIVE);
        bytes32 second = _create(otherSender, CLAIM_SIGNER_KEY, 2 * ONE_USDC_NATIVE);

        assertNotEq(first, second);
        assertEq(first, keccak256(abi.encode(sender, claimSigner)));
        assertEq(second, keccak256(abi.encode(otherSender, claimSigner)));
    }

    function testSignatureCannotBeReplayedAcrossDifferentLinkIds() public {
        bytes32 first = _create(sender, CLAIM_SIGNER_KEY, ONE_USDC_NATIVE);
        bytes32 second = _create(otherSender, CLAIM_SIGNER_KEY, 2 * ONE_USDC_NATIVE);
        bytes memory firstSignature = _signature(escrow, first, recipient, CLAIM_SIGNER_KEY);

        vm.prank(recipient);
        vm.expectRevert(ClaimLinkEscrow.InvalidSignature.selector);
        escrow.claim(second, firstSignature);

        (,,,, ClaimLinkEscrow.PaymentStatus firstStatus) = escrow.payments(first);
        (,,,, ClaimLinkEscrow.PaymentStatus secondStatus) = escrow.payments(second);
        assertEq(uint256(firstStatus), uint256(ClaimLinkEscrow.PaymentStatus.Active));
        assertEq(uint256(secondStatus), uint256(ClaimLinkEscrow.PaymentStatus.Active));
    }

    function testDirectNativeTransferIsRejected() public {
        uint256 senderBalanceBefore = sender.balance;

        vm.prank(sender);
        (bool success,) = address(escrow).call{value: ONE_USDC_NATIVE}("");

        assertFalse(success);
        assertEq(address(escrow).balance, 0);
        assertEq(sender.balance, senderBalanceBefore);
    }

    function testClaimPaysCallerAndPreservesTerminalRecord() public {
        bytes32 linkId = _create(sender, CLAIM_SIGNER_KEY, 3 * ONE_USDC_NATIVE);
        bytes memory signature = _signature(escrow, linkId, recipient, CLAIM_SIGNER_KEY);

        vm.expectEmit(true, true, false, true, address(escrow));
        emit ClaimLinkClaimed(linkId, recipient, 3 * ONE_USDC_NATIVE);
        vm.prank(recipient);
        escrow.claim(linkId, signature);

        assertEq(recipient.balance, 3 * ONE_USDC_NATIVE);
        assertEq(address(escrow).balance, 0);
        (
            address storedSender,
            address storedClaimSigner,
            uint256 amount,
            uint256 expiresAt,
            ClaimLinkEscrow.PaymentStatus status
        ) = escrow.payments(linkId);
        assertEq(storedSender, sender);
        assertEq(storedClaimSigner, claimSigner);
        assertEq(amount, 3 * ONE_USDC_NATIVE);
        assertEq(expiresAt, 1_700_000_000 + 7 days);
        assertEq(uint256(status), uint256(ClaimLinkEscrow.PaymentStatus.Claimed));
    }

    function testClaimSucceedsOneSecondBeforeExpiry() public {
        bytes32 linkId = _create(sender, CLAIM_SIGNER_KEY, ONE_USDC_NATIVE);
        (,,, uint256 expiresAt,) = escrow.payments(linkId);
        bytes memory signature = _signature(escrow, linkId, recipient, CLAIM_SIGNER_KEY);
        vm.warp(expiresAt - 1);

        vm.prank(recipient);
        escrow.claim(linkId, signature);

        assertEq(recipient.balance, ONE_USDC_NATIVE);
    }

    function testClaimFailsExactlyAtExpiry() public {
        bytes32 linkId = _create(sender, CLAIM_SIGNER_KEY, ONE_USDC_NATIVE);
        (,,, uint256 expiresAt,) = escrow.payments(linkId);
        bytes memory signature = _signature(escrow, linkId, recipient, CLAIM_SIGNER_KEY);
        vm.warp(expiresAt);

        vm.prank(recipient);
        vm.expectRevert(abi.encodeWithSelector(ClaimLinkEscrow.ClaimExpired.selector, expiresAt));
        escrow.claim(linkId, signature);
    }

    function testSenderCanRefundExactlyAtExpiry() public {
        bytes32 linkId = _create(sender, CLAIM_SIGNER_KEY, 2 * ONE_USDC_NATIVE);
        (,,, uint256 expiresAt,) = escrow.payments(linkId);
        uint256 balanceBefore = sender.balance;
        vm.warp(expiresAt);

        vm.expectEmit(true, true, false, true, address(escrow));
        emit ClaimLinkRefunded(linkId, sender, 2 * ONE_USDC_NATIVE);
        vm.prank(sender);
        escrow.refund(linkId);

        assertEq(sender.balance, balanceBefore + 2 * ONE_USDC_NATIVE);
        (,,,, ClaimLinkEscrow.PaymentStatus status) = escrow.payments(linkId);
        assertEq(uint256(status), uint256(ClaimLinkEscrow.PaymentStatus.Refunded));
    }

    function testRefundFailsBeforeExpiry() public {
        bytes32 linkId = _create(sender, CLAIM_SIGNER_KEY, ONE_USDC_NATIVE);
        (,,, uint256 expiresAt,) = escrow.payments(linkId);

        vm.prank(sender);
        vm.expectRevert(abi.encodeWithSelector(ClaimLinkEscrow.RefundNotAvailable.selector, expiresAt));
        escrow.refund(linkId);
    }

    function testOnlyOriginalSenderCanRefund() public {
        bytes32 linkId = _create(sender, CLAIM_SIGNER_KEY, ONE_USDC_NATIVE);
        (,,, uint256 expiresAt,) = escrow.payments(linkId);
        vm.warp(expiresAt);

        vm.prank(attacker);
        vm.expectRevert(ClaimLinkEscrow.UnauthorizedSender.selector);
        escrow.refund(linkId);
    }

    function testCopiedSignatureCannotRedirectPayment() public {
        bytes32 linkId = _create(sender, CLAIM_SIGNER_KEY, ONE_USDC_NATIVE);
        bytes memory signatureForRecipient = _signature(escrow, linkId, recipient, CLAIM_SIGNER_KEY);

        vm.prank(attacker);
        vm.expectRevert(ClaimLinkEscrow.InvalidSignature.selector);
        escrow.claim(linkId, signatureForRecipient);

        assertEq(attacker.balance, 0);
        (,,,, ClaimLinkEscrow.PaymentStatus status) = escrow.payments(linkId);
        assertEq(uint256(status), uint256(ClaimLinkEscrow.PaymentStatus.Active));
    }

    function testWrongSignerIsRejected() public {
        bytes32 linkId = _create(sender, CLAIM_SIGNER_KEY, ONE_USDC_NATIVE);
        bytes memory signature = _signature(escrow, linkId, recipient, OTHER_SIGNER_KEY);

        vm.prank(recipient);
        vm.expectRevert(ClaimLinkEscrow.InvalidSignature.selector);
        escrow.claim(linkId, signature);
    }

    function testSignatureForAnotherContractIsRejected() public {
        bytes32 linkId = _create(sender, CLAIM_SIGNER_KEY, ONE_USDC_NATIVE);
        ClaimLinkEscrow otherEscrow = new ClaimLinkEscrow();
        bytes memory signature = _signature(otherEscrow, linkId, recipient, CLAIM_SIGNER_KEY);

        vm.prank(recipient);
        vm.expectRevert(ClaimLinkEscrow.InvalidSignature.selector);
        escrow.claim(linkId, signature);
    }

    function testSignatureForAnotherChainIsRejected() public {
        bytes32 linkId = _create(sender, CLAIM_SIGNER_KEY, ONE_USDC_NATIVE);
        bytes32 wrongDomainSeparator = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes(escrow.EIP712_NAME())),
                keccak256(bytes(escrow.EIP712_VERSION())),
                block.chainid + 1,
                address(escrow)
            )
        );
        bytes32 structHash = keccak256(abi.encode(escrow.CLAIM_TYPEHASH(), linkId, recipient));
        bytes32 wrongChainDigest = keccak256(abi.encodePacked("\x19\x01", wrongDomainSeparator, structHash));
        bytes memory signature = _signDigest(CLAIM_SIGNER_KEY, wrongChainDigest);

        vm.prank(recipient);
        vm.expectRevert(ClaimLinkEscrow.InvalidSignature.selector);
        escrow.claim(linkId, signature);
    }

    function testMalformedSignatureIsRejected() public {
        bytes32 linkId = _create(sender, CLAIM_SIGNER_KEY, ONE_USDC_NATIVE);

        vm.prank(recipient);
        vm.expectRevert(ClaimLinkEscrow.InvalidSignature.selector);
        escrow.claim(linkId, hex"1234");
    }

    function testHighSSignatureIsRejected() public {
        bytes32 linkId = _create(sender, CLAIM_SIGNER_KEY, ONE_USDC_NATIVE);
        bytes32 digest = escrow.claimDigest(linkId, recipient);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(CLAIM_SIGNER_KEY, digest);
        bytes32 highS = bytes32(SECP256K1_ORDER - uint256(s));
        uint8 highV = v == 27 ? 28 : 27;
        bytes memory malleableSignature = abi.encodePacked(r, highS, highV);

        vm.prank(recipient);
        vm.expectRevert(ClaimLinkEscrow.InvalidSignature.selector);
        escrow.claim(linkId, malleableSignature);
    }

    function testClaimCannotBeReplayed() public {
        bytes32 linkId = _create(sender, CLAIM_SIGNER_KEY, ONE_USDC_NATIVE);
        bytes memory signature = _signature(escrow, linkId, recipient, CLAIM_SIGNER_KEY);
        vm.prank(recipient);
        escrow.claim(linkId, signature);

        vm.prank(recipient);
        vm.expectRevert(abi.encodeWithSelector(ClaimLinkEscrow.PaymentNotActive.selector, linkId));
        escrow.claim(linkId, signature);
    }

    function testRefundCannotBeRepeatedOrClaimedAfterward() public {
        bytes32 linkId = _create(sender, CLAIM_SIGNER_KEY, ONE_USDC_NATIVE);
        (,,, uint256 expiresAt,) = escrow.payments(linkId);
        vm.warp(expiresAt);
        vm.prank(sender);
        escrow.refund(linkId);

        vm.prank(sender);
        vm.expectRevert(abi.encodeWithSelector(ClaimLinkEscrow.PaymentNotActive.selector, linkId));
        escrow.refund(linkId);

        bytes memory signature = _signature(escrow, linkId, recipient, CLAIM_SIGNER_KEY);
        vm.prank(recipient);
        vm.expectRevert(abi.encodeWithSelector(ClaimLinkEscrow.PaymentNotActive.selector, linkId));
        escrow.claim(linkId, signature);
    }

    function testClaimTransferFailureRollsBackAndCanBeRetried() public {
        RejectingWallet wallet = new RejectingWallet();
        bytes32 linkId = _create(sender, CLAIM_SIGNER_KEY, 2 * ONE_USDC_NATIVE);
        bytes memory signature = _signature(escrow, linkId, address(wallet), CLAIM_SIGNER_KEY);

        vm.expectRevert(ClaimLinkEscrow.TransferFailed.selector);
        wallet.claim(escrow, linkId, signature);

        (,,,, ClaimLinkEscrow.PaymentStatus statusAfterFailure) = escrow.payments(linkId);
        assertEq(uint256(statusAfterFailure), uint256(ClaimLinkEscrow.PaymentStatus.Active));
        assertEq(address(escrow).balance, 2 * ONE_USDC_NATIVE);

        wallet.setRejectPayments(false);
        wallet.claim(escrow, linkId, signature);
        assertEq(address(wallet).balance, 2 * ONE_USDC_NATIVE);
        (,,,, ClaimLinkEscrow.PaymentStatus statusAfterRetry) = escrow.payments(linkId);
        assertEq(uint256(statusAfterRetry), uint256(ClaimLinkEscrow.PaymentStatus.Claimed));
    }

    function testRefundTransferFailureRollsBackAndCanBeRetried() public {
        RejectingWallet wallet = new RejectingWallet();
        vm.deal(address(this), 2 * ONE_USDC_NATIVE);
        bytes32 linkId = wallet.create{value: 2 * ONE_USDC_NATIVE}(escrow, claimSigner);
        (,,, uint256 expiresAt,) = escrow.payments(linkId);
        vm.warp(expiresAt);

        vm.expectRevert(ClaimLinkEscrow.TransferFailed.selector);
        wallet.refund(escrow, linkId);
        (,,,, ClaimLinkEscrow.PaymentStatus statusAfterFailure) = escrow.payments(linkId);
        assertEq(uint256(statusAfterFailure), uint256(ClaimLinkEscrow.PaymentStatus.Active));

        wallet.setRejectPayments(false);
        wallet.refund(escrow, linkId);
        assertEq(address(wallet).balance, 2 * ONE_USDC_NATIVE);
        (,,,, ClaimLinkEscrow.PaymentStatus statusAfterRetry) = escrow.payments(linkId);
        assertEq(uint256(statusAfterRetry), uint256(ClaimLinkEscrow.PaymentStatus.Refunded));
    }

    function testClaimBlocksReentrancyAndPaysOnlyOnce() public {
        ReentrantClaimRecipient reentrantRecipient = new ReentrantClaimRecipient();
        bytes32 linkId = _create(sender, CLAIM_SIGNER_KEY, 2 * ONE_USDC_NATIVE);
        bytes memory signature = _signature(escrow, linkId, address(reentrantRecipient), CLAIM_SIGNER_KEY);

        reentrantRecipient.claim(escrow, linkId, signature);

        assertTrue(reentrantRecipient.reentryAttempted());
        assertFalse(reentrantRecipient.reentrySucceeded());
        assertEq(reentrantRecipient.reentryError(), bytes4(keccak256("ReentrancyGuardReentrantCall()")));
        assertEq(address(reentrantRecipient).balance, 2 * ONE_USDC_NATIVE);
        assertEq(address(escrow).balance, 0);
    }

    function testRefundBlocksReentrancyAndPaysOnlyOnce() public {
        ReentrantRefundSender reentrantSender = new ReentrantRefundSender();
        vm.deal(address(this), 2 * ONE_USDC_NATIVE);
        bytes32 linkId = reentrantSender.create{value: 2 * ONE_USDC_NATIVE}(escrow, claimSigner);
        (,,, uint256 expiresAt,) = escrow.payments(linkId);
        vm.warp(expiresAt);

        reentrantSender.refund();

        assertTrue(reentrantSender.reentryAttempted());
        assertFalse(reentrantSender.reentrySucceeded());
        assertEq(reentrantSender.reentryError(), bytes4(keccak256("ReentrancyGuardReentrantCall()")));
        assertEq(address(reentrantSender).balance, 2 * ONE_USDC_NATIVE);
        assertEq(address(escrow).balance, 0);
        (,,,, ClaimLinkEscrow.PaymentStatus status) = escrow.payments(linkId);
        assertEq(uint256(status), uint256(ClaimLinkEscrow.PaymentStatus.Refunded));
    }

    function testForcedBalanceCannotIncreaseClaimAmount() public {
        bytes32 linkId = _create(sender, CLAIM_SIGNER_KEY, 2 * ONE_USDC_NATIVE);
        ForceNative force = new ForceNative{value: 5 * ONE_USDC_NATIVE}();
        force.sendTo(payable(address(escrow)));
        assertEq(address(escrow).balance, 7 * ONE_USDC_NATIVE);

        bytes memory signature = _signature(escrow, linkId, recipient, CLAIM_SIGNER_KEY);
        vm.prank(recipient);
        escrow.claim(linkId, signature);

        assertEq(recipient.balance, 2 * ONE_USDC_NATIVE);
        assertEq(address(escrow).balance, 5 * ONE_USDC_NATIVE);
    }

    function testMultiplePaymentsRemainExactlyIsolated() public {
        bytes32 firstLinkId = _create(sender, CLAIM_SIGNER_KEY, 2 * ONE_USDC_NATIVE);
        bytes32 secondLinkId = _create(sender, OTHER_SIGNER_KEY, 3 * ONE_USDC_NATIVE);

        bytes memory signature = _signature(escrow, firstLinkId, recipient, CLAIM_SIGNER_KEY);
        vm.prank(recipient);
        escrow.claim(firstLinkId, signature);

        assertEq(recipient.balance, 2 * ONE_USDC_NATIVE);
        assertEq(address(escrow).balance, 3 * ONE_USDC_NATIVE);
        (,, uint256 secondAmount, uint256 secondExpiry, ClaimLinkEscrow.PaymentStatus secondStatus) =
            escrow.payments(secondLinkId);
        assertEq(secondAmount, 3 * ONE_USDC_NATIVE);
        assertEq(uint256(secondStatus), uint256(ClaimLinkEscrow.PaymentStatus.Active));

        uint256 senderBalanceBeforeRefund = sender.balance;
        vm.warp(secondExpiry);
        vm.prank(sender);
        escrow.refund(secondLinkId);
        assertEq(sender.balance, senderBalanceBeforeRefund + 3 * ONE_USDC_NATIVE);
        assertEq(address(escrow).balance, 0);
    }

    function testSenderEnumerationIsIsolatedAndPermanent() public {
        bytes32 senderFirst = _create(sender, CLAIM_SIGNER_KEY, ONE_USDC_NATIVE);
        bytes32 senderSecond = _create(sender, OTHER_SIGNER_KEY, 2 * ONE_USDC_NATIVE);
        bytes32 otherLink = _create(otherSender, CLAIM_SIGNER_KEY, 3 * ONE_USDC_NATIVE);

        assertEq(escrow.senderLinkCount(sender), 2);
        assertEq(escrow.senderLinkAt(sender, 0), senderFirst);
        assertEq(escrow.senderLinkAt(sender, 1), senderSecond);
        assertEq(escrow.senderLinkCount(otherSender), 1);
        assertEq(escrow.senderLinkAt(otherSender, 0), otherLink);

        bytes memory signature = _signature(escrow, senderFirst, recipient, CLAIM_SIGNER_KEY);
        vm.prank(recipient);
        escrow.claim(senderFirst, signature);
        assertEq(escrow.senderLinkCount(sender), 2);
        assertEq(escrow.senderLinkAt(sender, 0), senderFirst);

        vm.expectRevert(abi.encodeWithSelector(ClaimLinkEscrow.SenderLinkIndexOutOfBounds.selector, sender, 2));
        escrow.senderLinkAt(sender, 2);
    }

    function testUnknownPaymentCannotBeClaimedOrRefunded() public {
        bytes32 unknown = keccak256("unknown");

        vm.expectRevert(abi.encodeWithSelector(ClaimLinkEscrow.PaymentNotActive.selector, unknown));
        escrow.claim(unknown, hex"");

        vm.expectRevert(abi.encodeWithSelector(ClaimLinkEscrow.PaymentNotActive.selector, unknown));
        escrow.refund(unknown);
    }

    function testFuzzClaimTransfersExactlyStoredAmount(uint96 rawAmount, uint96 rawForcedAmount) public {
        uint256 amount = bound(uint256(rawAmount), 1, 1_000_000 * ONE_USDC_NATIVE);
        uint256 forcedAmount = bound(uint256(rawForcedAmount), 0, 1_000_000 * ONE_USDC_NATIVE);
        vm.deal(sender, amount);
        bytes32 linkId = _create(sender, CLAIM_SIGNER_KEY, amount);
        vm.deal(address(escrow), amount + forcedAmount);

        bytes memory signature = _signature(escrow, linkId, recipient, CLAIM_SIGNER_KEY);
        vm.prank(recipient);
        escrow.claim(linkId, signature);

        assertEq(recipient.balance, amount);
        assertEq(address(escrow).balance, forcedAmount);
    }

    function testFuzzLinkIdMatchesAbiEncoding(address fuzzSender, uint256 rawSignerKey) public view {
        uint256 signerKey = bound(rawSignerKey, 1, SECP256K1_ORDER - 1);
        address fuzzClaimSigner = vm.addr(signerKey);
        assertEq(escrow.computeLinkId(fuzzSender, fuzzClaimSigner), keccak256(abi.encode(fuzzSender, fuzzClaimSigner)));
    }

    function _create(address from, uint256 signerKey, uint256 amount) private returns (bytes32) {
        vm.prank(from);
        return escrow.createClaimLink{value: amount}(vm.addr(signerKey));
    }

    function _signature(ClaimLinkEscrow target, bytes32 linkId, address to, uint256 signerKey)
        private
        view
        returns (bytes memory)
    {
        return _signDigest(signerKey, target.claimDigest(linkId, to));
    }

    function _signDigest(uint256 signerKey, bytes32 digest) private pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        return abi.encodePacked(r, s, v);
    }
}

contract RejectingWallet {
    bool private _rejectPayments = true;

    function setRejectPayments(bool rejectPayments) external {
        _rejectPayments = rejectPayments;
    }

    function create(ClaimLinkEscrow escrow, address claimSigner) external payable returns (bytes32) {
        return escrow.createClaimLink{value: msg.value}(claimSigner);
    }

    function claim(ClaimLinkEscrow escrow, bytes32 linkId, bytes calldata signature) external {
        escrow.claim(linkId, signature);
    }

    function refund(ClaimLinkEscrow escrow, bytes32 linkId) external {
        escrow.refund(linkId);
    }

    receive() external payable {
        if (_rejectPayments) revert();
    }
}

contract ReentrantClaimRecipient {
    ClaimLinkEscrow private _escrow;
    bytes32 private _linkId;
    bytes private _signature;
    bool public reentryAttempted;
    bool public reentrySucceeded;
    bytes4 public reentryError;

    function claim(ClaimLinkEscrow escrow, bytes32 linkId, bytes calldata signature) external {
        _escrow = escrow;
        _linkId = linkId;
        _signature = signature;
        escrow.claim(linkId, signature);
    }

    receive() external payable {
        if (reentryAttempted) return;
        reentryAttempted = true;
        bytes memory returnData;
        (reentrySucceeded, returnData) =
            address(_escrow).call(abi.encodeCall(ClaimLinkEscrow.claim, (_linkId, _signature)));
        if (returnData.length >= 4) {
            bytes4 selector;
            assembly ("memory-safe") {
                selector := mload(add(returnData, 0x20))
            }
            reentryError = selector;
        }
    }
}

contract ReentrantRefundSender {
    ClaimLinkEscrow private _escrow;
    bytes32 private _linkId;
    bool public reentryAttempted;
    bool public reentrySucceeded;
    bytes4 public reentryError;

    function create(ClaimLinkEscrow escrow, address claimSigner) external payable returns (bytes32 linkId) {
        _escrow = escrow;
        linkId = escrow.createClaimLink{value: msg.value}(claimSigner);
        _linkId = linkId;
    }

    function refund() external {
        _escrow.refund(_linkId);
    }

    receive() external payable {
        if (reentryAttempted) return;
        reentryAttempted = true;
        bytes memory returnData;
        (reentrySucceeded, returnData) = address(_escrow).call(abi.encodeCall(ClaimLinkEscrow.refund, (_linkId)));
        if (returnData.length >= 4) {
            bytes4 selector;
            assembly ("memory-safe") {
                selector := mload(add(returnData, 0x20))
            }
            reentryError = selector;
        }
    }
}

contract ForceNative {
    constructor() payable {}

    function sendTo(address payable target) external {
        selfdestruct(target);
    }
}
