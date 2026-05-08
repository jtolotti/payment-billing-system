import { Module } from '@nestjs/common'
import { LedgerService } from './ledger.service'
import { CreditsService } from './credits.service'
import { SubscriptionsService } from './subscriptions.service'
import { PlansService } from './plans.service'
import { BillingConfigService } from './billing-config.service'
import { BillingController } from './billing.controller'

@Module({
  controllers: [BillingController],
  providers: [LedgerService, CreditsService, SubscriptionsService, PlansService, BillingConfigService],
  exports: [LedgerService, CreditsService, SubscriptionsService, PlansService, BillingConfigService],
})
export class BillingModule {}
