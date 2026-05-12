/**
 * SessionVoucherService — OKX APP v1.0 `session` intent integration (PREVIEW)
 * ---------------------------------------------------------------------------
 *
 * Replaces the legacy x402 stub with a monotonic-voucher batching path
 * borrowed from OKX Agent Payments Protocol v1.0 (April 2026).
 *
 * Current state: this service is a **stub** matching the design doc at
 *   Project/docs/contracts/OKX_session_voucher_design.md
 *
 * It exposes the shape the runtime will call once the on-chain
 * `submitSessionVoucher(...)` function lands in SubscriptionEscrow V2.
 * Until then `settleBatch` falls back to the existing per-tick path
 * (`drainPerCheckIn`) — no behavior change.
 *
 * Rollout (per design doc):
 *   Pre-demo (now → 2026-05-18):
 *     - This stub committed; ABI/UI re-labeled to OKX session voucher
 *     - No contract changes (too risky for demo day)
 *   Post-demo (2026-05-19 → 2026-06-02):
 *     - Solidity prototype + Foundry tests
 *     - EIP-712 client signature flow in frontend
 *     - This service wired to submitSessionVoucher end-to-end
 */

const SESSION_VOUCHER_DOMAIN = Object.freeze({
  name: "zer0Gig SessionVoucher",
  version: "1",
  chainId: 16602, // 0G Newton
});

const SESSION_VOUCHER_TYPES = Object.freeze({
  SessionVoucher: [
    { name: "subId",          type: "uint256" },
    { name: "sequence",       type: "uint64"  },
    { name: "settledAt",      type: "uint64"  },
    { name: "amount",         type: "uint96"  },
    { name: "alignmentScore", type: "uint16"  },
    { name: "outputHash",     type: "bytes32" },
  ],
});

const VOUCHER_MODE = Object.freeze({
  DELEGATED:        0, // client signs template once; agent submits monotonically
  EXPLICIT_CONFIRM: 1, // client confirms each batch via wallet / Telegram push
});

class SessionVoucherService {
  /**
   * @param {object} args
   * @param {bigint} args.subId
   * @param {object} args.sub             — subscription struct from contract read
   * @param {object} args.signer          — ethers Wallet (agent)
   * @param {object} args.alignmentOracle — { signSessionVoucher(voucher): Promise<string> }
   * @param {object} args.contract        — ethers Contract for SubscriptionEscrow
   * @param {object} args.logger
   */
  constructor({ subId, sub, signer, alignmentOracle, contract, logger }) {
    this.subId = subId;
    this.sub = sub;
    this.signer = signer;
    this.oracle = alignmentOracle;
    this.contract = contract;
    this.logger = logger;

    // V1 contract has no lastVoucherSeq slot → initialise locally at 0.
    // After V2 redeploy, read sub.lastVoucherSeq / sub.totalDrainedViaVoucher.
    this.lastSeq = 0n;
    this.lastAmount = 0n;
  }

  static get DOMAIN() { return SESSION_VOUCHER_DOMAIN; }
  static get TYPES()  { return SESSION_VOUCHER_TYPES; }
  static get MODE()   { return VOUCHER_MODE; }

  /**
   * Build the EIP-712 voucher payload. Pure function — no IO.
   */
  buildVoucher({ ticksCount, outputHash, alignmentScore, settledAt }) {
    const newSeq    = this.lastSeq + BigInt(ticksCount);
    const newAmount = this.lastAmount + (BigInt(this.sub.checkInRate) * BigInt(ticksCount));
    return {
      subId:          this.subId,
      sequence:       newSeq,
      settledAt:      settledAt ?? BigInt(Math.floor(Date.now() / 1000)),
      amount:         newAmount,
      alignmentScore: alignmentScore | 0,
      outputHash,
    };
  }

  /**
   * Submit a batched settlement for N ticks.
   *
   * V1 (now): falls back to `drainPerCheckIn` (per-tick on-chain).
   * V2 (post-demo): calls `submitSessionVoucher(voucher, clientSig, alignmentSig)`.
   *
   * @returns {Promise<{txHash: string|null, fallback: boolean, voucher: object}>}
   */
  async settleBatch({ ticksCount, outputHash, alignmentScore, clientSig }) {
    const voucher = this.buildVoucher({ ticksCount, outputHash, alignmentScore });

    if (typeof this.contract?.submitSessionVoucher !== "function") {
      // V1 deployment — voucher consumer not on chain yet.
      this.logger?.info?.("[sessionVoucher] V1 fallback — submitSessionVoucher not on chain; deferring to drainPerCheckIn loop");
      return { txHash: null, fallback: true, voucher };
    }

    // V2 (future) path
    const alignmentSig = await this.oracle.signSessionVoucher(voucher);
    const tx = await this.contract.submitSessionVoucher(voucher, clientSig, alignmentSig);
    const receipt = await tx.wait();

    this.lastSeq    = voucher.sequence;
    this.lastAmount = voucher.amount;

    return { txHash: receipt.hash, fallback: false, voucher };
  }
}

export { SessionVoucherService, SESSION_VOUCHER_DOMAIN, SESSION_VOUCHER_TYPES, VOUCHER_MODE };
