import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { PaymentGateway, SubscriptionPlan } from '@prisma/client'
import { randomUUID } from 'crypto'
import { PrismaService } from '../common/prisma.service'
import { AuthorizeNetGateway } from '../gateways/authorize-net/authorize-net.gateway'
import { SolanaGateway } from '../gateways/solana/solana.gateway'

/**
 * SimulatorService — dev/test helper that drives the mock gateways.
 *
 * Instead of calling real gateway APIs, the simulator exposes endpoints
 * that let you deterministically fire events at the webhook controllers.
 * Use this to test refund + chargeback flows locally.
 *
 * The simulator is the equivalent of "production gateway state"
 * — it records fake charges, issues fake event ids, and lets you replay
 * events (for idempotency testing), fire chargebacks, etc.
 */
@Injectable()
export class SimulatorService {
  private readonly logger = new Logger(SimulatorService.name)

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly authorizeNet: AuthorizeNetGateway,
    private readonly solana: SolanaGateway
  ) {}

  /**
   * Simulate a recurring subscription rebill on the card side.
   * Registers a charge with the gateway mock and returns the synthetic
   * transactionId to use for later refund or chargeback simulation.
   */
  async simulateCardRebill(params: {
    userId: string
    plan: SubscriptionPlan
    amountCents: number
  }) {
    const gatewaySubscriptionId = `arb_sim_${randomUUID().slice(0, 12)}`
    const gatewayCustomerId = `an_cust_sim_${params.userId}`
    const transactionId = `an_txn_${randomUUID().slice(0, 12)}`

    this.authorizeNet.registerCharge({
      gatewayTransactionId: transactionId,
      gatewaySubscriptionId,
      amount: params.amountCents,
    })

    const now = new Date()
    const periodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)

    const webhook = this.authorizeNet.buildSignedWebhook({
      eventType: 'subscription.renewed',
      data: {
        userId: params.userId,
        plan: params.plan,
        arbSubscriptionId: gatewaySubscriptionId,
        customerId: gatewayCustomerId,
        profileId: `profile_${params.userId}`,
        currentPeriodStart: now.toISOString(),
        currentPeriodEnd: periodEnd.toISOString(),
        transactionId,
        amount: params.amountCents,
      },
    })

    return {
      transactionId,
      gatewaySubscriptionId,
      gatewayCustomerId,
      webhook,
    }
  }

  /**
   * Simulate a chargeback event firing for a previously-registered charge.
   * Delivered into the AuthorizeNet webhook controller's `chargeback.received` handler.
   */
  async simulateChargeback(params: {
    userId: string
    originalTransactionId: string
    amountCents: number
    reason?: string
  }) {
    const eventId = `an_chargeback_${randomUUID().slice(0, 16)}`
    const webhook = this.authorizeNet.buildSignedWebhook({
      eventId,
      eventType: 'chargeback.received',
      data: {
        userId: params.userId,
        customerId: `an_cust_sim_${params.userId}`,
        transactionId: params.originalTransactionId,
        amount: params.amountCents,
        reason: params.reason ?? 'fraudulent',
      },
    })

    return { eventId, webhook }
  }

  /**
   * Simulate a failed charge on a card subscription. Per the no-dunning
   * policy, this should result in immediate cancellation when the webhook
   * is delivered to the controller.
   */
  async simulateChargeFailure(params: { userId: string; reason?: string }) {
    const webhook = this.authorizeNet.buildSignedWebhook({
      eventType: 'charge.failed',
      data: {
        userId: params.userId,
        customerId: `an_cust_sim_${params.userId}`,
        transactionId: `an_txn_failed_${randomUUID().slice(0, 12)}`,
        reason: params.reason ?? 'declined_insufficient_funds',
      },
    })
    return { webhook }
  }

  /**
   * Simulate a Solana confirmation event at the specified depth.
   * Call this multiple times (depth=1, 2, 3, ...) to walk a transaction
   * through the confirmation ladder.
   */
  simulateSolanaConfirmation(params: {
    userId: string
    txHash?: string
    amount: number
    plan?: SubscriptionPlan
    confirmations: number
    reference?: string
  }) {
    const txHash = params.txHash || `Tx${randomUUID().replace(/-/g, '').slice(0, 40)}`
    const event = this.solana.buildConfirmationEvent({
      txHash,
      userId: params.userId,
      amount: params.amount,
      plan: params.plan,
      confirmations: params.confirmations,
      reference: params.reference,
    })

    // If the caller asked us to register the charge (for later refunds), do it.
    if (params.confirmations >= 3) {
      this.solana.registerCharge({ txHash, amount: params.amount })
    }

    return { txHash, event }
  }

  /**
   * Reset all simulator state for a given user. Useful between tests.
   */
  async resetUser(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } })
    if (!user) throw new NotFoundException(`Unknown user ${userId}`)

    await this.prisma.$transaction([
      this.prisma.creditTransaction.deleteMany({
        where: { credits: { userId } },
      }),
      this.prisma.credits.deleteMany({ where: { userId } }),
      this.prisma.ledgerEntry.deleteMany({
        where: { transaction: { userId } },
      }),
      this.prisma.ledgerTransaction.deleteMany({ where: { userId } }),
      this.prisma.gatewaySubscription.deleteMany({
        where: { subscription: { userId } },
      }),
      this.prisma.subscription.deleteMany({ where: { userId } }),
      this.prisma.refundRequest.deleteMany({ where: { userId } }),
      this.prisma.dispute.deleteMany({ where: { userId } }),
    ])

    this.logger.log(`Reset simulator state for user ${userId}`)
    return { reset: true, userId }
  }
}
