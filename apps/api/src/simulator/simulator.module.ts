import { Module } from '@nestjs/common'
import { BillingModule } from '../billing/billing.module'
import { GatewaysModule } from '../gateways/gateways.module'
import { DisputesModule } from '../disputes/disputes.module'
import { SimulatorController } from './simulator.controller'
import { SimulatorService } from './simulator.service'

@Module({
  imports: [BillingModule, GatewaysModule, DisputesModule],
  controllers: [SimulatorController],
  providers: [SimulatorService],
})
export class SimulatorModule {}
