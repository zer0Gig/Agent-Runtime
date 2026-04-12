/**
 * Event Listener — On-Chain Alert Emission
 *
 * Emits alerts as on-chain events to SubscriptionEscrow.sol
 * Uses drainPerAlert to trigger payment and fire AlertFired event
 */

// NEW-1 FIX: Use ESM syntax (project has "type": "module" in package.json)
// NEW-3 FIX: All imports at top level (static declarations)
import { ethers } from 'ethers';

// This will be injected with SubscriptionEscrow contract instance
let subscriptionEscrow = null;

export function setSubscriptionEscrow(contract) {
  subscriptionEscrow = contract;
  console.log('[EventListener] SubscriptionEscrow contract set');
}

export async function emitOnChainAlert(type, payload) {
  if (!subscriptionEscrow) throw new Error('SubscriptionEscrow not initialized');

  // HIGH-2 FIX: Use drainPerAlert (the actual function on SubscriptionEscrow.sol)
  // encode alert data as bytes (ethers already imported at top level)
  const alertData = ethers.AbiCoder.defaultAbiCoder().encode(
    ['string', 'string', 'uint256'],
    [type, payload.reason || 'unknown', payload.severity || 0]
  );
  
  try {
    const tx = await subscriptionEscrow.drainPerAlert(payload.subId, alertData);
    const receipt = await tx.wait();
    
    console.log(`[EventListener] On-chain alert emitted. TX: ${receipt.hash}`);
    return { txHash: receipt.hash, event: 'AlertFired', gasUsed: receipt.cumulativeGasUsed };
  } catch (error) {
    console.error('[EventListener] Failed to emit on-chain alert:', error.message);
    throw error;
  }
}