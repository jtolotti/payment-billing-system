import { IsEnum, IsInt, IsString, Min } from 'class-validator'
import { LedgerEntryType, LedgerTransactionStatus } from '@prisma/client'

export class LedgerEntryInput {
  @IsString()
  accountId!: string

  @IsEnum(LedgerEntryType)
  entryType!: LedgerEntryType

  @IsInt()
  @Min(1)
  amount!: number
}

export interface LedgerEntryResponse {
  id: string
  ledgerTransactionId: string
  accountId: string
  entryType: LedgerEntryType
  amount: number
  createdAt: Date
}

export interface TransactionResponse {
  id: string
  transactionId: string
  userId: string | null
  description: string
  status: LedgerTransactionStatus
  metadata: object | null
  entries: LedgerEntryResponse[]
  createdAt: Date
  updatedAt: Date
}

export interface BalanceResponse {
  userId: string
  balance: number
  accountId: string | null
  updatedAt: Date
}
