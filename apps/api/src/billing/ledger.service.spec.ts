import { Test, TestingModule } from '@nestjs/testing'
import { BadRequestException } from '@nestjs/common'
import { LedgerAccountType, LedgerEntryType, LedgerTransactionStatus } from '@prisma/client'
import { LedgerService } from './ledger.service'
import { PrismaService } from '../common/prisma.service'

describe('LedgerService', () => {
  let service: LedgerService
  let prisma: any

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LedgerService,
        {
          provide: PrismaService,
          useValue: {
            ledgerAccount: {
              findUnique: jest.fn(),
              upsert: jest.fn(),
              update: jest.fn(),
            },
            ledgerTransaction: {
              findUnique: jest.fn(),
              findMany: jest.fn(),
              count: jest.fn(),
              create: jest.fn(),
            },
            ledgerEntry: {
              create: jest.fn(),
            },
            $transaction: jest.fn(),
          },
        },
      ],
    }).compile()

    service = module.get<LedgerService>(LedgerService)
    prisma = module.get<PrismaService>(PrismaService)
  })

  describe('recordTransaction', () => {
    it('rejects transactions with fewer than 2 entries', async () => {
      await expect(
        service.recordTransaction('u1', 'test', [
          { accountId: 'a1', entryType: LedgerEntryType.DEBIT, amount: 100 },
        ])
      ).rejects.toBeInstanceOf(BadRequestException)
    })

    it('rejects transactions where debits != credits', async () => {
      await expect(
        service.recordTransaction('u1', 'test', [
          { accountId: 'a1', entryType: LedgerEntryType.DEBIT, amount: 100 },
          { accountId: 'a2', entryType: LedgerEntryType.CREDIT, amount: 50 },
        ])
      ).rejects.toBeInstanceOf(BadRequestException)
    })

    it('rejects zero or negative entry amounts', async () => {
      await expect(
        service.recordTransaction('u1', 'test', [
          { accountId: 'a1', entryType: LedgerEntryType.DEBIT, amount: 0 },
          { accountId: 'a2', entryType: LedgerEntryType.CREDIT, amount: 0 },
        ])
      ).rejects.toBeInstanceOf(BadRequestException)
    })

    it('accepts a balanced transaction', async () => {
      const mockTxn = { id: 't1', transactionId: 'txn_abc', userId: 'u1' }
      prisma.$transaction.mockImplementation(async (callback: any) =>
        callback({
          ledgerTransaction: {
            create: jest.fn().mockResolvedValue(mockTxn),
            findUnique: jest.fn().mockResolvedValue({
              ...mockTxn,
              description: 'test',
              status: LedgerTransactionStatus.COMPLETED,
              metadata: null,
              entries: [],
              createdAt: new Date(),
              updatedAt: new Date(),
            }),
          },
          ledgerAccount: {
            findUnique: jest
              .fn()
              .mockResolvedValue({ id: 'a1', accountType: LedgerAccountType.ASSET, balance: 0 }),
            update: jest.fn(),
          },
          ledgerEntry: {
            create: jest.fn(),
          },
        })
      )

      const result = await service.recordTransaction('u1', 'test', [
        { accountId: 'a1', entryType: LedgerEntryType.DEBIT, amount: 100 },
        { accountId: 'a2', entryType: LedgerEntryType.CREDIT, amount: 100 },
      ])

      expect(result.id).toBe('t1')
      expect(result.transactionId).toBe('txn_abc')
    })
  })

  describe('getBalance', () => {
    it('returns 0 for users with no asset account', async () => {
      prisma.ledgerAccount.findUnique.mockResolvedValue(null)
      const result = await service.getBalance('u1')
      expect(result.balance).toBe(0)
      expect(result.accountId).toBeNull()
    })

    it('returns the balance from the asset account', async () => {
      const now = new Date()
      prisma.ledgerAccount.findUnique.mockResolvedValue({
        id: 'acct-1',
        userId: 'u1',
        balance: 2500,
        updatedAt: now,
      })
      const result = await service.getBalance('u1')
      expect(result.balance).toBe(2500)
      expect(result.accountId).toBe('acct-1')
    })
  })
})
