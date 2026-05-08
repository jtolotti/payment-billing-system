import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common'
import { SubscriptionStatus, SubscriptionPlan, PaymentGateway, Prisma } from '@prisma/client'
import { PrismaService } from '../common/prisma.service'

/**
 * SubscriptionsService — subscription lifecycle.
 *
 * Policy: this product does NOT implement retry dunning. A failed charge
 * cancels the subscription and removes access immediately. No grace period,
 * no past_due state dwell, no retry schedule. This is deliberate and every
 * method here encodes it.
 *
 * Lifecycle methods:
 *   - createOrUpdateFromGateway: called by webhook handlers on sub.created/renewed
 *   - cancelAtPeriodEnd: user cancels, keeps access until period end
 *   - cancelImmediately: admin cancels OR failed charge — removes access now
 *   - reactivate: user reverses a cancel-at-period-end
 *
 * NOT provided: retryPayment, enterDunning, applyGracePeriod — these do not
 * exist in this product by design.
 */
@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name)

  constructor(private readonly prisma: PrismaService) {}

  async getForUser(userId: string) {
    return this.prisma.subscription.findUnique({
      where: { userId },
      include: { gatewaySubscription: true },
    })
  }

  /**
   * Upsert a subscription from a gateway event (subscription.created / renewed).
   * Assumes the webhook handler has already verified the event came from
   * the gateway, so this method trusts its inputs.
   */
  async createOrUpdateFromGateway(params: {
    userId: string
    plan: SubscriptionPlan
    gatewayType: PaymentGateway
    gatewaySubscriptionId: string
    gatewayCustomerId: string
    gatewayData?: Record<string, any>
    currentPeriodStart?: Date
    currentPeriodEnd?: Date
    tx?: Prisma.TransactionClient
  }) {
    const client = params.tx || this.prisma

    const periodStart = params.currentPeriodStart ?? new Date()
    const periodEnd =
      params.currentPeriodEnd ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)

    const subscription = await client.subscription.upsert({
      where: { userId: params.userId },
      create: {
        userId: params.userId,
        plan: params.plan,
        status: SubscriptionStatus.ACTIVE,
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
      },
      update: {
        plan: params.plan,
        status: SubscriptionStatus.ACTIVE,
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: false,
        canceledAt: null,
      },
    })

    await client.gatewaySubscription.upsert({
      where: { subscriptionId: subscription.id },
      create: {
        subscriptionId: subscription.id,
        gatewayType: params.gatewayType,
        gatewaySubscriptionId: params.gatewaySubscriptionId,
        gatewayCustomerId: params.gatewayCustomerId,
        gatewayData: (params.gatewayData as Prisma.InputJsonValue) ?? Prisma.JsonNull,
      },
      update: {
        gatewayType: params.gatewayType,
        gatewaySubscriptionId: params.gatewaySubscriptionId,
        gatewayCustomerId: params.gatewayCustomerId,
        gatewayData: (params.gatewayData as Prisma.InputJsonValue) ?? Prisma.JsonNull,
      },
    })

    this.logger.log(
      `Subscription ${subscription.id} active (${params.plan}) via ${params.gatewayType}`
    )
    return subscription
  }

  async cancelAtPeriodEnd(userId: string) {
    const sub = await this.prisma.subscription.findUnique({ where: { userId } })
    if (!sub) throw new NotFoundException('No subscription to cancel')
    if (sub.status === SubscriptionStatus.CANCELED) {
      throw new BadRequestException('Subscription is already canceled')
    }

    return this.prisma.subscription.update({
      where: { userId },
      data: { cancelAtPeriodEnd: true },
    })
  }

  /**
   * Immediate cancellation — used for admin actions and for failed-charge events.
   *
   * This is the no-dunning hot path. When a webhook handler receives a
   * charge-failed or subscription-expired event, it calls this method
   * directly. The user loses access right now.
   */
  async cancelImmediately(
    userId: string,
    reason: string,
    tx?: Prisma.TransactionClient
  ) {
    const client = tx || this.prisma

    const sub = await client.subscription.findUnique({ where: { userId } })
    if (!sub) {
      this.logger.warn(`cancelImmediately called for unknown user ${userId}`)
      return null
    }

    const updated = await client.subscription.update({
      where: { userId },
      data: {
        status: SubscriptionStatus.CANCELED,
        plan: SubscriptionPlan.BASIC,
        canceledAt: new Date(),
        cancelAtPeriodEnd: false,
      },
    })

    this.logger.warn(`Subscription ${sub.id} canceled immediately. Reason: ${reason}`)
    return updated
  }

  async reactivate(userId: string) {
    const sub = await this.prisma.subscription.findUnique({ where: { userId } })
    if (!sub) throw new NotFoundException('No subscription to reactivate')
    if (!sub.cancelAtPeriodEnd) {
      throw new BadRequestException('Subscription is not pending cancellation')
    }
    if (sub.status !== SubscriptionStatus.ACTIVE) {
      throw new BadRequestException('Only active subscriptions can be reactivated')
    }

    return this.prisma.subscription.update({
      where: { userId },
      data: { cancelAtPeriodEnd: false },
    })
  }
}
