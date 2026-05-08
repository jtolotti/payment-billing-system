import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common'
import { IsIn, IsOptional, IsString, MinLength } from 'class-validator'
import { DisputeStatus, User } from '@prisma/client'
import { AdminUser } from '../common/current-user.decorator'
import { DisputesService } from './disputes.service'

class AttachEvidenceBody {
  @IsString()
  @IsIn(['access_log', 'communications', 'terms_accepted', 'other'])
  evidenceType!: string

  @IsString()
  @MinLength(10)
  content!: string
}

class SetOutcomeBody {
  @IsString()
  @IsIn(['WON', 'LOST'])
  outcome!: 'WON' | 'LOST'
}

@Controller('admin/disputes')
export class DisputesController {
  constructor(private readonly disputes: DisputesService) {}

  @Get()
  async list(@AdminUser() _admin: User, @Query('status') status?: DisputeStatus) {
    return this.disputes.listAll({ status })
  }

  @Get(':id')
  async get(@AdminUser() _admin: User, @Param('id') id: string) {
    return this.disputes.get(id)
  }

  @Post(':id/evidence')
  async attach(
    @AdminUser() admin: User,
    @Param('id') id: string,
    @Body() body: AttachEvidenceBody
  ) {
    return this.disputes.attachEvidence({
      disputeId: id,
      submittedBy: admin.id,
      evidenceType: body.evidenceType,
      content: body.content,
    })
  }

  @Post(':id/outcome')
  async setOutcome(
    @AdminUser() _admin: User,
    @Param('id') id: string,
    @Body() body: SetOutcomeBody
  ) {
    return this.disputes.setOutcome(id, body.outcome)
  }
}
