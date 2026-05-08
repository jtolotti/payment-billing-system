import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common'
import {
  RefundType,
  RefundStatus,
  PaymentGateway,
  LedgerAccountType,
  LedgerEntryType,
  LedgerTransactionStatus,
  Prisma,
} from '@prisma/client'
import { PrismaService } from '../common/prisma.service'
import { CreditsService } from '../billing/credits.service'
import { LedgerService } from '../billing/ledger.service'
import { AuthorizeNetGateway } from '../gateways/authorize-net/authorize-net.gateway'
import { SolanaGateway } from '../gateways/solana/solana.gateway'
import { PaymentGatewayAdapter } from '../gateways/gateway.interface'

export interface CreateRefundRequestDto {
  type: RefundType
  amount: number
  reason: string
  gatewayType?: PaymentGateway
  originalGatewayTransactionId?: string
}

/**
 * RefundsService — three-step admin workflow:
 *
 *   createRefundRequest  (user)   → status = PENDING
 *          ↓
 *   approveRefund        (admin)  → status = APPROVED
 *          ↓
 *   processRefund        (admin)  → status = PROCESSED
 *
 * The last step is where money actually moves.
 */
@Injectable()
export class RefundsService {
  private readonly logger = new Logger(RefundsService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly creditsService: CreditsService,
    private readonly ledgerService: LedgerService,
    private readonly authorizeNetGateway: AuthorizeNetGateway,
    private readonly solanaGateway: SolanaGateway,
  ) {}

  async createRefundRequest(userId: string, data: CreateRefundRequestDto) {
    if (data.amount <= 0) throw new BadRequestException('Amount must be positive')

    if (data.type === 'PAYMENT' && !data.gatewayType) {
      throw new BadRequestException('gatewayType is required for PAYMENT refunds')
    }

    const subscription = await this.prisma.subscription.findUnique({
      where: { userId },
    })

    if (data.type === 'PAYMENT' && !subscription) {
      throw new BadRequestException('No payment history for this user')
    }

    // Auto-populate originalGatewayTransactionId from ChargeRecord if not provided.
    // Looks up the most recent settled charge for this user + gateway.
    // Admins can still override by supplying the field explicitly.
    let resolvedTxnId = data.originalGatewayTransactionId
    if (data.type === 'PAYMENT' && data.gatewayType && !resolvedTxnId) {
      const latest = await this.prisma.chargeRecord.findFirst({
        where: { userId, gatewayType: data.gatewayType },
        orderBy: { createdAt: 'desc' },
      })
      if (latest) {
        resolvedTxnId = latest.gatewayTransactionId
        this.logger.log(
          `Auto-populated originalGatewayTransactionId=${resolvedTxnId} ` +
          `for user=${userId} from ChargeRecord`
        )
      }
    }

    return this.prisma.refundRequest.create({
      data: {
        userId,
        type: data.type,
        amount: data.amount,
        reason: data.reason,
        status: RefundStatus.PENDING,
        gatewayType: data.gatewayType,
        originalGatewayTransactionId: resolvedTxnId,
      },
    })
  }

  async listMine(userId: string, limit = 20, offset = 0) {
    const [data, total] = await Promise.all([
      this.prisma.refundRequest.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.refundRequest.count({ where: { userId } }),
    ])
    return { data, total, limit, offset }
  }

  async listAll(filters: { status?: RefundStatus; limit?: number; offset?: number } = {}) {
    const limit = Math.min(filters.limit ?? 20, 100)
    const offset = filters.offset ?? 0
    const where: Prisma.RefundRequestWhereInput = {}
    if (filters.status) where.status = filters.status

    const [data, total] = await Promise.all([
      this.prisma.refundRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
        include: { user: { select: { id: true, email: true, name: true } } },
      }),
      this.prisma.refundRequest.count({ where }),
    ])
    return { data, total, limit, offset }
  }

  async get(id: string) {
    const refund = await this.prisma.refundRequest.findUnique({
      where: { id },
      include: { user: { select: { id: true, email: true, name: true } } },
    })
    if (!refund) throw new NotFoundException('Refund request not found')
    return refund
  }

  async approveRefund(id: string, adminId: string, notes?: string) {
    const refund = await this.prisma.refundRequest.findUnique({ where: { id } })
    if (!refund) throw new NotFoundException('Refund request not found')
    if (refund.status !== 'PENDING') {
      throw new BadRequestException(`Cannot approve a refund in status ${refund.status}`)
    }
    return this.prisma.refundRequest.update({
      where: { id },
      data: {
        status: RefundStatus.APPROVED,
        reviewedBy: adminId,
        reviewedAt: new Date(),
        reviewNotes: notes,
      },
    })
  }

  async denyRefund(id: string, adminId: string, notes: string) {
    if (!notes?.trim()) {
      throw new BadRequestException('Review notes are required when denying a refund')
    }
    const refund = await this.prisma.refundRequest.findUnique({ where: { id } })
    if (!refund) throw new NotFoundException('Refund request not found')
    if (refund.status !== 'PENDING') {
      throw new BadRequestException(`Cannot deny a refund in status ${refund.status}`)
    }
    return this.prisma.refundRequest.update({
      where: { id },
      data: {
        status: RefundStatus.DENIED,
        reviewedBy: adminId,
        reviewedAt: new Date(),
        reviewNotes: notes,
      },
    })
  }

  /**
   * Process an approved refund. Dispatches to credit or payment handler.
   */
  async processRefund(id: string) {
    const refund = await this.prisma.refundRequest.findUnique({
      where: { id },
      include: { user: true },
    })
    if (!refund) throw new NotFoundException('Refund request not found')
    if (refund.status !== 'APPROVED') {
      throw new BadRequestException('Only approved refund requests can be processed')
    }

    try {
      if (refund.type === 'CREDITS') {
        await this.processCreditRefund(refund)
      } else {
        await this.processPaymentRefund(refund)
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error'

      await this.prisma.refundRequest.update({
        where: { id },
        data: {
          processAttempts: { increment: 1 },
          lastProcessError: errorMessage,
        },
      })

      this.logger.error(
        `Refund ${id} process attempt ${refund.processAttempts + 1} failed: ${errorMessage}`
      )
      throw error
    }

    return this.prisma.refundRequest.update({
      where: { id },
      data: {
        status: RefundStatus.PROCESSED,
        lastProcessError: null,
      },
    })
  }

  /**
   * Process a credit refund — implemented in full. Grants credits back to
   * the user via the idempotent CreditsService.refundCredits.
   */
  private async processCreditRefund(refund: {
    id: string
    userId: string
    amount: number
  }): Promise<void> {
    const idempotencyKey = `refund_${refund.id}`
    await this.creditsService.refundCredits(
      refund.userId,
      refund.amount,
      `Refund for request ${refund.id}`,
      idempotencyKey,
      { refundRequestId: refund.id, source: 'admin_approved_refund' }
    )
  }

  /**
   * Process a payment refund — gateway execution + ledger reversal + credits deduction.
   *
   * Design: gateway-first, then atomic DB transaction.
   *   - Gateway call is idempotent (idempotencyKey = refund_{refundId}).
   *   - If DB transaction fails after gateway succeeds, retry is safe:
   *     gateway returns cached result, DB transaction runs fresh.
   *   - If DB transaction succeeds but status update fails (crash recovery path 2),
   *     paymentRefundId guard detects the prior write and skips to status update.
   *
   * Handles: partial refunds, canceled subscriptions, insufficient credits.
   */
  private async processPaymentRefund(refund: {
    id: string
    userId: string
    amount: number
    gatewayType: PaymentGateway | null
    originalGatewayTransactionId: string | null
    paymentRefundId: string | null
  }): Promise<void> {
    // Crash recovery path 2: DB transaction succeeded previously but status
    // update to PROCESSED failed. Ledger + credits already written — skip.
    if (refund.paymentRefundId) {
      this.logger.warn(
        `Refund ${refund.id} already has paymentRefundId=${refund.paymentRefundId}, ` +
        `skipping gateway + ledger (crash recovery path 2)`
      )
      return
    }

    // Resolve the correct gateway adapter
    if (!refund.gatewayType) {
      throw new BadRequestException('gatewayType is required for payment refunds')
    }
    const adapter = this.resolveGateway(refund.gatewayType)

    if (!refund.originalGatewayTransactionId) {
      throw new BadRequestException(
        'originalGatewayTransactionId is required for payment refunds'
      )
    }

    // Step 1: Call gateway (BEFORE DB transaction for idempotent retry safety)
    const idempotencyKey = `refund_${refund.id}`
    const { gatewayRefundId, refundedAmount } = await adapter.refundCharge({
      gatewayTransactionId: refund.originalGatewayTransactionId,
      amount: refund.amount,
      idempotencyKey,
    })

    this.logger.log(
      `Gateway refund succeeded: refundId=${refund.id} gatewayRefundId=${gatewayRefundId} ` +
      `amount=${refundedAmount}`
    )

    // Step 2: Atomic DB transaction — ledger reversal + paymentRefundId + credits deduction
    await this.prisma.$transaction(async (tx) => {
      // 2a. Get/create ledger accounts
      const userAssetAccountId = await this.ledgerService.getOrCreateAssetAccount(
        refund.userId,
        tx
      )
      const revenueAccountId = await this.ledgerService.getOrCreateSystemAccount(
        LedgerAccountType.REVENUE,
        tx
      )

      // 2b. Record balanced ledger reversal:
      //     DEBIT Revenue (decrease revenue) + CREDIT User ASSET (money returned)
      await this.ledgerService.recordTransaction(
        refund.userId,
        `Payment refund for request ${refund.id}`,
        [
          {
            accountId: revenueAccountId,
            entryType: LedgerEntryType.DEBIT,
            amount: refundedAmount,
          },
          {
            accountId: userAssetAccountId,
            entryType: LedgerEntryType.CREDIT,
            amount: refundedAmount,
          },
        ],
        LedgerTransactionStatus.COMPLETED,
        {
          refundRequestId: refund.id,
          gatewayRefundId,
          type: 'payment_refund',
        },
        tx,
        `refund_${refund.id}_ledger`
      )

      // 2c. Record gatewayRefundId on the refund request
      await tx.refundRequest.update({
        where: { id: refund.id },
        data: { paymentRefundId: gatewayRefundId },
      })

      // 2d. Deduct credits that were originally granted by the charge.
      //     If user spent their credits, log warning and continue —
      //     real money refund takes priority over virtual credit balance.
      try {
        await this.creditsService.deductCredits(
          refund.userId,
          refund.amount,
          `Credit reversal for payment refund ${refund.id}`,
          idempotencyKey,
          { refundRequestId: refund.id, source: 'payment_refund' }
        )
      } catch (error) {
        this.logger.warn(
          `Could not deduct credits for refund ${refund.id}: ` +
          `${error instanceof Error ? error.message : 'unknown error'}. ` +
          `Continuing — real money refund takes priority.`
        )
      }
    })

    this.logger.log(`Payment refund ${refund.id} completed successfully`)
  }

  private resolveGateway(gatewayType: PaymentGateway): PaymentGatewayAdapter {
    switch (gatewayType) {
      case PaymentGateway.AUTHORIZE_NET:
        return this.authorizeNetGateway
      case PaymentGateway.SOLANA:
        return this.solanaGateway
      default:
        throw new BadRequestException(`Unsupported gateway type: ${gatewayType}`)
    }
  }
}
