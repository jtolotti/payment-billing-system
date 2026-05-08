import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common'
import {
  DisputeStatus,
  PaymentGateway,
  LedgerAccountType,
  LedgerEntryType,
  LedgerTransactionStatus,
  Prisma,
} from '@prisma/client'
import { PrismaService } from '../common/prisma.service'
import { LedgerService } from '../billing/ledger.service'
import { CreditsService } from '../billing/credits.service'
import { BillingConfigService } from '../billing/billing-config.service'

// Valid dispute status transitions
const DISPUTE_TRANSITIONS: Record<string, string[]> = {
  OPEN: ['WON', 'LOST', 'EVIDENCE_SUBMITTED'],
  EVIDENCE_SUBMITTED: ['WON', 'LOST'],
}

function assertTransition(current: string, target: string): void {
  const allowed = DISPUTE_TRANSITIONS[current]
  if (!allowed || !allowed.includes(target)) {
    throw new BadRequestException(
      `Invalid dispute transition: ${current} → ${target}`
    )
  }
}

/**
 * DisputesService — manages the full dispute/chargeback lifecycle.
 *
 * Supports:
 *   - create (idempotent by gatewayDisputeId)
 *   - list / get
 *   - attach evidence
 *   - setOutcome (WON / LOST) with ledger adjustments
 *
 * Wired into the AuthorizeNetWebhookController `chargeback.received` handler.
 * On WON: reversal-of-reversal restores revenue + credits.
 * On LOST: original reversal stands + $15 chargeback fee recorded as EXPENSE.
 */
@Injectable()
export class DisputesService {
  private readonly logger = new Logger(DisputesService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly credits: CreditsService,
    private readonly billingConfig: BillingConfigService,
  ) {}

  async createDispute(params: {
    userId: string
    gateway: PaymentGateway
    gatewayDisputeId: string
    originalTransactionId: string
    amount: number
    reason?: string
    tx?: Prisma.TransactionClient
  }) {
    const client = params.tx || this.prisma

    // Idempotent: if we already have a dispute for this gatewayDisputeId,
    // return it rather than creating a duplicate.
    const existing = await client.dispute.findUnique({
      where: { gatewayDisputeId: params.gatewayDisputeId },
    })
    if (existing) {
      this.logger.log(
        `createDispute short-circuited: gatewayDisputeId=${params.gatewayDisputeId}`
      )
      return existing
    }

    const dispute = await client.dispute.create({
      data: {
        userId: params.userId,
        gateway: params.gateway,
        gatewayDisputeId: params.gatewayDisputeId,
        originalTransactionId: params.originalTransactionId,
        amount: params.amount,
        reason: params.reason,
        status: DisputeStatus.OPEN,
      },
    })

    this.logger.warn(
      `Dispute ${dispute.id} opened for user ${params.userId} (${params.amount} cents)`
    )
    return dispute
  }

  async listAll(filters: { status?: DisputeStatus; limit?: number; offset?: number } = {}) {
    const limit = Math.min(filters.limit ?? 20, 100)
    const offset = filters.offset ?? 0
    const where: Prisma.DisputeWhereInput = {}
    if (filters.status) where.status = filters.status

    const [data, total] = await Promise.all([
      this.prisma.dispute.findMany({
        where,
        orderBy: { openedAt: 'desc' },
        take: limit,
        skip: offset,
        include: {
          user: { select: { id: true, email: true, name: true } },
          evidence: { orderBy: { submittedAt: 'desc' } },
        },
      }),
      this.prisma.dispute.count({ where }),
    ])
    return { data, total, limit, offset }
  }

  async get(id: string) {
    const dispute = await this.prisma.dispute.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, email: true, name: true } },
        evidence: { orderBy: { submittedAt: 'desc' } },
      },
    })
    if (!dispute) throw new NotFoundException('Dispute not found')
    return dispute
  }

  async attachEvidence(params: {
    disputeId: string
    submittedBy: string
    evidenceType: string
    content: string
    metadata?: Record<string, any>
  }) {
    const dispute = await this.prisma.dispute.findUnique({
      where: { id: params.disputeId },
    })
    if (!dispute) throw new NotFoundException('Dispute not found')

    const evidence = await this.prisma.disputeEvidence.create({
      data: {
        disputeId: params.disputeId,
        submittedBy: params.submittedBy,
        evidenceType: params.evidenceType,
        content: params.content,
        metadata: params.metadata as Prisma.InputJsonValue,
      },
    })

    if (dispute.status === DisputeStatus.OPEN) {
      await this.prisma.dispute.update({
        where: { id: params.disputeId },
        data: { status: DisputeStatus.EVIDENCE_SUBMITTED },
      })
    }

    return evidence
  }

  async setOutcome(disputeId: string, outcome: 'WON' | 'LOST') {
    const dispute = await this.prisma.dispute.findUnique({ where: { id: disputeId } })
    if (!dispute) throw new NotFoundException('Dispute not found')

    assertTransition(dispute.status, outcome)

    if (outcome === 'WON') {
      return this.handleWon(dispute)
    } else {
      return this.handleLost(dispute)
    }
  }

  /**
   * WON: We won the dispute — money comes back.
   *   1. Reverse the original reversal (DEBIT User ASSET, CREDIT Revenue)
   *   2. Restore credits to the user
   *   3. Mark dispute as WON
   *
   * Note: We do NOT auto-restore subscription access. The sub may have been
   * canceled for other reasons or the period may have expired. This requires
   * human review. See TODO comment below.
   */
  private async handleWon(
    dispute: { id: string; userId: string; amount: number; ledgerReversalTxnId: string | null }
  ) {
    return this.prisma.$transaction(async (tx) => {
      // 1. Write reversal-of-reversal (revenue restored)
      const userAssetAccountId = await this.ledger.getOrCreateAssetAccount(
        dispute.userId,
        tx
      )
      const revenueAccountId = await this.ledger.getOrCreateSystemAccount(
        LedgerAccountType.REVENUE,
        tx
      )

      await this.ledger.recordTransaction(
        dispute.userId,
        `Dispute WON: reversal-of-reversal for dispute ${dispute.id}`,
        [
          {
            accountId: userAssetAccountId,
            entryType: LedgerEntryType.DEBIT,
            amount: dispute.amount,
          },
          {
            accountId: revenueAccountId,
            entryType: LedgerEntryType.CREDIT,
            amount: dispute.amount,
          },
        ],
        LedgerTransactionStatus.COMPLETED,
        {
          disputeId: dispute.id,
          outcome: 'WON',
          originalReversalTxnId: dispute.ledgerReversalTxnId,
          type: 'dispute_won_reversal',
        },
        tx,
        `dispute_won_${dispute.id}_ledger`
      )

      // 2. Restore credits (idempotent)
      try {
        await this.credits.addCredits(
          dispute.userId,
          dispute.amount,
          'REFUND',
          `Credits restored: dispute ${dispute.id} won`,
          `dispute_won_${dispute.id}`,
          { disputeId: dispute.id, source: 'dispute_won' }
        )
      } catch (error) {
        // Credits gap: balance may have been manually adjusted or over-spent.
        // See IMPLEMENTATION_PLAN.md #6 for planned finance-alert queue.
        this.logger.warn(
          `Could not restore credits for dispute ${dispute.id}: ` +
          `${error instanceof Error ? error.message : 'unknown error'}`
        )
      }

      // 3. Update dispute status
      const updated = await tx.dispute.update({
        where: { id: dispute.id },
        data: {
          status: DisputeStatus.WON,
          resolvedAt: new Date(),
        },
      })

      // TODO: Subscription access restoration requires manual admin review.
      // The subscription may have been canceled for unrelated reasons,
      // or the billing period may have expired. Auto-restoring access
      // without human review risks giving unearned service.

      this.logger.log(`Dispute ${dispute.id} resolved: WON — revenue restored`)
      return updated
    })
  }

  /**
   * LOST: We lost the dispute — chargeback stands.
   *   1. Original ledger reversal stays in place (revenue already reduced)
   *   2. Record chargeback fee ($15 = 1500 cents) as expense
   *   3. Mark dispute as LOST
   */
  private async handleLost(
    dispute: { id: string; userId: string; amount: number }
  ) {
    const chargebackFeeCents = await this.billingConfig.getInt('chargeback_fee_cents', 1500)

    return this.prisma.$transaction(async (tx) => {
      // 1. Record chargeback fee as expense
      const expenseAccountId = await this.ledger.getOrCreateSystemAccount(
        LedgerAccountType.EXPENSE,
        tx
      )
      const userAssetAccountId = await this.ledger.getOrCreateAssetAccount(
        dispute.userId,
        tx
      )

      await this.ledger.recordTransaction(
        dispute.userId,
        `Chargeback fee for lost dispute ${dispute.id}`,
        [
          {
            accountId: expenseAccountId,
            entryType: LedgerEntryType.DEBIT,
            amount: chargebackFeeCents,
          },
          {
            accountId: userAssetAccountId,
            entryType: LedgerEntryType.CREDIT,
            amount: chargebackFeeCents,
          },
        ],
        LedgerTransactionStatus.COMPLETED,
        {
          disputeId: dispute.id,
          outcome: 'LOST',
          feeType: 'chargeback',
          feeCents: chargebackFeeCents,
          type: 'chargeback_fee',
        },
        tx,
        `dispute_lost_${dispute.id}_fee_ledger`
      )

      // 2. Update dispute status
      const updated = await tx.dispute.update({
        where: { id: dispute.id },
        data: {
          status: DisputeStatus.LOST,
          resolvedAt: new Date(),
        },
      })

      this.logger.log(
        `Dispute ${dispute.id} resolved: LOST — chargeback fee of ${chargebackFeeCents} cents recorded`
      )
      return updated
    })
  }
}
