import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  BadRequestException,
} from '@nestjs/common'
import { IsEnum, IsInt, IsOptional, IsString, Min, MinLength } from 'class-validator'
import { PaymentGateway, RefundStatus, RefundType, User } from '@prisma/client'
import { CurrentUser, AdminUser } from '../common/current-user.decorator'
import { RefundsService } from './refunds.service'

class CreateRefundRequestBody {
  @IsEnum(RefundType)
  type!: RefundType

  @IsInt()
  @Min(1)
  amount!: number

  @IsString()
  @MinLength(5)
  reason!: string

  @IsOptional()
  @IsEnum(PaymentGateway)
  gatewayType?: PaymentGateway

  @IsOptional()
  @IsString()
  originalGatewayTransactionId?: string
}

class ReviewNotesBody {
  @IsOptional()
  @IsString()
  notes?: string
}

class DenyRefundBody {
  @IsString()
  @MinLength(5)
  notes!: string
}

@Controller('refunds')
export class RefundsController {
  constructor(private readonly refunds: RefundsService) {}

  // ------- user routes -------

  @Post()
  async create(@CurrentUser() user: User, @Body() body: CreateRefundRequestBody) {
    return this.refunds.createRefundRequest(user.id, body)
  }

  @Get('mine')
  async listMine(@CurrentUser() user: User) {
    return this.refunds.listMine(user.id)
  }

  // ------- admin routes -------

  @Get('admin')
  async listAll(@AdminUser() _admin: User, @Query('status') status?: string) {
    const parsedStatus = status as RefundStatus | undefined
    if (status && !Object.values(RefundStatus).includes(parsedStatus!)) {
      throw new BadRequestException(`Invalid status: ${status}`)
    }
    return this.refunds.listAll({ status: parsedStatus })
  }

  @Get('admin/:id')
  async get(@AdminUser() _admin: User, @Param('id') id: string) {
    return this.refunds.get(id)
  }

  @Post('admin/:id/approve')
  async approve(
    @AdminUser() admin: User,
    @Param('id') id: string,
    @Body() body: ReviewNotesBody
  ) {
    return this.refunds.approveRefund(id, admin.id, body.notes)
  }

  @Post('admin/:id/deny')
  async deny(
    @AdminUser() admin: User,
    @Param('id') id: string,
    @Body() body: DenyRefundBody
  ) {
    return this.refunds.denyRefund(id, admin.id, body.notes)
  }

  @Post('admin/:id/process')
  async process(@AdminUser() _admin: User, @Param('id') id: string) {
    return this.refunds.processRefund(id)
  }
}
