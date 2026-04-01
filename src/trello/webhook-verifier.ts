import * as crypto from 'crypto';

/**
 * Verifies the Trello webhook signature using HMAC-SHA1.
 *
 * Trello signs each webhook request by computing
 *   HMAC-SHA1(appSecret, requestBody + callbackURL)
 * and sends the base64-encoded result in the `x-trello-webhook` header.
 */
export function verifyTrelloWebhookSignature(
  requestBody: string,
  callbackUrl: string,
  appSecret: string,
  headerSignature: string,
): boolean {
  const computedDigest = crypto
    .createHmac('sha1', appSecret)
    .update(requestBody + callbackUrl)
    .digest('base64');

  const computedBuffer = Buffer.from(computedDigest, 'utf-8');
  const headerBuffer = Buffer.from(headerSignature, 'utf-8');

  if (computedBuffer.length !== headerBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(computedBuffer, headerBuffer);
}
