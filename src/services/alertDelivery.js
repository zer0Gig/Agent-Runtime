/**
 * Alert Delivery System — Real-time Notifications for zer0Gig
 *
 * Delivers alerts via multiple channels:
 * - Webhook POST to client-specified URLs
 * - On-chain events to SubscriptionEscrow
 * - Email notifications (optional)
 * - Push notifications (future)
 */

import { ethers } from "ethers";
import { sendWebhook } from "./channel/webhook.js";
import { sendEmail } from "./channel/email.js";
import { emitOnChainAlert } from "./eventListener.js";

const ALERT_TYPES = {
  SUBSCRIPTION_FAILED: 'subscription_failed',
  PAYMENT_DRAINED: 'payment_drained',
  JOB_COMPLETED: 'job_completed',
  ANOMALY_DETECTED: 'anomaly_detected',
  CHECKIN_SUCCESS: 'checkin_success',
  BALANCE_LOW: 'balance_low',
};

export class AlertDelivery {
  constructor({ wallet, escrowAddress, storageService }) {
    this.wallet = wallet;
    this.escrowAddress = escrowAddress;
    this.storage = storageService;
    this.escrow = null; // Will be set after contract initialization
    
    this.transports = {
      webhook: sendWebhook,
      email: sendEmail,
      onchain: emitOnChainAlert,
    };

    // Retry configuration for failed deliveries
    this.retryConfig = {
      maxRetries: 3,
      baseDelayMs: 1000, // 1 second
      maxDelayMs: 30000, // 30 seconds
    };
  }

  /**
   * Initialize with the subscription escrow contract
   */
  async initialize(escrowContract) {
    this.escrow = escrowContract;
    console.log("[AlertDelivery] Initialized with escrow contract");
  }

  /**
   * Send alert via configured channels
   * @param {string} type - ALERT_TYPES
   * @param {object} payload - Alert context
   * @param {string[]} channels - Array of transport channels
   */
  async sendAlert(type, payload, channels = ['webhook', 'onchain']) {
    const alerts = [];
    
    for (const channel of channels) {
      if (!this.transports[channel]) {
        console.warn(`[AlertDelivery] Unknown alert channel: ${channel}`);
        continue;
      }
      
      try {
        const result = await this.transports[channel](type, payload);
        alerts.push({ channel, success: true, result });
      } catch (error) {
        console.error(`[AlertDelivery] Failed to send via ${channel}:`, error.message);
        
        // Attempt retry for failed deliveries
        const retryResult = await this._retryDelivery(channel, type, payload);
        alerts.push({ channel, success: retryResult.success, result: retryResult.result, error: error.message });
      }
    }
    
    return alerts;
  }

  /**
   * Retry failed delivery attempts
   */
  async _retryDelivery(channel, type, payload) {
    for (let attempt = 1; attempt <= this.retryConfig.maxRetries; attempt++) {
      try {
        await new Promise(resolve => setTimeout(resolve, this.retryConfig.baseDelayMs * Math.pow(2, attempt - 1)));
        const result = await this.transports[channel](type, payload);
        return { success: true, result };
      } catch (error) {
        console.warn(`[AlertDelivery] Retry attempt ${attempt} failed:`, error.message);
        if (attempt === this.retryConfig.maxRetries) {
          return { success: false, result: null, error: error.message };
        }
      }
    }
  }

  /**
   * Send subscription failure alert
   */
  async sendSubscriptionFailure(subId, agentId, reason) {
    return this.sendAlert(ALERT_TYPES.SUBSCRIPTION_FAILED, {
      subId,
      agentId,
      reason,
      timestamp: Date.now(),
    }, ['webhook', 'email', 'onchain']);
  }

  /**
   * Send payment drained alert
   */
  async sendPaymentDrained(subId, agentId, amount, channel) {
    return this.sendAlert(ALERT_TYPES.PAYMENT_DRAINED, {
      subId,
      agentId,
      amount,
      channel,
      timestamp: Date.now(),
    }, ['webhook', 'onchain']);
  }

  /**
   * Send job completed alert
   */
  async sendJobCompleted(jobId, agentId, result) {
    return this.sendAlert(ALERT_TYPES.JOB_COMPLETED, {
      jobId,
      agentId,
      result,
      timestamp: Date.now(),
    }, ['webhook']);
  }

  /**
   * Send anomaly detected alert
   */
  async sendAnomalyDetected(subId, agentId, metric, threshold, value) {
    return this.sendAlert(ALERT_TYPES.ANOMALY_DETECTED, {
      subId,
      agentId,
      metric,
      threshold,
      value,
      timestamp: Date.now(),
    }, ['webhook', 'email', 'onchain']);
  }

  /**
   * Send check-in success alert
   */
  async sendCheckInSuccess(subId, agentId) {
    return this.sendAlert(ALERT_TYPES.CHECKIN_SUCCESS, {
      subId,
      agentId,
      timestamp: Date.now(),
    }, ['onchain']);
  }

  /**
   * Send balance low alert
   */
  async sendBalanceLow(subId, agentId, currentBalance, threshold) {
    return this.sendAlert(ALERT_TYPES.BALANCE_LOW, {
      subId,
      agentId,
      currentBalance,
      threshold,
      timestamp: Date.now(),
    }, ['webhook', 'email']);
  }

  /**
   * Get alert history for a subscription
   */
  async getAlertHistory(subId) {
    const checkpoint = await this.storage.readCheckpoint(`alert-${subId}`);
    if (!checkpoint) return [];
    
    // In production, this would query on-chain events
    // For MVP, return last few alerts from checkpoint
    return checkpoint.alertHistory || [];
  }

  /**
   * Record alert in history
   */
  async recordAlert(subId, alertType, payload) {
    const checkpoint = await this.storage.readCheckpoint(`alert-${subId}`);
    const alertHistory = checkpoint?.alertHistory || [];
    
    // Keep last 50 alerts to prevent unlimited growth
    if (alertHistory.length >= 50) {
      alertHistory.shift(); // Remove oldest
    }
    
    alertHistory.push({
      type: alertType,
      payload,
      timestamp: Date.now(),
    });
    
    await this.storage.saveCheckpoint(`alert-${subId}`, {
      ...checkpoint,
      alertHistory,
    });
  }
}

export { ALERT_TYPES };