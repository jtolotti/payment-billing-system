import { Module } from '@nestjs/common'
import { BillingModule } from '../billing/billing.module'
import { DisputesModule } from '../disputes/disputes.module'
import { AuthorizeNetGateway } from './authorize-net/authorize-net.gateway'
import { AuthorizeNetWebhookController } from './authorize-net/authorize-net-webhook.controller'
import { SolanaGateway } from './solana/solana.gateway'
import { SolanaConfirmationController } from './solana/solana-confirmation.controller'

// Note: the webhook controllers are also registered as providers so the
// SimulatorController can inject them directly and hand off events without
// going through the HTTP layer. This is not idiomatic NestJS but keeps the
// dev-only simulator in-process and synchronous, which makes tests simpler.
@Module({
  imports: [BillingModule, DisputesModule],
  controllers: [AuthorizeNetWebhookController, SolanaConfirmationController],
  providers: [
    AuthorizeNetGateway,
    SolanaGateway,
    AuthorizeNetWebhookController,
    SolanaConfirmationController,
  ],
  exports: [
    AuthorizeNetGateway,
    SolanaGateway,
    AuthorizeNetWebhookController,
    SolanaConfirmationController,
  ],
})
export class GatewaysModule {}
