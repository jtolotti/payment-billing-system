import { Module } from '@nestjs/common'
import { BillingModule } from '../billing/billing.module'
import { GatewaysModule } from '../gateways/gateways.module'
import { RefundsController } from './refunds.controller'
import { RefundsService } from './refunds.service'

@Module({
  imports: [BillingModule, GatewaysModule],
  controllers: [RefundsController],
  providers: [RefundsService],
  exports: [RefundsService],
})
export class RefundsModule {}
