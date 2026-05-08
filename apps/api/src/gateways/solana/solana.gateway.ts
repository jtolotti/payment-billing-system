import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { randomBytes, randomUUID } from 'crypto'
import { PaymentGateway, SubscriptionPlan } from '@prisma/client'
import { PaymentGatewayAdapter } from '../gateway.interface'

/**
 * Mock Solana gateway.
 *
 * Not a real Solana client — no @solana/web3.js. Simulates the observable
 * behavior of an on-chain recurring subscription: each "subscription" has
 * a Program Derived Address (PDA), each payment becomes a tx hash that
 * accrues confirmation depth over time, and the real credit grant only
 * happens once confirmation depth >= SOLANA_REQUIRED_CONFIRMATIONS.
 *
 * The confirmation controller is what actually advances state, using the
 * simulator to fire events at specific depths.
 */
@Injectable()
export class SolanaGateway implements PaymentGatewayAdapter {
  readonly gateway = PaymentGateway.SOLANA
  private readonly logger = new Logger(SolanaGateway.name)

  private readonly subscriptions = new Map<
    string,
    {
      pda: string
      userId: string
      userWallet: string
      plan: SubscriptionPlan
      status: string
    }
  >()

  private readonly charges = new Map<
    string,
    { txHash: string; amount: number; status: 'pending' | 'confirmed' | 'refunded' }
  >()

  constructor(private readonly config: ConfigService) {}

  async createSubscription(params: { userId: string; plan: SubscriptionPlan }) {
    const pda = this.generatePda()
    const wallet = this.generateWallet()

    this.subscriptions.set(pda, {
      pda,
      userId: params.userId,
      userWallet: wallet,
      plan: params.plan,
      status: 'active',
    })

    this.logger.log(
      `[mock] createSubscription user=${params.userId} plan=${params.plan} pda=${pda.slice(0, 8)}...`
    )

    return {
      gatewaySubscriptionId: pda,
      gatewayCustomerId: wallet,
      gatewayData: {
        walletAddress: wallet,
        subscriptionPda: pda,
        chain: 'SOLANA',
      },
    }
  }

  async cancelSubscription(params: { gatewaySubscriptionId: string }) {
    const sub = this.subscriptions.get(params.gatewaySubscriptionId)
    if (sub) {
      sub.status = 'canceled'
      this.logger.log(`[mock] cancelSubscription pda=${params.gatewaySubscriptionId.slice(0, 8)}...`)
    }
  }

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
    if (cached) return cached

    const charge = this.charges.get(params.gatewayTransactionId)
    if (charge) charge.status = 'refunded'

    const result = {
      gatewayRefundId: `sol_refund_${randomBytes(16).toString('hex').slice(0, 12)}`,
      refundedAmount: params.amount,
    }
    this.refundLog.set(params.idempotencyKey, result)
    this.logger.log(
      `[mock] refundCharge tx=${params.gatewayTransactionId.slice(0, 8)}... amount=${params.amount}`
    )
    return result
  }

  /**
   * Register a confirmed on-chain charge that refundCharge can later reference.
   */
  registerCharge(params: { txHash: string; amount: number }): void {
    this.charges.set(params.txHash, {
      txHash: params.txHash,
      amount: params.amount,
      status: 'confirmed',
    })
  }

  private generatePda(): string {
    // Fake base58-ish string
    return `Sub${randomBytes(24).toString('hex').slice(0, 40)}`
  }

  private generateWallet(): string {
    return `Wal${randomBytes(24).toString('hex').slice(0, 40)}`
  }

  buildConfirmationEvent(params: {
    eventId?: string
    txHash: string
    userId: string
    amount: number
    plan?: SubscriptionPlan
    confirmations: number
    reference?: string
  }) {
    return {
      eventId: params.eventId ?? `sol_evt_${randomUUID().slice(0, 16)}`,
      type: 'confirmation',
      timestamp: new Date().toISOString(),
      data: {
        txHash: params.txHash,
        userId: params.userId,
        amount: params.amount,
        plan: params.plan,
        confirmations: params.confirmations,
        reference: params.reference,
      },
    }
  }
}
