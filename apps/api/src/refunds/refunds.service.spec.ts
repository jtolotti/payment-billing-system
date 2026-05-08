import { Test, TestingModule } from '@nestjs/testing'
import { BadRequestException, NotFoundException } from '@nestjs/common'
import { RefundStatus, RefundType, PaymentGateway } from '@prisma/client'
import { RefundsService } from './refunds.service'
import { PrismaService } from '../common/prisma.service'
import { CreditsService } from '../billing/credits.service'
import { LedgerService } from '../billing/ledger.service'
import { AuthorizeNetGateway } from '../gateways/authorize-net/authorize-net.gateway'
import { SolanaGateway } from '../gateways/solana/solana.gateway'

describe('RefundsService', () => {
  let service: RefundsService
  let prisma: any
  let credits: jest.Mocked<CreditsService>
  let ledger: any
  let authorizeNet: any

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RefundsService,
        {
          provide: PrismaService,
          useValue: {
            refundRequest: {
              findUnique: jest.fn(),
              findMany: jest.fn(),
              count: jest.fn(),
              create: jest.fn(),
              update: jest.fn(),
            },
            subscription: {
              findUnique: jest.fn(),
            },
          },
        },
        {
          provide: CreditsService,
          useValue: {
            refundCredits: jest.fn(),
            deductCredits: jest.fn(),
          },
        },
        {
          provide: LedgerService,
          useValue: {
            getOrCreateAssetAccount: jest.fn().mockResolvedValue('asset-acc-1'),
            getOrCreateSystemAccount: jest.fn().mockResolvedValue('revenue-acc-1'),
            recordTransaction: jest.fn().mockResolvedValue({ id: 'txn-1' }),
          },
        },
        {
          provide: AuthorizeNetGateway,
          useValue: {
            gateway: PaymentGateway.AUTHORIZE_NET,
            refundCharge: jest.fn().mockResolvedValue({
              gatewayRefundId: 'gw-refund-1',
              refundedAmount: 2500,
            }),
          },
        },
        {
          provide: SolanaGateway,
          useValue: {
            gateway: PaymentGateway.SOLANA,
            refundCharge: jest.fn().mockResolvedValue({
              gatewayRefundId: 'sol-refund-1',
              refundedAmount: 2500,
            }),
          },
        },
      ],
    }).compile()

    service = module.get<RefundsService>(RefundsService)
    prisma = module.get<PrismaService>(PrismaService)
    credits = module.get(CreditsService) as jest.Mocked<CreditsService>
    ledger = module.get(LedgerService)
    authorizeNet = module.get(AuthorizeNetGateway)
  })

  describe('createRefundRequest', () => {
    it('requires a positive amount', async () => {
      await expect(
        service.createRefundRequest('u1', {
          type: RefundType.CREDITS,
          amount: 0,
          reason: 'test',
        })
      ).rejects.toBeInstanceOf(BadRequestException)
    })

    it('requires gatewayType for PAYMENT refunds', async () => {
      await expect(
        service.createRefundRequest('u1', {
          type: RefundType.PAYMENT,
          amount: 1000,
          reason: 'test',
        })
      ).rejects.toBeInstanceOf(BadRequestException)
    })

    it('creates a PENDING credits refund request', async () => {
      prisma.refundRequest.create.mockResolvedValue({
        id: 'r1',
        status: RefundStatus.PENDING,
      })

      await service.createRefundRequest('u1', {
        type: RefundType.CREDITS,
        amount: 100,
        reason: 'bug in job output',
      })

      expect(prisma.refundRequest.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: 'u1',
            amount: 100,
            status: RefundStatus.PENDING,
          }),
        })
      )
    })
  })

  describe('approveRefund', () => {
    it('throws for unknown refunds', async () => {
      prisma.refundRequest.findUnique.mockResolvedValue(null)
      await expect(service.approveRefund('ghost', 'admin-1')).rejects.toBeInstanceOf(
        NotFoundException
      )
    })

    it('rejects non-PENDING refunds', async () => {
      prisma.refundRequest.findUnique.mockResolvedValue({ id: 'r1', status: 'APPROVED' })
      await expect(service.approveRefund('r1', 'admin-1')).rejects.toBeInstanceOf(
        BadRequestException
      )
    })
  })

  describe('processRefund', () => {
    it('rejects non-APPROVED refunds', async () => {
      prisma.refundRequest.findUnique.mockResolvedValue({
        id: 'r1',
        status: RefundStatus.PENDING,
      })
      await expect(service.processRefund('r1')).rejects.toBeInstanceOf(BadRequestException)
    })

    it('processes a CREDITS refund via CreditsService', async () => {
      prisma.refundRequest.findUnique.mockResolvedValue({
        id: 'r1',
        userId: 'u1',
        amount: 100,
        type: RefundType.CREDITS,
        status: RefundStatus.APPROVED,
        user: { id: 'u1' },
      })
      prisma.refundRequest.update.mockResolvedValue({ id: 'r1', status: RefundStatus.PROCESSED })

      await service.processRefund('r1')

      expect(credits.refundCredits).toHaveBeenCalledWith(
        'u1',
        100,
        expect.any(String),
        'refund_r1',
        expect.objectContaining({ refundRequestId: 'r1' })
      )
    })

    it('processes a PAYMENT refund via gateway + ledger + credits', async () => {
      prisma.refundRequest.findUnique.mockResolvedValue({
        id: 'r2',
        userId: 'u1',
        amount: 2500,
        type: RefundType.PAYMENT,
        status: RefundStatus.APPROVED,
        gatewayType: PaymentGateway.AUTHORIZE_NET,
        originalGatewayTransactionId: 'an_txn_123',
        paymentRefundId: null,
        processAttempts: 0,
        user: { id: 'u1' },
      })
      prisma.refundRequest.update.mockResolvedValue({ id: 'r2', status: RefundStatus.PROCESSED })
      prisma.$transaction = jest.fn((cb: Function) => cb(prisma))

      await service.processRefund('r2')

      expect(authorizeNet.refundCharge).toHaveBeenCalledWith({
        gatewayTransactionId: 'an_txn_123',
        amount: 2500,
        idempotencyKey: 'refund_r2',
      })
      expect(ledger.recordTransaction).toHaveBeenCalled()
      expect(prisma.refundRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'r2' },
          data: expect.objectContaining({ paymentRefundId: 'gw-refund-1' }),
        })
      )
    })

    it('skips gateway + ledger when paymentRefundId already set (crash recovery path 2)', async () => {
      prisma.refundRequest.findUnique.mockResolvedValue({
        id: 'r3',
        userId: 'u1',
        amount: 2500,
        type: RefundType.PAYMENT,
        status: RefundStatus.APPROVED,
        gatewayType: PaymentGateway.AUTHORIZE_NET,
        originalGatewayTransactionId: 'an_txn_123',
        paymentRefundId: 'gw-refund-already-set',
        user: { id: 'u1' },
      })
      prisma.refundRequest.update.mockResolvedValue({ id: 'r3', status: RefundStatus.PROCESSED })

      await service.processRefund('r3')

      expect(authorizeNet.refundCharge).not.toHaveBeenCalled()
      expect(ledger.recordTransaction).not.toHaveBeenCalled()
      expect(prisma.refundRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: RefundStatus.PROCESSED, lastProcessError: null },
        })
      )
    })

    it('throws when gatewayType is missing for PAYMENT refund', async () => {
      prisma.refundRequest.findUnique.mockResolvedValue({
        id: 'r4',
        userId: 'u1',
        amount: 1000,
        type: RefundType.PAYMENT,
        status: RefundStatus.APPROVED,
        gatewayType: null,
        originalGatewayTransactionId: 'an_txn_123',
        paymentRefundId: null,
        processAttempts: 0,
        user: { id: 'u1' },
      })
      prisma.refundRequest.update.mockResolvedValue({ id: 'r4' })

      await expect(service.processRefund('r4')).rejects.toThrow(
        'gatewayType is required'
      )
      expect(prisma.refundRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { processAttempts: { increment: 1 }, lastProcessError: 'gatewayType is required for payment refunds' },
        })
      )
    })

    it('throws when originalGatewayTransactionId is missing', async () => {
      prisma.refundRequest.findUnique.mockResolvedValue({
        id: 'r5',
        userId: 'u1',
        amount: 1000,
        type: RefundType.PAYMENT,
        status: RefundStatus.APPROVED,
        gatewayType: PaymentGateway.AUTHORIZE_NET,
        originalGatewayTransactionId: null,
        paymentRefundId: null,
        processAttempts: 0,
        user: { id: 'u1' },
      })
      prisma.refundRequest.update.mockResolvedValue({ id: 'r5' })

      await expect(service.processRefund('r5')).rejects.toThrow(
        'originalGatewayTransactionId is required'
      )
      expect(prisma.refundRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { processAttempts: { increment: 1 }, lastProcessError: 'originalGatewayTransactionId is required for payment refunds' },
        })
      )
    })

    it('does not roll back gateway refund when DB transaction fails', async () => {
      prisma.refundRequest.findUnique.mockResolvedValue({
        id: 'r6',
        userId: 'u1',
        amount: 2500,
        type: RefundType.PAYMENT,
        status: RefundStatus.APPROVED,
        gatewayType: PaymentGateway.AUTHORIZE_NET,
        originalGatewayTransactionId: 'an_txn_456',
        paymentRefundId: null,
        processAttempts: 0,
        user: { id: 'u1' },
      })
      prisma.$transaction = jest.fn().mockRejectedValue(new Error('DB connection lost'))
      prisma.refundRequest.update.mockResolvedValue({ id: 'r6' })

      await expect(service.processRefund('r6')).rejects.toThrow('DB connection lost')
      expect(authorizeNet.refundCharge).toHaveBeenCalled()
      expect(prisma.refundRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { processAttempts: { increment: 1 }, lastProcessError: 'DB connection lost' },
        })
      )
    })

    it('continues when credits deduction fails (insufficient balance)', async () => {
      prisma.refundRequest.findUnique.mockResolvedValue({
        id: 'r7',
        userId: 'u1',
        amount: 2500,
        type: RefundType.PAYMENT,
        status: RefundStatus.APPROVED,
        gatewayType: PaymentGateway.AUTHORIZE_NET,
        originalGatewayTransactionId: 'an_txn_789',
        paymentRefundId: null,
        processAttempts: 0,
        user: { id: 'u1' },
      })
      prisma.refundRequest.update.mockResolvedValue({ id: 'r7', status: RefundStatus.PROCESSED })
      prisma.$transaction = jest.fn((cb: Function) => cb(prisma))
      credits.deductCredits.mockRejectedValue(new BadRequestException('Insufficient credits'))

      await service.processRefund('r7')

      expect(authorizeNet.refundCharge).toHaveBeenCalled()
      expect(ledger.recordTransaction).toHaveBeenCalled()
    })

    it('propagates gateway errors without touching the DB', async () => {
      prisma.refundRequest.findUnique.mockResolvedValue({
        id: 'r8',
        userId: 'u1',
        amount: 2500,
        type: RefundType.PAYMENT,
        status: RefundStatus.APPROVED,
        gatewayType: PaymentGateway.AUTHORIZE_NET,
        originalGatewayTransactionId: 'an_txn_bad',
        paymentRefundId: null,
        processAttempts: 1,
        user: { id: 'u1' },
      })
      authorizeNet.refundCharge.mockRejectedValue(new Error('Gateway declined'))
      prisma.refundRequest.update.mockResolvedValue({ id: 'r8' })

      await expect(service.processRefund('r8')).rejects.toThrow('Gateway declined')
      expect(ledger.recordTransaction).not.toHaveBeenCalled()
      expect(prisma.refundRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { processAttempts: { increment: 1 }, lastProcessError: 'Gateway declined' },
        })
      )
    })
  })
})
