import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common'
import { randomBytes } from 'crypto'
import {
  LedgerAccountType,
  LedgerEntryType,
  LedgerTransactionStatus,
  Prisma,
} from '@prisma/client'
import { PrismaService } from '../common/prisma.service'
import {
  BalanceResponse,
  LedgerEntryInput,
  LedgerEntryResponse,
  TransactionResponse,
} from './dto/ledger.dto'

/**
 * LedgerService — double-entry accounting for money correctness.
 *
 * Core invariants:
 *   1. Every transaction must have balanced debits and credits (sum == 0).
 *   2. Debit-normal accounts (ASSET, EXPENSE): DEBIT increases balance.
 *   3. Credit-normal accounts (LIABILITY, REVENUE, EQUITY): CREDIT increases balance.
 *   4. Escrow: deducting a user's ASSET account first increases a system
 *      LIABILITY. When the job/charge completes, LIABILITY is drained into REVENUE.
 *      If it fails, LIABILITY is drained back into the user's ASSET.
 *
 * This is the lower-level primitive. The CreditsService operates on a simpler
 * flat balance model that lives alongside the ledger.
 */
@Injectable()
export class LedgerService {
  private readonly logger = new Logger(LedgerService.name)

  // Shared system accounts live under the admin user id by seed convention.
  // Refactoring to a dedicated "system" row is tracked in IMPLEMENTATION_PLAN.md.
  private readonly SYSTEM_USER_ID = 'test-admin-1'

  constructor(private readonly prisma: PrismaService) {}

  async getOrCreateAssetAccount(userId: string, tx?: Prisma.TransactionClient): Promise<string> {
    const client = tx || this.prisma
    const account = await client.ledgerAccount.upsert({
      where: {
        userId_accountType: { userId, accountType: LedgerAccountType.ASSET },
      },
      create: { userId, accountType: LedgerAccountType.ASSET, balance: 0 },
      update: {},
    })
    return account.id
  }

  async getOrCreateSystemAccount(
    accountType: LedgerAccountType,
    tx?: Prisma.TransactionClient
  ): Promise<string> {
    const client = tx || this.prisma
    const account = await client.ledgerAccount.upsert({
      where: {
        userId_accountType: { userId: this.SYSTEM_USER_ID, accountType },
      },
      create: { userId: this.SYSTEM_USER_ID, accountType, balance: 0 },
      update: {},
    })
    return account.id
  }

  async getBalance(userId: string): Promise<BalanceResponse> {
    const account = await this.prisma.ledgerAccount.findUnique({
      where: {
        userId_accountType: { userId, accountType: LedgerAccountType.ASSET },
      },
    })

    if (!account) {
      return { userId, balance: 0, accountId: null, updatedAt: new Date() }
    }
    return {
      userId,
      balance: account.balance,
      accountId: account.id,
      updatedAt: account.updatedAt,
    }
  }

  /**
   * Record a balanced double-entry transaction.
   *
   * Validates that debits equal credits BEFORE touching the database.
   * If called with an externalTx, joins that transaction; otherwise starts one.
   *
   * idempotencyKey: when provided, checks for an existing transaction with that
   * key and returns it immediately if found (defense-in-depth dedup on top of
   * the outer webhook/refund idempotency guards). See IMPLEMENTATION_PLAN.md #3.
   */
  async recordTransaction(
    userId: string | null,
    description: string,
    entries: LedgerEntryInput[],
    status: LedgerTransactionStatus = LedgerTransactionStatus.COMPLETED,
    metadata?: object,
    externalTx?: Prisma.TransactionClient,
    idempotencyKey?: string
  ): Promise<TransactionResponse> {
    if (idempotencyKey) {
      const client = externalTx || this.prisma
      const existing = await client.ledgerTransaction.findFirst({
        where: { idempotencyKey },
        include: { entries: true },
      })
      if (existing) {
        this.logger.log(`recordTransaction idempotent hit: ${idempotencyKey}`)
        return this.mapToTransactionResponse(existing)
      }
    }
    if (entries.length < 2) {
      throw new BadRequestException('Transaction must have at least 2 entries')
    }

    let debitTotal = 0
    let creditTotal = 0
    for (const entry of entries) {
      if (entry.amount <= 0) {
        throw new BadRequestException('Entry amounts must be positive')
      }
      if (entry.entryType === LedgerEntryType.DEBIT) {
        debitTotal += entry.amount
      } else {
        creditTotal += entry.amount
      }
    }

    if (debitTotal !== creditTotal) {
      throw new BadRequestException(
        `Transaction not balanced: debits (${debitTotal}) != credits (${creditTotal})`
      )
    }

    const run = (tx: Prisma.TransactionClient) =>
      this.executeRecord(tx, userId, description, entries, status, metadata, idempotencyKey)

    if (externalTx) return run(externalTx)
    return this.prisma.$transaction((tx) => run(tx))
  }

  private async executeRecord(
    tx: Prisma.TransactionClient,
    userId: string | null,
    description: string,
    entries: LedgerEntryInput[],
    status: LedgerTransactionStatus,
    metadata?: object,
    idempotencyKey?: string
  ): Promise<TransactionResponse> {
    const transactionId = `txn_${randomBytes(16).toString('hex')}_${Date.now()}`

    const transaction = await tx.ledgerTransaction.create({
      data: {
        transactionId,
        userId,
        description,
        status,
        metadata: metadata as Prisma.InputJsonValue,
        ...(idempotencyKey ? { idempotencyKey } : {}),
      },
    })

    for (const entry of entries) {
      const account = await tx.ledgerAccount.findUnique({
        where: { id: entry.accountId },
      })
      if (!account) {
        throw new NotFoundException(`Ledger account ${entry.accountId} not found`)
      }

      await tx.ledgerEntry.create({
        data: {
          ledgerTransactionId: transaction.id,
          accountId: entry.accountId,
          entryType: entry.entryType,
          amount: entry.amount,
        },
      })

      const delta = this.calculateBalanceChange(
        account.accountType,
        entry.entryType,
        entry.amount
      )
      await tx.ledgerAccount.update({
        where: { id: entry.accountId },
        data: { balance: { increment: delta } },
      })
    }

    this.logger.log(`Recorded transaction ${transactionId}: ${description}`)

    const result = await tx.ledgerTransaction.findUnique({
      where: { id: transaction.id },
      include: { entries: true },
    })
    return this.mapToTransactionResponse(result)
  }

  /**
   * Debit-normal: DEBIT +, CREDIT -
   * Credit-normal: CREDIT +, DEBIT -
   */
  private calculateBalanceChange(
    accountType: LedgerAccountType,
    entryType: LedgerEntryType,
    amount: number
  ): number {
    const isDebitNormal =
      accountType === LedgerAccountType.ASSET || accountType === LedgerAccountType.EXPENSE
    if (isDebitNormal) {
      return entryType === LedgerEntryType.DEBIT ? amount : -amount
    }
    return entryType === LedgerEntryType.CREDIT ? amount : -amount
  }

  async getTransactionHistory(
    userId: string,
    limit = 50,
    offset = 0
  ): Promise<{ transactions: TransactionResponse[]; total: number }> {
    const [txns, total] = await Promise.all([
      this.prisma.ledgerTransaction.findMany({
        where: { userId },
        include: { entries: true },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.ledgerTransaction.count({ where: { userId } }),
    ])
    return {
      transactions: txns.map((t) => this.mapToTransactionResponse(t)),
      total,
    }
  }

  private mapToTransactionResponse(txn: any): TransactionResponse {
    return {
      id: txn.id,
      transactionId: txn.transactionId,
      userId: txn.userId,
      description: txn.description,
      status: txn.status,
      metadata: (txn.metadata as object) || null,
      entries: (txn.entries || []).map(
        (e: any): LedgerEntryResponse => ({
          id: e.id,
          ledgerTransactionId: e.ledgerTransactionId,
          accountId: e.accountId,
          entryType: e.entryType,
          amount: e.amount,
          createdAt: e.createdAt,
        })
      ),
      createdAt: txn.createdAt,
      updatedAt: txn.updatedAt,
    }
  }
}
