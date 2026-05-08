import { PaymentGateway, SubscriptionPlan } from '@prisma/client'

/**
 * Shared gateway adapter contract implemented by AuthorizeNetGateway and
 * SolanaGateway. Intentionally minimal: create a sub, cancel a sub, refund a charge, get
 * status. The mock implementations each emit their native webhook/confirmation
 * events when these methods are called, which lets the rest of the system
 * (webhook controllers, ledger, credits) react the same way it would in
 * production.
 */
export interface PaymentGatewayAdapter {
  readonly gateway: PaymentGateway

  /**
   * Create a recurring subscription for the given user on the given plan.
   * Returns the gateway-specific subscription id and customer id.
   */
  createSubscription(params: {
    userId: string
    plan: SubscriptionPlan
  }): Promise<{
    gatewaySubscriptionId: string
    gatewayCustomerId: string
    gatewayData: Record<string, any>
  }>

  /**
   * Cancel a recurring subscription at the gateway. This does NOT update
   * the internal Subscription row — the cancellation webhook that fires
   * as a result of this call will do that.
   */
  cancelSubscription(params: { gatewaySubscriptionId: string }): Promise<void>

  /**
   * Execute a refund on a specific transaction. Returns the gateway refund id.
   * Wired into RefundsService.processPaymentRefund.
   *
   * Mock gateways always succeed in the baseline. Failure simulation is
   * available via the simulator module.
   */
  refundCharge(params: {
    gatewayTransactionId: string
    amount: number
    idempotencyKey: string
  }): Promise<{ gatewayRefundId: string; refundedAmount: number }>
}
