import { Test, TestingModule } from '@nestjs/testing'
import { NotFoundException, BadRequestException } from '@nestjs/common'
import { PaymentGateway, SubscriptionStatus } from '@prisma/client'
import { SubscriptionsService } from './subscriptions.service'
import { PrismaService } from '../common/prisma.service'

describe('SubscriptionsService', () => {
  let service: SubscriptionsService
  let prisma: any

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SubscriptionsService,
        {
          provide: PrismaService,
          useValue: {
            subscription: {
              findUnique: jest.fn(),
              upsert: jest.fn(),
              update: jest.fn(),
            },
            gatewaySubscription: {
              upsert: jest.fn(),
            },
          },
        },
      ],
    }).compile()

    service = module.get<SubscriptionsService>(SubscriptionsService)
    prisma = module.get<PrismaService>(PrismaService)
  })

  describe('no-dunning policy', () => {
    it('cancelImmediately flips status to CANCELED and plan to BASIC', async () => {
      prisma.subscription.findUnique.mockResolvedValue({
        id: 's1',
        userId: 'u1',
        status: SubscriptionStatus.ACTIVE,
        plan: 'STANDARD',
      })
      prisma.subscription.update.mockResolvedValue({
        id: 's1',
        userId: 'u1',
        status: SubscriptionStatus.CANCELED,
        plan: 'BASIC',
      })

      const result = await service.cancelImmediately('u1', 'charge failed')

      expect(prisma.subscription.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'u1' },
          data: expect.objectContaining({
            status: SubscriptionStatus.CANCELED,
            plan: 'BASIC',
          }),
        })
      )
      expect(result?.status).toBe(SubscriptionStatus.CANCELED)
    })

    it('cancelImmediately is a no-op for users with no subscription', async () => {
      prisma.subscription.findUnique.mockResolvedValue(null)
      const result = await service.cancelImmediately('ghost-user', 'test')
      expect(result).toBeNull()
      expect(prisma.subscription.update).not.toHaveBeenCalled()
    })
  })

  describe('cancelAtPeriodEnd', () => {
    it('throws when user has no subscription', async () => {
      prisma.subscription.findUnique.mockResolvedValue(null)
      await expect(service.cancelAtPeriodEnd('u1')).rejects.toBeInstanceOf(
        NotFoundException
      )
    })

    it('throws when subscription is already canceled', async () => {
      prisma.subscription.findUnique.mockResolvedValue({
        id: 's1',
        status: SubscriptionStatus.CANCELED,
      })
      await expect(service.cancelAtPeriodEnd('u1')).rejects.toBeInstanceOf(
        BadRequestException
      )
    })

    it('sets cancelAtPeriodEnd=true otherwise', async () => {
      prisma.subscription.findUnique.mockResolvedValue({
        id: 's1',
        status: SubscriptionStatus.ACTIVE,
      })
      prisma.subscription.update.mockResolvedValue({ id: 's1', cancelAtPeriodEnd: true })
      await service.cancelAtPeriodEnd('u1')
      expect(prisma.subscription.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { cancelAtPeriodEnd: true },
        })
      )
    })
  })

  describe('createOrUpdateFromGateway', () => {
    it('activates a subscription from a card gateway event', async () => {
      prisma.subscription.upsert.mockResolvedValue({
        id: 's1',
        userId: 'u1',
        status: SubscriptionStatus.ACTIVE,
        plan: 'STANDARD',
      })
      prisma.gatewaySubscription.upsert.mockResolvedValue({})

      const result = await service.createOrUpdateFromGateway({
        userId: 'u1',
        plan: 'STANDARD',
        gatewayType: PaymentGateway.AUTHORIZE_NET,
        gatewaySubscriptionId: 'arb-1',
        gatewayCustomerId: 'cust-1',
      })

      expect(result.status).toBe(SubscriptionStatus.ACTIVE)
      expect(prisma.gatewaySubscription.upsert).toHaveBeenCalled()
    })
  })
})
