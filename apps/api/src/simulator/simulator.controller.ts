import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Headers,
  OnModuleInit,
  Post,
  Req,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Request } from 'express'
import { IsEnum, IsInt, IsOptional, IsString, Min } from 'class-validator'
import { SubscriptionPlan } from '@prisma/client'
import { AuthorizeNetWebhookController } from '../gateways/authorize-net/authorize-net-webhook.controller'
import { SolanaConfirmationController } from '../gateways/solana/solana-confirmation.controller'
import { SimulatorService } from './simulator.service'

class SimulateCardRebillBody {
  @IsString()
  userId!: string

  @IsEnum(SubscriptionPlan)
  plan!: SubscriptionPlan

  @IsInt()
  @Min(1)
  amountCents!: number
}

class SimulateChargebackBody {
  @IsString()
  userId!: string

  @IsString()
  originalTransactionId!: string

  @IsInt()
  @Min(1)
  amountCents!: number

  @IsOptional()
  @IsString()
  reason?: string
}

class SimulateChargeFailureBody {
  @IsString()
  userId!: string

  @IsOptional()
  @IsString()
  reason?: string
}

class SimulateSolanaConfirmationBody {
  @IsString()
  userId!: string

  @IsInt()
  @Min(1)
  amount!: number

  @IsInt()
  @Min(0)
  confirmations!: number

  @IsOptional()
  @IsString()
  txHash?: string

  @IsOptional()
  @IsEnum(SubscriptionPlan)
  plan?: SubscriptionPlan

  @IsOptional()
  @IsString()
  reference?: string
}

/**
 * SimulatorController — dev/test only.
 *
 * Each endpoint builds a signed (for the card side) or unsigned (for the
 * Solana side) event and delivers it directly into the appropriate webhook
 * controller, so the end-to-end flow runs just as it would in production.
 *
 * To test idempotency, simply call the same endpoint twice — the webhook
 * controllers dedup by event id / tx hash.
 *
 * Disabled in production via the SIMULATOR_ENABLED env var.
 */
@Controller('__simulator__')
export class SimulatorController implements OnModuleInit {
  constructor(
    private readonly config: ConfigService,
    private readonly simulator: SimulatorService,
    private readonly authorizeNetWebhook: AuthorizeNetWebhookController,
    private readonly solanaConfirmation: SolanaConfirmationController
  ) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'production') {
      // Defensive: fail loud if someone accidentally boots this in prod.
      // (In a real app we'd use conditional module registration instead.)
    }
  }

  private assertEnabled() {
    const enabled = this.config.get<string>('SIMULATOR_ENABLED') !== 'false'
    if (process.env.NODE_ENV === 'production' || !enabled) {
      throw new ForbiddenException('Simulator is disabled in this environment')
    }
  }

  // ------- Card (AuthorizeNet) simulators -------

  @Post('card/rebill')
  async simulateCardRebill(@Body() body: SimulateCardRebillBody, @Req() req: Request) {
    this.assertEnabled()
    const result = await this.simulator.simulateCardRebill(body)
    // Deliver the webhook into the controller
    await this.deliverAuthorizeNet(req, result.webhook)
    return {
      status: 'delivered',
      transactionId: result.transactionId,
      gatewaySubscriptionId: result.gatewaySubscriptionId,
      gatewayCustomerId: result.gatewayCustomerId,
    }
  }

  @Post('card/rebill/duplicate')
  async simulateCardRebillDuplicate(@Body() body: SimulateCardRebillBody, @Req() req: Request) {
    // Fires the same rebill event twice to test idempotency.
    this.assertEnabled()
    const result = await this.simulator.simulateCardRebill(body)
    await this.deliverAuthorizeNet(req, result.webhook)
    await this.deliverAuthorizeNet(req, result.webhook) // <- duplicate
    return { status: 'delivered_twice', transactionId: result.transactionId }
  }

  @Post('card/chargeback')
  async simulateChargeback(@Body() body: SimulateChargebackBody, @Req() req: Request) {
    this.assertEnabled()
    const { eventId, webhook } = await this.simulator.simulateChargeback(body)
    await this.deliverAuthorizeNet(req, webhook)
    return { status: 'delivered', eventId }
  }

  @Post('card/charge-failure')
  async simulateChargeFailure(
    @Body() body: SimulateChargeFailureBody,
    @Req() req: Request
  ) {
    this.assertEnabled()
    const { webhook } = await this.simulator.simulateChargeFailure(body)
    await this.deliverAuthorizeNet(req, webhook)
    return { status: 'delivered' }
  }

  // ------- Solana simulators -------

  @Post('solana/confirmation')
  async simulateSolanaConfirmation(@Body() body: SimulateSolanaConfirmationBody) {
    this.assertEnabled()
    const { txHash, event } = this.simulator.simulateSolanaConfirmation(body)
    await this.solanaConfirmation.handleConfirmation(event as any)
    return { status: 'delivered', txHash, confirmations: body.confirmations }
  }

  // ------- Reset -------

  @Post('reset')
  async reset(@Body() body: { userId: string }) {
    this.assertEnabled()
    if (!body?.userId) throw new BadRequestException('userId is required')
    return this.simulator.resetUser(body.userId)
  }

  // ------- helpers -------

  private async deliverAuthorizeNet(
    req: Request,
    webhook: { body: string; signature: string }
  ) {
    const parsed = JSON.parse(webhook.body)
    // Spoof rawBody onto the request object so the controller sees the
    // exact bytes we signed.
    const fakeReq = {
      rawBody: Buffer.from(webhook.body),
    } as any
    await this.authorizeNetWebhook.handleWebhook(fakeReq, webhook.signature, parsed)
  }
}
