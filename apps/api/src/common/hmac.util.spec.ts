import { signHmac, verifyHmac } from './hmac.util'

describe('hmac.util', () => {
  const secret = 'test-secret'

  describe('signHmac', () => {
    it('produces a hex-encoded SHA-256 HMAC', () => {
      const sig = signHmac('hello world', secret)
      expect(sig).toMatch(/^[0-9a-f]{64}$/)
    })

    it('is deterministic for the same input', () => {
      expect(signHmac('abc', secret)).toBe(signHmac('abc', secret))
    })

    it('differs for different inputs', () => {
      expect(signHmac('a', secret)).not.toBe(signHmac('b', secret))
    })

    it('differs for different secrets', () => {
      expect(signHmac('abc', 'secret-a')).not.toBe(signHmac('abc', 'secret-b'))
    })
  })

  describe('verifyHmac', () => {
    it('verifies a valid signature', () => {
      const body = '{"eventId":"evt_1","type":"subscription.created"}'
      const sig = signHmac(body, secret)
      expect(verifyHmac(body, sig, secret)).toBe(true)
    })

    it('rejects a mismatched signature', () => {
      expect(verifyHmac('body', 'deadbeef'.repeat(8), secret)).toBe(false)
    })

    it('rejects missing signatures', () => {
      expect(verifyHmac('body', undefined, secret)).toBe(false)
    })

    it('rejects signatures of incorrect length without throwing', () => {
      expect(verifyHmac('body', 'ab', secret)).toBe(false)
    })

    it('rejects non-hex signatures without throwing', () => {
      expect(verifyHmac('body', 'not-hex-at-all', secret)).toBe(false)
    })

    it('verifies when given a Buffer rawBody', () => {
      const body = Buffer.from('some raw body')
      const sig = signHmac(body, secret)
      expect(verifyHmac(body, sig, secret)).toBe(true)
    })
  })
})
