import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { PrismaModule } from './common/prisma.module'
import { FakeAuthMiddleware } from './common/fake-auth.middleware'
import { BillingModule } from './billing/billing.module'
import { GatewaysModule } from './gateways/gateways.module'
import { RefundsModule } from './refunds/refunds.module'
import { DisputesModule } from './disputes/disputes.module'
import { SimulatorModule } from './simulator/simulator.module'

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    BillingModule,
    GatewaysModule,
    RefundsModule,
    DisputesModule,
    SimulatorModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Header-based auth stub — any request with `x-user-id: <id>` is treated as that user.
    // See IMPLEMENTATION_PLAN.md for planned JWT migration.
    consumer.apply(FakeAuthMiddleware).forRoutes('*')
  }
}
