'use client'

import * as React from 'react'
import Link from 'next/link'
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Form,
  FormDescription,
  FormError,
  FormField,
  FormLabel,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@billing/ui'
import { api } from '@/lib/api-client'

type RefundType = 'CREDITS' | 'PAYMENT'
type GatewayType = 'AUTHORIZE_NET' | 'SOLANA'

export default function RefundRequestPage() {
  const [type, setType] = React.useState<RefundType>('CREDITS')
  const [gatewayType, setGatewayType] = React.useState<GatewayType>('AUTHORIZE_NET')
  const [transactionId, setTransactionId] = React.useState('')
  const [amount, setAmount] = React.useState('')
  const [reason, setReason] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [submitted, setSubmitted] = React.useState(false)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const body: Record<string, unknown> = {
        type,
        amount: parseInt(amount, 10),
        reason,
      }
      if (type === 'PAYMENT') {
        body.gatewayType = gatewayType
        body.originalGatewayTransactionId = transactionId
      }

      await api.post('/refunds', body)
      setSubmitted(true)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  if (submitted) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-12 space-y-4">
        <Alert variant="success">
          <AlertTitle>Refund request submitted</AlertTitle>
          <AlertDescription>
            An administrator will review your request. You'll be notified when it's
            processed.
          </AlertDescription>
        </Alert>
        <div className="flex gap-2">
          <Button asChild variant="secondary">
            <Link href="/billing">Back to billing</Link>
          </Button>
          <Button
            variant="tertiary"
            onClick={() => {
              setSubmitted(false)
              setAmount('')
              setReason('')
            }}
          >
            Submit another
          </Button>
        </div>
      </main>
    )
  }

  return (
    <main className="mx-auto max-w-2xl px-6 py-12 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Request a refund</h1>
        <Button asChild variant="tertiary" size="sm">
          <Link href="/billing">← Billing</Link>
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>New refund request</CardTitle>
          <CardDescription>
            Requests are reviewed by an administrator before processing.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Form onSubmit={onSubmit}>
            <FormField>
              <FormLabel htmlFor="type">Refund type</FormLabel>
              <Select value={type} onValueChange={(v) => setType(v as RefundType)}>
                <SelectTrigger id="type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="CREDITS">Credits (refund to credit balance)</SelectItem>
                  <SelectItem value="PAYMENT">
                    Payment (refund to original gateway)
                  </SelectItem>
                </SelectContent>
              </Select>
              <FormDescription>
                Credits refunds return credits to your balance. Payment refunds return money
                to the original payment method.
              </FormDescription>
            </FormField>

            {type === 'PAYMENT' && (
              <>
                <FormField>
                  <FormLabel htmlFor="gateway">Gateway</FormLabel>
                  <Select
                    value={gatewayType}
                    onValueChange={(v) => setGatewayType(v as GatewayType)}
                  >
                    <SelectTrigger id="gateway">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="AUTHORIZE_NET">Authorize.Net (card)</SelectItem>
                      <SelectItem value="SOLANA">Solana (USDC)</SelectItem>
                    </SelectContent>
                  </Select>
                </FormField>
                <FormField>
                  <FormLabel htmlFor="transactionId">Original Transaction ID</FormLabel>
                  <Input
                    id="transactionId"
                    value={transactionId}
                    onChange={(e) => setTransactionId(e.target.value)}
                    required
                    placeholder="e.g. an_txn_abc123"
                  />
                  <FormDescription>
                    The gateway transaction ID from the original charge to refund.
                  </FormDescription>
                </FormField>
              </>
            )}

            <FormField>
              <FormLabel htmlFor="amount">
                Amount ({type === 'CREDITS' ? 'credits' : 'cents'})
              </FormLabel>
              <Input
                id="amount"
                type="number"
                min={1}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                required
              />
            </FormField>

            <FormField>
              <FormLabel htmlFor="reason">Reason</FormLabel>
              <Textarea
                id="reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={4}
                required
                minLength={5}
                placeholder="Explain why you're requesting this refund..."
              />
            </FormField>

            {error && <FormError>{error}</FormError>}

            <Button type="submit" loading={submitting} fullWidth>
              Submit refund request
            </Button>
          </Form>
        </CardContent>
        <CardFooter>
          <p className="text-xs text-neutral-500">
            Payment refunds are processed through the original gateway. Credit refunds
            are applied directly to your balance. Both are reviewed by an admin before processing.
          </p>
        </CardFooter>
      </Card>
    </main>
  )
}
