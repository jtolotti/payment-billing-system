import { Injectable, NestMiddleware, UnauthorizedException } from '@nestjs/common'
import { Request, Response, NextFunction } from 'express'
import { PrismaService } from './prisma.service'

/**
 * Header-based authentication stub. Reads `x-user-id` off the request
 * and resolves it to a real user row. Zero security — for local development only.
 *
 * See IMPLEMENTATION_PLAN.md: JWT migration is planned as P1 improvement.
 *
 * Public routes (like webhooks and simulator endpoints) skip this by not
 * requiring `req.user` downstream.
 */
@Injectable()
export class FakeAuthMiddleware implements NestMiddleware {
  constructor(private prisma: PrismaService) {}

  async use(req: Request & { user?: any }, _res: Response, next: NextFunction) {
    const userId = req.headers['x-user-id']

    if (!userId || Array.isArray(userId)) {
      // No auth header — leave req.user undefined. Protected routes check themselves.
      return next()
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    })

    if (!user) {
      throw new UnauthorizedException(`Unknown user id: ${userId}`)
    }

    req.user = user
    next()
  }
}
