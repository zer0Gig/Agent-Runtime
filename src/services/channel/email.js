/**
 * Email Transport Layer — SMTP Delivery
 *
 * Sends alerts via email using configured SMTP server
 */

import * as nodemailer from 'nodemailer';

// Create transporter with environment config
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.EMAIL_PORT) || 587,
  secure: process.env.EMAIL_SECURE === 'true',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

export async function sendEmail(type, payload) {
  const to = payload.email || process.env.ALERT_EMAIL_TO;
  if (!to) {
    console.warn('[Email] No email recipient configured, skipping delivery');
    return null;
  }

  const subject = getSubject(type, payload);
  const html = getHtmlBody(type, payload);

  try {
    const info = await transporter.sendMail({
      from: process.env.EMAIL_FROM || 'noreply@zer0gig.app',
      to,
      subject,
      html,
    });

    console.log(`[Email] Sent to ${to} - Message ID: ${info.messageId}`);
    return { messageId: info.messageId, to };
  } catch (error) {
    console.error(`[Email] Failed to send to ${to}:`, error.message);
    throw error;
  }
}

function getSubject(type, payload) {
  switch (type) {
    case 'subscription_failed':
      return `🚨 Subscription Failed: ${payload.subId}`;
    case 'payment_drained':
      return `💰 Payment Drained: ${payload.subId}`;
    case 'anomaly_detected':
      return `⚠️ Anomaly Detected: ${payload.metric}`;
    case 'balance_low':
      return `📉 Balance Low: ${payload.currentBalance}`;
    default:
      return `zer0Gig Alert: ${type}`;
  }
}

function getHtmlBody(type, payload) {
  // Generate formatted HTML email body
  return `<html>
    <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
      <h2 style="color: #2c3e50;">zer0Gig Alert</h2>
      <div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin: 10px 0;">
        <p><strong>Alert Type:</strong> ${type}</p>
        <p><strong>Subscription ID:</strong> ${payload.subId || 'N/A'}</p>
        <p><strong>Agent ID:</strong> ${payload.agentId || 'N/A'}</p>
        <p><strong>Timestamp:</strong> ${new Date(payload.timestamp).toISOString()}</p>
      </div>
      <div style="margin-top: 15px;">
        <h3>Alert Details</h3>
        <pre style="background-color: #f1f1f1; padding: 10px; border-radius: 3px; overflow-x: auto;">
${JSON.stringify(payload, null, 2)}
        </pre>
      </div>
      <hr style="margin: 20px 0;" />
      <small>This alert was sent automatically by the zer0Gig platform.</small>
    </body>
  </html>`;
}