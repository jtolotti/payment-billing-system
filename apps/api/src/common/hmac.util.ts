import { createHmac, timingSafeEqual } from 'crypto'

/**
 * HMAC-SHA256 signing utility used by the mock CardGateway and verified
 * by the webhook controller.
 *
 * Real gateways like Authorize.net sign their webhooks with a shared secret
 * and the receiver verifies over the raw request body.
 */
export function signHmac(rawBody: Buffer | string, secret: string): string {
  return createHmac('sha256', secret)
    .update(typeof rawBody === 'string' ? Buffer.from(rawBody) : rawBody)
    .digest('hex')
}

/**
 * Constant-time verify. Returns false if the signature is missing or mismatched.
 */
export function verifyHmac(
  rawBody: Buffer | string,
  signature: string | undefined,
  secret: string
): boolean {
  if (!signature) return false

  const expected = signHmac(rawBody, secret)
  const expectedBuf = Buffer.from(expected, 'hex')
  let receivedBuf: Buffer
  try {
    receivedBuf = Buffer.from(signature, 'hex')
  } catch {
    return false
  }

  if (expectedBuf.length !== receivedBuf.length) return false
  return timingSafeEqual(expectedBuf, receivedBuf)
}
