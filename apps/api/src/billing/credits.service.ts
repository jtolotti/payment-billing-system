import { Injectable, BadRequestException, Logger } from '@nestjs/common'
import { CreditTransactionType, Prisma } from '@prisma/client'
import { PrismaService } from '../common/prisma.service'

/**
 * CreditsService — flat credit balance with idempotent mutations.
 *
 * Sits alongside (not on top of) the LedgerService. The ledger is the formal
 * accounting record; this is the user-facing "how many credits do I have left"
 * number. Operations are idempotent via an idempotencyKey stored in the
 * transaction metadata JSONB column and looked up before each mutation.
 *
 * Key design choices (all intentional, discussed in architecture.md):
 *   1. Idempotency lookup is inside the $transaction, not outside, to prevent
 *      the read-then-write race between two concurrent webhook replays.
 *   2. deductCredits uses SELECT ... FOR UPDATE to row-lock the credits row
 *      under ReadCommitted isolation, preventing double-spend.
 *   3. Idempotency key convention: `{source}_{externalId}` (e.g.,
 *      `authorize_net_charge_${transactionId}`, `refund_${refundRequestId}`).
 */
@Injectable()
export class CreditsService {
  private readonly logger = new Logger(CreditsService.name)

  constructor(private readonly prisma: PrismaService) {}

  async getBalance(userId: string): Promise<number> {
    const credits = await this.prisma.credits.findUnique({ where: { userId } })
    return credits?.balance ?? 0
  }

  /**
   * Grant credits to a user. Idempotent.
   * Safe to call from webhook handlers that may retry.
   */
  async addCredits(
    userId: string,
    amount: number,
    type: CreditTransactionType,
    description: string,
    idempotencyKey: string,
    metadata?: Record<string, any>
  ): Promise<{ balance: number; transactionId: string }> {
    if (amount <= 0) throw new BadRequestException('Amount must be positive')

    const result = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.creditTransaction.findFirst({
        where: {
          metadata: { path: ['idempotencyKey'], equals: idempotencyKey },
        },
      })
      if (existing) {
        this.logger.log(`addCredits short-circuited: idempotencyKey=${idempotencyKey}`)
        const credits = await tx.credits.findUnique({ where: { userId } })
        return { balance: credits?.balance ?? 0, transactionId: existing.id }
      }

      const credits = await tx.credits.upsert({
        where: { userId },
        create: { userId, balance: amount },
        update: { balance: { increment: amount } },
      })

      const transaction = await tx.creditTransaction.create({
        data: {
          creditsId: credits.id,
          amount,
          type,
          description,
          metadata: { ...metadata, idempotencyKey },
        },
      })

      return { balance: credits.balance, transactionId: transaction.id }
    })

    this.logger.log(`addCredits user=${userId} amount=+${amount} → balance=${result.balance}`)
    return result
  }

  /**
   * Deduct credits from a user. Row-locked via FOR UPDATE to prevent
   * concurrent double-spend. Optional idempotency key for webhook retries.
   */
  async deductCredits(
    userId: string,
    amount: number,
    description: string,
    idempotencyKey?: string,
    metadata?: Record<string, any>
  ): Promise<{ balance: number; transactionId: string }> {
    if (amount <= 0) throw new BadRequestException('Amount must be positive')

    const result = await this.prisma.$transaction(
      async (tx) => {
        if (idempotencyKey) {
          const existing = await tx.creditTransaction.findFirst({
            where: {
              metadata: { path: ['idempotencyKey'], equals: idempotencyKey },
            },
          })
          if (existing) {
            this.logger.log(`deductCredits short-circuited: idempotencyKey=${idempotencyKey}`)
            const credits = await tx.credits.findUnique({ where: { userId } })
            return { balance: credits?.balance ?? 0, transactionId: existing.id }
          }
        }

        // Row-lock the credits row to serialize concurrent deductions.
        const rows = await tx.$queryRaw<Array<{ id: string; balance: number }>>`
          SELECT "id", "balance" FROM "credits" WHERE "user_id" = ${userId} FOR UPDATE
        `
        const locked = rows[0]
        if (!locked || locked.balance < amount) {
          throw new BadRequestException('Insufficient credits')
        }

        const updated = await tx.credits.update({
          where: { userId },
          data: { balance: { decrement: amount } },
        })

        const transaction = await tx.creditTransaction.create({
          data: {
            creditsId: locked.id,
            amount: -amount,
            type: 'USAGE',
            description,
            metadata: {
              ...metadata,
              ...(idempotencyKey && { idempotencyKey }),
            },
          },
        })

        return { balance: updated.balance, transactionId: transaction.id }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }
    )

    this.logger.log(`deductCredits user=${userId} amount=-${amount} → balance=${result.balance}`)
    return result
  }

  /**
   * Refund credits (idempotent). Used by both the manual refund flow and the
   * gateway-executed payment refund flow.
   */
  async refundCredits(
    userId: string,
    amount: number,
    description: string,
    idempotencyKey: string,
    metadata?: Record<string, any>
  ): Promise<{ balance: number; transactionId: string }> {
    if (amount <= 0) throw new BadRequestException('Amount must be positive')

    const result = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.creditTransaction.findFirst({
        where: {
          metadata: { path: ['idempotencyKey'], equals: idempotencyKey },
        },
      })
      if (existing) {
        const credits = await tx.credits.findUnique({ where: { userId } })
        return { balance: credits?.balance ?? 0, transactionId: existing.id }
      }

      const credits = await tx.credits.upsert({
        where: { userId },
        create: { userId, balance: amount },
        update: { balance: { increment: amount } },
      })

      const transaction = await tx.creditTransaction.create({
        data: {
          creditsId: credits.id,
          amount,
          type: 'REFUND',
          description,
          metadata: { ...metadata, idempotencyKey },
        },
      })

      return { balance: credits.balance, transactionId: transaction.id }
    })

    this.logger.log(`refundCredits user=${userId} amount=+${amount} → balance=${result.balance}`)
    return result
  }

  async getTransactionHistory(userId: string, limit = 50, offset = 0) {
    const credits = await this.prisma.credits.findUnique({ where: { userId } })
    if (!credits) return { transactions: [], total: 0 }

    const [transactions, total] = await Promise.all([
      this.prisma.creditTransaction.findMany({
        where: { creditsId: credits.id },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.creditTransaction.count({ where: { creditsId: credits.id } }),
    ])

    return { transactions, total }
  }
}
