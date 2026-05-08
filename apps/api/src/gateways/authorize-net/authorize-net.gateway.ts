import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { randomUUID } from 'crypto'
import { PaymentGateway, SubscriptionPlan } from '@prisma/client'
import { PaymentGatewayAdapter } from '../gateway.interface'
import { signHmac } from '../../common/hmac.util'

/**
 * Mock Authorize.net gateway.
 *
 * NOT a real implementation — does not call authorize.net. Instead, it:
 *   - stores "charges" in memory
 *   - exposes an `emitWebhook` method that signs a payload with HMAC-SHA256
 *     and returns the { body, signature } so the simulator or test code
 *     can replay it into the webhook controller
 *   - uses real Authorize.net ARB webhook event types (subscription.created,
 *     subscription.renewed, charge.approved, charge.refunded, chargeback.received)
 *
 * Payload shapes mirror what a real billing service emits, so the
 * realistic contracts close to production Authorize.Net webhook shapes.
 */
@Injectable()
export class AuthorizeNetGateway implements PaymentGatewayAdapter {
  readonly gateway = PaymentGateway.AUTHORIZE_NET
  private readonly logger = new Logger(AuthorizeNetGateway.name)

  // In-memory "gateway state" — stores fake customers, subscriptions, and
  // charges so refundCharge etc. can reference them.
  private readonly customers = new Map<string, { id: string; userId: string }>()
  private readonly subscriptions = new Map<
    string,
    { id: string; customerId: string; plan: SubscriptionPlan; status: string }
  >()
  private readonly charges = new Map<
    string,
    { id: string; subscriptionId: string; amount: number; status: 'ok' | 'refunded' }
  >()

  constructor(private readonly config: ConfigService) {}

  async createSubscription(params: { userId: string; plan: SubscriptionPlan }) {
    const customerId = `an_cust_${randomUUID().slice(0, 12)}`
    const arbId = `arb_${randomUUID().slice(0, 12)}`
    const profileId = `an_profile_${randomUUID().slice(0, 12)}`

    this.customers.set(customerId, { id: customerId, userId: params.userId })
    this.subscriptions.set(arbId, {
      id: arbId,
      customerId,
      plan: params.plan,
      status: 'active',
    })

    this.logger.log(
      `[mock] createSubscription user=${params.userId} plan=${params.plan} arb=${arbId}`
    )

    return {
      gatewaySubscriptionId: arbId,
      gatewayCustomerId: customerId,
      gatewayData: { profileId, arbSubscriptionId: arbId },
    }
  }

  async cancelSubscription(params: { gatewaySubscriptionId: string }) {
    const sub = this.subscriptions.get(params.gatewaySubscriptionId)
    if (sub) {
      sub.status = 'canceled'
      this.logger.log(`[mock] cancelSubscription arb=${params.gatewaySubscriptionId}`)
    }
  }

  /**
   * Execute a refund on a mock charge. Deliberately idempotent:
   * calling twice with the same idempotencyKey returns the same refund id.
   */
  private readonly refundLog = new Map<
    string,
    { gatewayRefundId: string; refundedAmount: number }
  >()

  async refundCharge(params: {
    gatewayTransactionId: string
    amount: number
    idempotencyKey: string
  }) {
    const cached = this.refundLog.get(params.idempotencyKey)
    if (cached) {
      this.logger.log(`[mock] refundCharge idempotent short-circuit ${params.idempotencyKey}`)
      return cached
    }

    const charge = this.charges.get(params.gatewayTransactionId)
    // Baseline mock: we don't require the charge to exist so tests can
    // use arbitrary transaction ids. Stricter mode can be toggled via simulator.
    if (charge && charge.status === 'refunded') {
      // Already refunded at the gateway level — return the existing id
      const refundId = `an_refund_${params.gatewayTransactionId}`
      this.refundLog.set(params.idempotencyKey, {
        gatewayRefundId: refundId,
        refundedAmount: params.amount,
      })
      return { gatewayRefundId: refundId, refundedAmount: params.amount }
    }

    if (charge) charge.status = 'refunded'

    const result = {
      gatewayRefundId: `an_refund_${randomUUID().slice(0, 12)}`,
      refundedAmount: params.amount,
    }
    this.refundLog.set(params.idempotencyKey, result)
    this.logger.log(
      `[mock] refundCharge txn=${params.gatewayTransactionId} amount=${params.amount}`
    )
    return result
  }

  /**
   * Register a charge so later refund calls can reference it. Used by the
   * simulator when seeding "this user made a payment of X on Y date."
   */
  registerCharge(params: {
    gatewayTransactionId: string
    gatewaySubscriptionId: string
    amount: number
  }): void {
    this.charges.set(params.gatewayTransactionId, {
      id: params.gatewayTransactionId,
      subscriptionId: params.gatewaySubscriptionId,
      amount: params.amount,
      status: 'ok',
    })
  }

  /**
   * Build a signed webhook payload. The caller is responsible for actually
   * sending it to the webhook controller (the simulator does this).
   */
  buildSignedWebhook(params: {
    eventType: string
    data: Record<string, any>
    eventId?: string
  }): { body: string; signature: string } {
    const secret = this.config.get<string>('AUTHORIZE_NET_WEBHOOK_SECRET') || ''
    const eventId = params.eventId ?? `an_evt_${randomUUID().slice(0, 16)}`
    const payload = {
      eventId,
      type: params.eventType,
      timestamp: new Date().toISOString(),
      data: params.data,
    }
    const body = JSON.stringify(payload)
    const signature = signHmac(body, secret)
    return { body, signature }
  }
}
