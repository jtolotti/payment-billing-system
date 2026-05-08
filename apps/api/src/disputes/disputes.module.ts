import { Module } from '@nestjs/common'
import { BillingModule } from '../billing/billing.module'
import { DisputesController } from './disputes.controller'
import { DisputesService } from './disputes.service'

@Module({
  imports: [BillingModule],
  controllers: [DisputesController],
  providers: [DisputesService],
  exports: [DisputesService],
})
export class DisputesModule {}
