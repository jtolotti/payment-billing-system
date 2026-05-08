import {
  BadRequestException,
  Body,
  Controller,
  Logger,
  Post,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { PaymentGateway, Prisma, SubscriptionPlan } from '@prisma/client'
import { PrismaService } from '../../common/prisma.service'
import { CreditsService } from '../../billing/credits.service'
import { SubscriptionsService } from '../../billing/subscriptions.service'

/**
 * SolanaConfirmationController — receives chain confirmation events.
 *
 * Unlike the card path (push-style HMAC webhooks), the Solana path is
 * confirmation-depth based: an event fires for every additional confirmation
 * on a transaction, and we only materialize the side effect (grant credits,
 * activate sub) once depth >= REQUIRED_CONFIRMATIONS.
 *
 * Dedup is by txHash (immutable, unique on-chain).
 */
@Controller('webhooks/solana')
export class SolanaConfirmationController {
  private readonly logger = new Logger(SolanaConfirmationController.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly credits: CreditsService,
    private readonly subscriptions: SubscriptionsService,
    private readonly config: ConfigService
  ) {}

  @Post('confirmation')
  async handleConfirmation(@Body() body: any) {
    const event = body as {
      eventId: string
      type: string
      data: {
        txHash: string
        userId: string
        amount: number
        plan?: SubscriptionPlan
        confirmations: number
        reference?: string
      }
    }

    if (!event.eventId || !event.data?.txHash) {
      throw new BadRequestException('Invalid confirmation payload')
    }

    const required = parseInt(
      this.config.get<string>('SOLANA_REQUIRED_CONFIRMATIONS') || '3',
      10
    )

    // Not enough confirmations yet — acknowledge but do nothing.
    if (event.data.confirmations < required) {
      this.logger.log(
        `confirmation tx=${event.data.txHash.slice(0, 10)}... ` +
          `depth=${event.data.confirmations}/${required} — waiting`
      )
      return { received: true, settled: false, confirmations: event.data.confirmations }
    }

    // Dedup by tx hash — once settled, never settle again.
    const existing = await this.prisma.processedWebhook.findUnique({
      where: { id: event.data.txHash },
    })
    if (existing) {
      return { received: true, settled: true, skipped: true }
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.processedWebhook.create({
          data: {
            id: event.data.txHash,
            source: 'solana',
            eventType: 'confirmation',
          },
        })
        await this.applyConfirmation(tx, event.data)
      })
    } catch (err: any) {
      if (err?.code === 'P2002') {
        return { received: true, settled: true, skipped: true }
      }
      throw err
    }

    return { received: true, settled: true }
  }

  private async applyConfirmation(
    tx: Prisma.TransactionClient,
    data: {
      txHash: string
      userId: string
      amount: number
      plan?: SubscriptionPlan
      confirmations: number
      reference?: string
    }
  ) {
    // If there's a plan, this is a subscription payment → activate sub.
    if (data.plan) {
      await this.subscriptions.createOrUpdateFromGateway({
        userId: data.userId,
        plan: data.plan,
        gatewayType: PaymentGateway.SOLANA,
        gatewaySubscriptionId: data.reference || data.txHash,
        gatewayCustomerId: data.userId,
        gatewayData: { txHash: data.txHash, chain: 'SOLANA' },
        tx,
      })
    }

    // Grant the corresponding credits (monthly allocation for the plan).
    const idempotencyKey = `solana_charge_${data.txHash}`
    await this.credits.addCredits(
      data.userId,
      data.amount,
      'PURCHASE',
      `Solana on-chain payment ${data.txHash.slice(0, 10)}...`,
      idempotencyKey,
      { solanaTxHash: data.txHash }
    )

    // Record the settled charge for refund auto-population
    await tx.chargeRecord.upsert({
      where: {
        gatewayType_gatewayTransactionId: {
          gatewayType: PaymentGateway.SOLANA,
          gatewayTransactionId: data.txHash,
        },
      },
      create: {
        userId: data.userId,
        gatewayType: PaymentGateway.SOLANA,
        gatewayTransactionId: data.txHash,
        amountCents: data.amount,
        plan: data.plan,
      },
      update: {},
    })
  }
}
