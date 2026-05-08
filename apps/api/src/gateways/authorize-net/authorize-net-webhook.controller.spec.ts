import { Test, TestingModule } from '@nestjs/testing'
import { ConfigService } from '@nestjs/config'
import { PaymentGateway } from '@prisma/client'
import { AuthorizeNetWebhookController } from './authorize-net-webhook.controller'
import { PrismaService } from '../../common/prisma.service'
import { CreditsService } from '../../billing/credits.service'
import { LedgerService } from '../../billing/ledger.service'
import { SubscriptionsService } from '../../billing/subscriptions.service'
import { DisputesService } from '../../disputes/disputes.service'
import { signHmac } from '../../common/hmac.util'

describe('AuthorizeNetWebhookController — chargeback.received', () => {
  let controller: AuthorizeNetWebhookController
  let prisma: any
  let disputes: any
  let ledger: any
  let credits: any

  beforeEach(async () => {
    const txProxy = {} as any

    prisma = {
      processedWebhook: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      dispute: {
        update: jest.fn(),
      },
      $transaction: jest.fn(async (cb: Function) => {
        // Make txProxy delegates to prisma itself for the mock
        Object.assign(txProxy, {
          processedWebhook: prisma.processedWebhook,
          dispute: prisma.dispute,
        })
        return cb(txProxy)
      }),
    }

    disputes = {
      createDispute: jest.fn().mockResolvedValue({
        id: 'dispute-1',
        userId: 'u1',
        amount: 5000,
        ledgerReversalTxnId: null,
      }),
    }

    ledger = {
      getOrCreateAssetAccount: jest.fn().mockResolvedValue('asset-acc-1'),
      getOrCreateSystemAccount: jest.fn().mockResolvedValue('revenue-acc-1'),
      recordTransaction: jest.fn().mockResolvedValue({ id: 'ledger-txn-1' }),
    }

    credits = {
      addCredits: jest.fn(),
      deductCredits: jest.fn(),
    }

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthorizeNetWebhookController],
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: CreditsService, useValue: credits },
        { provide: LedgerService, useValue: ledger },
        { provide: SubscriptionsService, useValue: {} },
        { provide: DisputesService, useValue: disputes },
        {
          provide: ConfigService,
          useValue: { get: () => '' },
        },
      ],
    }).compile()

    controller = module.get(AuthorizeNetWebhookController)
  })

  function makeReq(body: any) {
    const raw = Buffer.from(JSON.stringify(body))
    return { rawBody: raw } as any
  }

  function sign(body: any): string {
    return signHmac(Buffer.from(JSON.stringify(body)), '')
  }

  const chargebackEvent = {
    eventId: 'evt_cb_1',
    type: 'chargeback.received',
    data: {
      userId: 'u1',
      transactionId: 'an_txn_999',
      amount: 5000,
      reason: 'Fraudulent',
    },
  }

  it('creates dispute + ledger reversal + deducts credits on first call', async () => {
    await controller.handleWebhook(makeReq(chargebackEvent), sign(chargebackEvent), chargebackEvent)

    expect(disputes.createDispute).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        gateway: PaymentGateway.AUTHORIZE_NET,
        originalTransactionId: 'an_txn_999',
        amount: 5000,
      })
    )
    expect(ledger.recordTransaction).toHaveBeenCalled()
    expect(prisma.dispute.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { ledgerReversalTxnId: 'ledger-txn-1' },
      })
    )
    expect(credits.deductCredits).toHaveBeenCalledWith(
      'u1',
      5000,
      expect.stringContaining('chargeback'),
      'chargeback_an_txn_999',
      expect.objectContaining({ disputeId: 'dispute-1' })
    )
  })

  it('skips ledger reversal when dispute already has ledgerReversalTxnId (idempotent replay)', async () => {
    disputes.createDispute.mockResolvedValue({
      id: 'dispute-1',
      userId: 'u1',
      amount: 5000,
      ledgerReversalTxnId: 'already-reversed',
    })

    await controller.handleWebhook(makeReq(chargebackEvent), sign(chargebackEvent), chargebackEvent)

    expect(disputes.createDispute).toHaveBeenCalled()
    expect(ledger.recordTransaction).not.toHaveBeenCalled()
    expect(credits.deductCredits).not.toHaveBeenCalled()
  })

  it('dedup short-circuits on fast-path (processed_webhooks already exists)', async () => {
    prisma.processedWebhook.findUnique.mockResolvedValue({ id: 'evt_cb_1' })

    const result = await controller.handleWebhook(makeReq(chargebackEvent), sign(chargebackEvent), chargebackEvent)

    expect(result).toEqual({ received: true, skipped: true })
    expect(disputes.createDispute).not.toHaveBeenCalled()
  })

  it('dedup short-circuits on P2002 unique constraint race', async () => {
    prisma.$transaction.mockRejectedValue({ code: 'P2002' })

    const result = await controller.handleWebhook(makeReq(chargebackEvent), sign(chargebackEvent), chargebackEvent)

    expect(result).toEqual({ received: true, skipped: true })
  })

  it('continues when credits deduction fails (insufficient balance)', async () => {
    credits.deductCredits.mockRejectedValue(new Error('Insufficient credits'))

    await controller.handleWebhook(makeReq(chargebackEvent), sign(chargebackEvent), chargebackEvent)

    expect(disputes.createDispute).toHaveBeenCalled()
    expect(ledger.recordTransaction).toHaveBeenCalled()
    expect(prisma.dispute.update).toHaveBeenCalled()
  })
})
