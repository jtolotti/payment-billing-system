import { Injectable, NotFoundException } from '@nestjs/common'
import { SubscriptionPlan } from '@prisma/client'
import { PrismaService } from '../common/prisma.service'

@Injectable()
export class PlansService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    return this.prisma.plan.findMany({ orderBy: { priceCents: 'asc' } })
  }

  async get(key: SubscriptionPlan) {
    const plan = await this.prisma.plan.findUnique({ where: { key } })
    if (!plan) throw new NotFoundException(`Unknown plan: ${key}`)
    return plan
  }
}
