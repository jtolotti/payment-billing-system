import { Injectable, Logger } from '@nestjs/common'
import { PrismaService } from '../common/prisma.service'

/**
 * BillingConfigService — reads runtime-configurable billing parameters
 * from the `billing_config` table instead of compile-time constants.
 *
 * This allows chargeback fees, plan prices, and other billing parameters
 * to be updated without a code deploy. Values are seeded in prisma/seed.ts
 * and can be updated directly in the DB by ops.
 *
 * See IMPLEMENTATION_PLAN.md #5 for context.
 */
@Injectable()
export class BillingConfigService {
  private readonly logger = new Logger(BillingConfigService.name)

  constructor(private readonly prisma: PrismaService) {}

  async get(key: string, defaultValue: string): Promise<string> {
    const row = await this.prisma.billingConfig.findUnique({ where: { key } })
    if (!row) {
      this.logger.warn(`BillingConfig key "${key}" not found, using default: ${defaultValue}`)
      return defaultValue
    }
    return row.value
  }

  async getInt(key: string, defaultValue: number): Promise<number> {
    const raw = await this.get(key, String(defaultValue))
    const parsed = parseInt(raw, 10)
    if (isNaN(parsed)) {
      this.logger.warn(`BillingConfig key "${key}" value "${raw}" is not a valid integer, using default: ${defaultValue}`)
      return defaultValue
    }
    return parsed
  }
}
