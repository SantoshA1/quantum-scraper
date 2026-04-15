/* ─────────────────────────────────────────────────────────────
 *  Webhook HMAC Authentication  (Audit Fix C-7)
 *  Shared signing & verification logic for all webhook calls
 *  in the Quantum Trading Pipeline.
 *
 *  Protocol:
 *    Sender computes HMAC-SHA256 of the JSON body using a shared
 *    secret and sends it in the X-Webhook-Signature header as:
 *      X-Webhook-Signature: sha256=<hex digest>
 *    Receiver recomputes the HMAC and compares (timing-safe).
 *
 *  Shared secret: WEBHOOK_SECRET env var (required).
 *  Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 * ───────────────────────────────────────────────────────────── */
'use strict';

const crypto = require('crypto');

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

/**
 * Sign a JSON payload for outbound webhook calls.
 * @param {string} jsonBody - The stringified JSON body
 * @returns {string} Signature header value: "sha256=<hex>"
 */
function signPayload(jsonBody) {
  if (!WEBHOOK_SECRET) {
    throw new Error('WEBHOOK_SECRET env var is not set. Cannot sign webhook payload.');
  }
  const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET).update(jsonBody).digest('hex');
  return `sha256=${hmac}`;
}

/**
 * Verify an inbound webhook signature (timing-safe comparison).
 * @param {string} jsonBody - Raw request body as string
 * @param {string} signatureHeader - Value of X-Webhook-Signature header
 * @returns {{ valid: boolean, reason?: string }}
 */
function verifySignature(jsonBody, signatureHeader) {
  if (!WEBHOOK_SECRET) {
    return { valid: false, reason: 'WEBHOOK_SECRET env var is not set on receiver.' };
  }
  if (!signatureHeader) {
    return { valid: false, reason: 'Missing X-Webhook-Signature header.' };
  }
  if (!signatureHeader.startsWith('sha256=')) {
    return { valid: false, reason: 'Invalid signature format. Expected sha256=<hex>.' };
  }

  const receivedSig = signatureHeader.slice(7); // strip "sha256="
  const expectedSig = crypto.createHmac('sha256', WEBHOOK_SECRET).update(jsonBody).digest('hex');

  // Timing-safe comparison to prevent timing attacks
  const receivedBuf = Buffer.from(receivedSig, 'hex');
  const expectedBuf = Buffer.from(expectedSig, 'hex');

  if (receivedBuf.length !== expectedBuf.length) {
    return { valid: false, reason: 'Signature length mismatch.' };
  }

  if (!crypto.timingSafeEqual(receivedBuf, expectedBuf)) {
    return { valid: false, reason: 'Signature does not match. Request rejected.' };
  }

  return { valid: true };
}

module.exports = { signPayload, verifySignature, WEBHOOK_SECRET };
