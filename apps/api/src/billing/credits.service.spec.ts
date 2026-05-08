import { Test, TestingModule } from '@nestjs/testing'
import { BadRequestException } from '@nestjs/common'
import { CreditsService } from './credits.service'
import { PrismaService } from '../common/prisma.service'

/**
 * Unit tests for CreditsService.
 *
 * Pattern: mock PrismaService entirely, verify the service's internal
 * decision-making (idempotency short-circuit, balance math, error paths).
 * Integration-level tests that hit a real DB live in /tests/integration/.
 */
describe('CreditsService', () => {
  let service: CreditsService
  let prisma: any

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CreditsService,
        {
          provide: PrismaService,
          useValue: {
            credits: {
              findUnique: jest.fn(),
              upsert: jest.fn(),
              update: jest.fn(),
            },
            creditTransaction: {
              findFirst: jest.fn(),
              findMany: jest.fn(),
              count: jest.fn(),
              create: jest.fn(),
            },
            $transaction: jest.fn(),
          },
        },
      ],
    }).compile()

    service = module.get<CreditsService>(CreditsService)
    prisma = module.get<PrismaService>(PrismaService)
  })

  describe('getBalance', () => {
    it('returns the balance when the record exists', async () => {
      prisma.credits.findUnique.mockResolvedValue({ id: 'c1', userId: 'u1', balance: 500 })
      expect(await service.getBalance('u1')).toBe(500)
    })

    it('returns 0 when the user has no credits record', async () => {
      prisma.credits.findUnique.mockResolvedValue(null)
      expect(await service.getBalance('u1')).toBe(0)
    })
  })

  describe('addCredits', () => {
    it('rejects non-positive amounts', async () => {
      await expect(
        service.addCredits('u1', 0, 'PURCHASE', 'noop', 'idem-1')
      ).rejects.toBeInstanceOf(BadRequestException)
      await expect(
        service.addCredits('u1', -5, 'PURCHASE', 'noop', 'idem-1')
      ).rejects.toBeInstanceOf(BadRequestException)
    })

    it('short-circuits on duplicate idempotency key', async () => {
      const existing = { id: 'txn-existing' }
      prisma.$transaction.mockImplementation(async (callback: any) =>
        callback({
          creditTransaction: {
            findFirst: jest.fn().mockResolvedValue(existing),
            create: jest.fn(),
          },
          credits: {
            findUnique: jest.fn().mockResolvedValue({ balance: 200 }),
            upsert: jest.fn(),
          },
        })
      )

      const result = await service.addCredits('u1', 100, 'PURCHASE', 'test', 'idem-1')
      expect(result).toEqual({ balance: 200, transactionId: 'txn-existing' })
    })

    it('creates a new transaction when idempotency key is fresh', async () => {
      const createTransaction = jest.fn().mockResolvedValue({ id: 'txn-new' })
      prisma.$transaction.mockImplementation(async (callback: any) =>
        callback({
          creditTransaction: {
            findFirst: jest.fn().mockResolvedValue(null),
            create: createTransaction,
          },
          credits: {
            upsert: jest.fn().mockResolvedValue({ id: 'c1', balance: 300 }),
          },
        })
      )

      const result = await service.addCredits('u1', 100, 'PURCHASE', 'test', 'idem-2')
      expect(result).toEqual({ balance: 300, transactionId: 'txn-new' })
      expect(createTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            amount: 100,
            type: 'PURCHASE',
            metadata: expect.objectContaining({ idempotencyKey: 'idem-2' }),
          }),
        })
      )
    })
  })

  describe('refundCredits', () => {
    it('is idempotent on the same key', async () => {
      const existing = { id: 'txn-existing' }
      prisma.$transaction.mockImplementation(async (callback: any) =>
        callback({
          creditTransaction: {
            findFirst: jest.fn().mockResolvedValue(existing),
          },
          credits: {
            findUnique: jest.fn().mockResolvedValue({ balance: 150 }),
          },
        })
      )

      const result = await service.refundCredits('u1', 50, 'test', 'idem-refund-1')
      expect(result).toEqual({ balance: 150, transactionId: 'txn-existing' })
    })
  })

  describe('deductCredits', () => {
    it('rejects non-positive amounts', async () => {
      await expect(service.deductCredits('u1', 0, 'test')).rejects.toBeInstanceOf(
        BadRequestException
      )
    })
  })
})
