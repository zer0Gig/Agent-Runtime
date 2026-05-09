/**
 * EventWatcher — block-polling alternative to ethers `contract.on(event, handler)`.
 *
 * Why this exists:
 *   The 0G Newton testnet RPC drops `eth_newFilter` filters after a short
 *   inactivity window. ethers v6 then spams the console with
 *     "filter not found (-32000)" / "could not coalesce error"
 *   on every poll cycle until the process is restarted.
 *
 * Strategy:
 *   - Track last seen block per watcher.
 *   - Every `intervalMs`, call `contract.queryFilter(eventName, fromBlock, toBlock)`.
 *   - That uses `eth_getLogs` under the hood — stateless on the RPC, so it
 *     can never expire.
 *   - Each handler call is wrapped in try/catch so one failing event does
 *     not kill the watcher.
 *
 * Usage:
 *   const w = new EventWatcher(escrow, "MilestoneDefined", async (jobId, count) => {...});
 *   await w.start();
 *   // ...later
 *   w.stop();
 */

export class EventWatcher {
  /**
   * @param {import("ethers").Contract} contract
   * @param {string} eventName
   * @param {(...args:any[]) => Promise<void>|void} handler  receives (...event.args, eventLog)
   * @param {object} [opts]
   * @param {number} [opts.intervalMs=6000]   poll cadence
   * @param {number} [opts.maxBlockSpan=2000] safety: don't request huge ranges if RPC was down
   * @param {string} [opts.label]             prefix for log lines
   */
  constructor(contract, eventName, handler, opts = {}) {
    this.contract     = contract;
    this.eventName    = eventName;
    this.handler      = handler;
    this.intervalMs   = opts.intervalMs   ?? 6000;
    this.maxBlockSpan = opts.maxBlockSpan ?? 2000;
    this.label        = opts.label        ?? `[EventWatcher:${eventName}]`;

    /** @type {NodeJS.Timeout|null} */
    this._timer        = null;
    this._lastBlock    = 0;
    this._busy         = false;
    this._consecutiveFailures = 0;
  }

  async start() {
    const provider = this.contract.runner?.provider ?? this.contract.provider;
    if (!provider) throw new Error(`${this.label} contract has no provider`);

    try {
      this._lastBlock = await provider.getBlockNumber();
    } catch (err) {
      console.warn(`${this.label} could not read initial block:`, err?.message || err);
      this._lastBlock = 0;
    }

    this._timer = setInterval(() => this._tick(), this.intervalMs);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  async _tick() {
    if (this._busy) return;
    this._busy = true;

    try {
      const provider = this.contract.runner?.provider ?? this.contract.provider;
      const head = await provider.getBlockNumber();

      if (head <= this._lastBlock) {
        this._busy = false;
        return;
      }

      // Cap range so we don't request 100k blocks if the runtime was offline.
      const from = Math.max(this._lastBlock + 1, head - this.maxBlockSpan);
      const to   = head;

      const logs = await this.contract.queryFilter(this.eventName, from, to);
      this._consecutiveFailures = 0;

      for (const log of logs) {
        try {
          // ethers v6 returns EventLog with .args (parsed) when ABI matches
          const args = Array.isArray(log.args) ? Array.from(log.args) : [];
          await this.handler(...args, log);
        } catch (err) {
          console.error(`${this.label} handler threw:`, err?.message || err);
        }
      }

      this._lastBlock = head;
    } catch (err) {
      this._consecutiveFailures += 1;
      // Quiet for transient RPC blips; loud after 5 consecutive failures
      if (this._consecutiveFailures >= 5 && this._consecutiveFailures % 5 === 0) {
        console.warn(
          `${this.label} ${this._consecutiveFailures} consecutive poll failures:`,
          err?.message || err
        );
      }
    } finally {
      this._busy = false;
    }
  }
}
