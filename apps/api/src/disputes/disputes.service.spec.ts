import { Test, TestingModule } from '@nestjs/testing'
import { NotFoundException, BadRequestException } from '@nestjs/common'
import { DisputeStatus, PaymentGateway } from '@prisma/client'
import { DisputesService } from './disputes.service'
import { PrismaService } from '../common/prisma.service'
import { LedgerService } from '../billing/ledger.service'
import { CreditsService } from '../billing/credits.service'
import { BillingConfigService } from '../billing/billing-config.service'

describe('DisputesService', () => {
  let service: DisputesService
  let prisma: any
  let ledger: any
  let credits: any

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DisputesService,
        {
          provide: PrismaService,
          useValue: {
            dispute: {
              findUnique: jest.fn(),
              findMany: jest.fn(),
              count: jest.fn(),
              create: jest.fn(),
              update: jest.fn(),
            },
            disputeEvidence: {
              create: jest.fn(),
            },
          },
        },
        {
          provide: LedgerService,
          useValue: {
            getOrCreateAssetAccount: jest.fn().mockResolvedValue('asset-acc-1'),
            getOrCreateSystemAccount: jest.fn().mockResolvedValue('system-acc-1'),
            recordTransaction: jest.fn().mockResolvedValue({ id: 'txn-1' }),
          },
        },
        {
          provide: CreditsService,
          useValue: {
            addCredits: jest.fn().mockResolvedValue({ balance: 100, transactionId: 'ct-1' }),
            deductCredits: jest.fn().mockResolvedValue({ balance: 0, transactionId: 'ct-2' }),
          },
        },
        {
          provide: BillingConfigService,
          useValue: {
            getInt: jest.fn().mockResolvedValue(1500),
            get: jest.fn().mockResolvedValue('1500'),
          },
        },
      ],
    }).compile()

    service = module.get<DisputesService>(DisputesService)
    prisma = module.get<PrismaService>(PrismaService)
    ledger = module.get(LedgerService)
    credits = module.get(CreditsService)
  })

  describe('createDispute', () => {
    it('is idempotent by gatewayDisputeId', async () => {
      const existing = {
        id: 'dispute-1',
        gatewayDisputeId: 'chargeback_evt_abc',
      }
      prisma.dispute.findUnique.mockResolvedValue(existing)
      const result = await service.createDispute({
        userId: 'u1',
        gateway: PaymentGateway.AUTHORIZE_NET,
        gatewayDisputeId: 'chargeback_evt_abc',
        originalTransactionId: 'txn_abc',
        amount: 5000,
      })

      expect(result).toBe(existing)
      expect(prisma.dispute.create).not.toHaveBeenCalled()
    })

    it('creates a new dispute when none exists', async () => {
      prisma.dispute.findUnique.mockResolvedValue(null)
      prisma.dispute.create.mockResolvedValue({
        id: 'dispute-new',
        gatewayDisputeId: 'chargeback_evt_xyz',
        status: DisputeStatus.OPEN,
      })

      await service.createDispute({
        userId: 'u1',
        gateway: PaymentGateway.AUTHORIZE_NET,
        gatewayDisputeId: 'chargeback_evt_xyz',
        originalTransactionId: 'txn_xyz',
        amount: 5000,
      })

      expect(prisma.dispute.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: 'u1',
            gatewayDisputeId: 'chargeback_evt_xyz',
            amount: 5000,
            status: DisputeStatus.OPEN,
          }),
        })
      )
    })
  })

  describe('attachEvidence', () => {
    it('throws for unknown disputes', async () => {
      prisma.dispute.findUnique.mockResolvedValue(null)
      await expect(
        service.attachEvidence({
          disputeId: 'ghost',
          submittedBy: 'admin-1',
          evidenceType: 'access_log',
          content: 'User logged in 47 times between 2026-01-01 and 2026-02-01',
        })
      ).rejects.toBeInstanceOf(NotFoundException)
    })

    it('transitions OPEN disputes to EVIDENCE_SUBMITTED', async () => {
      prisma.dispute.findUnique.mockResolvedValue({
        id: 'd1',
        status: DisputeStatus.OPEN,
      })
      prisma.disputeEvidence.create.mockResolvedValue({ id: 'ev1' })
      prisma.dispute.update.mockResolvedValue({})

      await service.attachEvidence({
        disputeId: 'd1',
        submittedBy: 'admin-1',
        evidenceType: 'access_log',
        content: 'access log evidence from 2026-01-15',
      })

      expect(prisma.dispute.update).toHaveBeenCalledWith({
        where: { id: 'd1' },
        data: { status: DisputeStatus.EVIDENCE_SUBMITTED },
      })
    })
  })

  describe('setOutcome', () => {
    it('marks a dispute WON with reversal-of-reversal + credits restore', async () => {
      prisma.dispute.findUnique.mockResolvedValue({
        id: 'd1',
        userId: 'u1',
        amount: 5000,
        status: DisputeStatus.EVIDENCE_SUBMITTED,
        ledgerReversalTxnId: 'txn-reversal-1',
      })
      prisma.dispute.update.mockResolvedValue({ id: 'd1', status: DisputeStatus.WON })
      prisma.$transaction = jest.fn((cb: Function) => cb(prisma))

      await service.setOutcome('d1', 'WON')

      expect(ledger.recordTransaction).toHaveBeenCalled()
      expect(credits.addCredits).toHaveBeenCalledWith(
        'u1',
        5000,
        'REFUND',
        expect.stringContaining('dispute d1 won'),
        'dispute_won_d1',
        expect.objectContaining({ disputeId: 'd1' })
      )
      expect(prisma.dispute.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: DisputeStatus.WON }),
        })
      )
    })

    it('marks a dispute LOST with chargeback fee', async () => {
      prisma.dispute.findUnique.mockResolvedValue({
        id: 'd2',
        userId: 'u1',
        amount: 5000,
        status: DisputeStatus.OPEN,
      })
      prisma.dispute.update.mockResolvedValue({ id: 'd2', status: DisputeStatus.LOST })
      prisma.$transaction = jest.fn((cb: Function) => cb(prisma))

      await service.setOutcome('d2', 'LOST')

      expect(ledger.recordTransaction).toHaveBeenCalled()
      expect(prisma.dispute.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: DisputeStatus.LOST }),
        })
      )
    })

    it('rejects invalid transitions (WON → LOST)', async () => {
      prisma.dispute.findUnique.mockResolvedValue({
        id: 'd3',
        status: DisputeStatus.WON,
      })

      await expect(service.setOutcome('d3', 'LOST')).rejects.toBeInstanceOf(
        BadRequestException
      )
    })

    it('throws for unknown disputes', async () => {
      prisma.dispute.findUnique.mockResolvedValue(null)

      await expect(service.setOutcome('ghost', 'WON')).rejects.toBeInstanceOf(
        NotFoundException
      )
    })
  })
})
