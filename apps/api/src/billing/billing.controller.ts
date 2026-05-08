import { Controller, Get, Post, Delete } from '@nestjs/common'
import { User } from '@prisma/client'
import { CurrentUser } from '../common/current-user.decorator'
import { SubscriptionsService } from './subscriptions.service'
import { CreditsService } from './credits.service'
import { LedgerService } from './ledger.service'
import { PlansService } from './plans.service'

@Controller('billing')
export class BillingController {
  constructor(
    private readonly subscriptions: SubscriptionsService,
    private readonly credits: CreditsService,
    private readonly ledger: LedgerService,
    private readonly plans: PlansService
  ) {}

  @Get('plans')
  async listPlans() {
    return this.plans.list()
  }

  @Get('subscription')
  async getSubscription(@CurrentUser() user: User) {
    return this.subscriptions.getForUser(user.id)
  }

  @Post('subscription/cancel-at-period-end')
  async cancelAtPeriodEnd(@CurrentUser() user: User) {
    return this.subscriptions.cancelAtPeriodEnd(user.id)
  }

  @Post('subscription/reactivate')
  async reactivate(@CurrentUser() user: User) {
    return this.subscriptions.reactivate(user.id)
  }

  @Delete('subscription')
  async cancelImmediately(@CurrentUser() user: User) {
    return this.subscriptions.cancelImmediately(user.id, 'User requested immediate cancellation')
  }

  @Get('credits')
  async getCredits(@CurrentUser() user: User) {
    const balance = await this.credits.getBalance(user.id)
    return { userId: user.id, balance }
  }

  @Get('credits/history')
  async creditHistory(@CurrentUser() user: User) {
    return this.credits.getTransactionHistory(user.id)
  }

  @Get('ledger/balance')
  async ledgerBalance(@CurrentUser() user: User) {
    return this.ledger.getBalance(user.id)
  }

  @Get('ledger/history')
  async ledgerHistory(@CurrentUser() user: User) {
    return this.ledger.getTransactionHistory(user.id)
  }
}
