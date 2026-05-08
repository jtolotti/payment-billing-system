import { createParamDecorator, ExecutionContext, UnauthorizedException } from '@nestjs/common'
import { User } from '@prisma/client'

/**
 * Extracts the authenticated user (populated by FakeAuthMiddleware) off the request.
 * Throws if the route requires auth and no user is present.
 */
export const CurrentUser = createParamDecorator(
  (options: { optional?: boolean } = {}, ctx: ExecutionContext): User | null => {
    const req = ctx.switchToHttp().getRequest()
    const user = req.user as User | undefined

    if (!user) {
      if (options.optional) return null
      throw new UnauthorizedException('Authentication required — set the x-user-id header')
    }

    return user
  }
)

/**
 * Like CurrentUser but throws if the user is not an admin.
 */
export const AdminUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): User => {
    const req = ctx.switchToHttp().getRequest()
    const user = req.user as User | undefined

    if (!user) {
      throw new UnauthorizedException('Authentication required')
    }
    if (user.role !== 'ADMIN') {
      throw new UnauthorizedException('Admin role required')
    }

    return user
  }
)
