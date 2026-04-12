/**
 * Webhook Transport Layer — HTTP POST Delivery
 *
 * Sends alerts via HTTP POST to client-specified URLs
 * Supports per-subscription webhook URLs from contract
 */

import axios from 'axios';

export async function sendWebhook(type, payload) {
  // NEW-1 FIX: Use per-subscription webhookUrl from payload, fallback to env
  // NEW-3 FIX: Import at top level (ESM compliant)
  const url = payload.webhookUrl || process.env.ALERT_WEBHOOK_URL;
  if (!url) {
    console.warn('[Webhook] No webhook URL configured, skipping delivery');
    return null;
  }

  try {
    const response = await axios.post(url, {
      type,
      payload,
      timestamp: Date.now(),
    }, {
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'zer0Gig/2.0',
        'X-Alert-Type': type,
      },
      timeout: 10000, // 10 second timeout
    });

    console.log(`[Webhook] Delivered to ${url} - Status: ${response.status}`);
    return { status: response.status, data: response.data, url };
  } catch (error) {
    console.error(`[Webhook] Failed to deliver to ${url}:`, error.message);
    throw error;
  }
}