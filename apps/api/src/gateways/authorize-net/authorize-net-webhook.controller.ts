import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Logger,
  Post,
  Req,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Request } from 'express'
import {
  PaymentGateway,
  Prisma,
  SubscriptionPlan,
  LedgerAccountType,
  LedgerEntryType,
  LedgerTransactionStatus,
} from '@prisma/client'
import { PrismaService } from '../../common/prisma.service'
import { CreditsService } from '../../billing/credits.service'
import { LedgerService } from '../../billing/ledger.service'
import { SubscriptionsService } from '../../billing/subscriptions.service'
import { DisputesService } from '../../disputes/disputes.service'
import { verifyHmac } from '../../common/hmac.util'

/**
 * AuthorizeNetWebhookController — receives webhook events from the
 * Authorize.net gateway.
 *
 * KEY DESIGN — webhook dedup pattern (do not break):
 *
 *   1. Verify HMAC signature over the raw request body
 *   2. Fast-path dedup: check processed_webhooks table for the event id
 *   3. Insert the processed_webhooks row AND apply the side effect inside
 *      a single $transaction. If the side effect throws, the dedup row is
 *      rolled back and the event will be retried.
 *   4. If two replays race and both pass the fast-path check, Postgres's
 *      unique constraint on id fires P2002 — caught and treated as "already
 *      processed."
 *
 * Note: all side effects run synchronously inside $transaction before returning
 * 200 to the gateway. Under high load this risks gateway HTTP timeouts.
 * See IMPLEMENTATION_PLAN.md #1 for the planned BullMQ async-processing upgrade.
 *
 * Event types currently handled:
 *   - subscription.created / subscription.renewed   → activate sub + grant credits + ChargeRecord
 *   - subscription.canceled                          → immediate cancellation
 *   - charge.approved                                → credit purchase + ChargeRecord
 *   - charge.refunded                                → reverse a credit purchase
 *   - charge.failed                                  → immediate cancellation (NO RETRY)
 *   - chargeback.received                            → create dispute + ledger reversal
 */
@Controller('webhooks/authorize-net')
export class AuthorizeNetWebhookController {
  private readonly logger = new Logger(AuthorizeNetWebhookController.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly credits: CreditsService,
    private readonly subscriptions: SubscriptionsService,
    private readonly disputes: DisputesService,
    private readonly ledger: LedgerService,
    private readonly config: ConfigService
  ) {}

  @Post()
  async handleWebhook(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('x-authorize-signature') signature: string | undefined,
    @Body() body: any
  ) {
    const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(body))
    const secret = this.config.get<string>('AUTHORIZE_NET_WEBHOOK_SECRET') || ''

    if (!verifyHmac(rawBody, signature, secret)) {
      throw new BadRequestException('Invalid webhook signature')
    }

    const event = body as { eventId: string; type: string; data: Record<string, any> }
    if (!event.eventId || !event.type) {
      throw new BadRequestException('Invalid webhook payload')
    }

    // Fast-path dedup
    const existing = await this.prisma.processedWebhook.findUnique({
      where: { id: event.eventId },
    })
    if (existing) {
      return { received: true, skipped: true }
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        // Atomic: dedup row + side effect in ONE transaction
        await tx.processedWebhook.create({
          data: {
            id: event.eventId,
            source: 'authorize_net',
            eventType: event.type,
          },
        })
        await this.applyEvent(tx, event)
      })
    } catch (err: any) {
      if (err?.code === 'P2002') {
        return { received: true, skipped: true }
      }
      throw err
    }

    return { received: true }
  }

  private async applyEvent(
    tx: Prisma.TransactionClient,
    event: { type: string; data: Record<string, any> }
  ) {
    const data = event.data

    switch (event.type) {
      case 'subscription.created':
      case 'subscription.renewed': {
        const plan = this.mapPlanSlug(data.plan)
        await this.subscriptions.createOrUpdateFromGateway({
          userId: data.userId,
          plan,
          gatewayType: PaymentGateway.AUTHORIZE_NET,
          gatewaySubscriptionId: data.arbSubscriptionId,
          gatewayCustomerId: data.customerId,
          gatewayData: {
            profileId: data.profileId,
            arbSubscriptionId: data.arbSubscriptionId,
          },
          currentPeriodStart: data.currentPeriodStart
            ? new Date(data.currentPeriodStart)
            : undefined,
          currentPeriodEnd: data.currentPeriodEnd
            ? new Date(data.currentPeriodEnd)
            : undefined,
          tx,
        })

        // Record the subscription charge for refund auto-population
        if (data.transactionId && data.userId) {
          await tx.chargeRecord.upsert({
            where: {
              gatewayType_gatewayTransactionId: {
                gatewayType: PaymentGateway.AUTHORIZE_NET,
                gatewayTransactionId: data.transactionId,
              },
            },
            create: {
              userId: data.userId,
              gatewayType: PaymentGateway.AUTHORIZE_NET,
              gatewayTransactionId: data.transactionId,
              amountCents: data.amountCents ?? data.amount ?? 0,
              plan,
            },
            update: {},
          })
        }
        break
      }

      case 'subscription.canceled': {
        await this.subscriptions.cancelImmediately(
          data.userId,
          `gateway event: ${event.type}`,
          tx
        )
        break
      }

      case 'charge.approved': {
        // Credit-purchase path: grant credits for a one-off charge.
        if (data.contextType === 'credit_purchase' && data.contextRef) {
          const match = String(data.contextRef).match(/^(\d+)_credits$/)
          if (!match) {
            this.logger.warn(`Invalid credit contextRef: ${data.contextRef}`)
            break
          }
          const creditAmount = parseInt(match[1], 10)
          const idempotencyKey = `authorize_net_charge_${data.transactionId}`
          await this.credits.addCredits(
            data.userId,
            creditAmount,
            'PURCHASE',
            'Credit purchase via Authorize.net',
            idempotencyKey,
            { authorizeNetTransactionId: data.transactionId }
          )
        }

        // Record the charge for refund auto-population (idempotent by gateway+txnId)
        if (data.transactionId && data.userId) {
          await tx.chargeRecord.upsert({
            where: {
              gatewayType_gatewayTransactionId: {
                gatewayType: PaymentGateway.AUTHORIZE_NET,
                gatewayTransactionId: data.transactionId,
              },
            },
            create: {
              userId: data.userId,
              gatewayType: PaymentGateway.AUTHORIZE_NET,
              gatewayTransactionId: data.transactionId,
              amountCents: data.amountCents ?? data.amount ?? 0,
            },
            update: {},
          })
        }
        break
      }

      case 'charge.refunded': {
        if (data.contextType === 'credit_purchase' && data.contextRef) {
          const match = String(data.contextRef).match(/^(\d+)_credits$/)
          if (!match) {
            this.logger.warn(`Invalid credit contextRef: ${data.contextRef}`)
            break
          }
          const creditAmount = parseInt(match[1], 10)
          const idempotencyKey = `authorize_net_refund_${data.transactionId}`
          try {
            await this.credits.deductCredits(
              data.userId,
              creditAmount,
              `Reversal for refunded charge ${data.transactionId}`,
              idempotencyKey
            )
          } catch {
            this.logger.warn(
              `Could not deduct credits for refund ${data.transactionId}: insufficient balance`
            )
          }
        }
        break
      }

      case 'charge.failed': {
        // NO-RETRY DUNNING POLICY: a failed charge = immediate cancellation.
        // No grace period, no retry, no past_due dwell state.
        this.logger.warn(
          `Charge failed for user ${data.userId}: ${data.reason || 'unspecified'}`
        )
        await this.subscriptions.cancelImmediately(
          data.userId,
          `charge failed: ${data.reason || 'unspecified'}`,
          tx
        )
        break
      }

      case 'chargeback.received': {
        // 1. Create dispute (idempotent by gatewayDisputeId)
        const dispute = await this.disputes.createDispute({
          userId: data.userId,
          gateway: PaymentGateway.AUTHORIZE_NET,
          gatewayDisputeId: `an_dispute_${data.transactionId}`,
          originalTransactionId: data.transactionId,
          amount: data.amount,
          reason: data.reason || 'Chargeback received',
          tx,
        })

        // If dispute already had a ledger reversal (idempotent replay), skip
        if (dispute.ledgerReversalTxnId) {
          this.logger.log(
            `Chargeback for ${data.transactionId} already processed, skipping ledger reversal`
          )
          break
        }

        // 2. Write ledger reversal:
        //    DEBIT Revenue (reverse realized revenue)
        //    CREDIT User ASSET (money is gone from our side)
        //    Works regardless of subscription state (active, canceled, etc.)
        const userAssetAccountId = await this.ledger.getOrCreateAssetAccount(
          data.userId,
          tx
        )
        const revenueAccountId = await this.ledger.getOrCreateSystemAccount(
          LedgerAccountType.REVENUE,
          tx
        )

        const reversalTxn = await this.ledger.recordTransaction(
          data.userId,
          `Chargeback reversal for transaction ${data.transactionId}`,
          [
            {
              accountId: revenueAccountId,
              entryType: LedgerEntryType.DEBIT,
              amount: data.amount,
            },
            {
              accountId: userAssetAccountId,
              entryType: LedgerEntryType.CREDIT,
              amount: data.amount,
            },
          ],
          LedgerTransactionStatus.COMPLETED,
          {
            disputeId: dispute.id,
            chargebackEventId: event.type,
            originalTransactionId: data.transactionId,
            type: 'chargeback_reversal',
          },
          tx,
          `chargeback_${data.transactionId}_reversal_ledger`
        )

        // 3. Record the ledger reversal txn id on the dispute (for unwinding on WON)
        await tx.dispute.update({
          where: { id: dispute.id },
          data: { ledgerReversalTxnId: reversalTxn.id },
        })

        // 4. Deduct credits that were originally granted by the charge.
        //    If user already spent credits, log warning and continue.
        const chargebackIdempotencyKey = `chargeback_${data.transactionId}`
        try {
          await this.credits.deductCredits(
            data.userId,
            data.amount,
            `Credit reversal for chargeback on transaction ${data.transactionId}`,
            chargebackIdempotencyKey,
            { disputeId: dispute.id, source: 'chargeback' }
          )
        } catch (error) {
          // Credits gap: user balance is below the chargeback deduction amount.
          // See IMPLEMENTATION_PLAN.md #6 for planned finance-alert queue.
          this.logger.warn(
            `Could not deduct credits for chargeback ${data.transactionId}: ` +
            `${error instanceof Error ? error.message : 'unknown error'}. ` +
            `Continuing — chargeback processing takes priority.`
          )
        }

        this.logger.warn(
          `Chargeback processed: dispute=${dispute.id}, user=${data.userId}, ` +
          `amount=${data.amount} cents, reversalTxn=${reversalTxn.id}`
        )
        break
      }

      default:
        this.logger.log(`Unhandled authorize-net event type: ${event.type}`)
    }
  }

  private mapPlanSlug(slug: string | undefined): SubscriptionPlan {
    if (!slug) return SubscriptionPlan.BASIC
    const upper = slug.toUpperCase()
    if (upper === 'STANDARD') return SubscriptionPlan.STANDARD
    if (upper === 'PREMIUM') return SubscriptionPlan.PREMIUM
    return SubscriptionPlan.BASIC
  }
}
