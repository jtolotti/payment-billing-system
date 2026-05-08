'use client'

import * as React from 'react'
import Link from 'next/link'
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@billing/ui'
import { api } from '@/lib/api-client'

type Subscription = {
  id: string
  status: 'ACTIVE' | 'INACTIVE' | 'CANCELED' | 'TRIALING'
  plan: 'BASIC' | 'STANDARD' | 'PREMIUM'
  currentPeriodStart: string | null
  currentPeriodEnd: string | null
  cancelAtPeriodEnd: boolean
  gatewaySubscription?: {
    gatewayType: 'AUTHORIZE_NET' | 'SOLANA'
  } | null
} | null

type Credits = { userId: string; balance: number }
type CreditHistory = {
  transactions: Array<{
    id: string
    amount: number
    type: string
    description: string | null
    createdAt: string
  }>
  total: number
}

export default function BillingPage() {
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [subscription, setSubscription] = React.useState<Subscription>(null)
  const [credits, setCredits] = React.useState<Credits | null>(null)
  const [history, setHistory] = React.useState<CreditHistory | null>(null)

  const load = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [sub, cr, hi] = await Promise.all([
        api.get<Subscription>('/billing/subscription'),
        api.get<Credits>('/billing/credits'),
        api.get<CreditHistory>('/billing/credits/history'),
      ])
      setSubscription(sub)
      setCredits(cr)
      setHistory(hi)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    load()
  }, [load])

  if (loading) {
    return (
      <main className="mx-auto max-w-4xl px-6 py-12">
        <div className="flex justify-center">
          <Spinner size="lg" />
        </div>
      </main>
    )
  }

  return (
    <main className="mx-auto max-w-4xl px-6 py-12 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Billing</h1>
        <Button asChild variant="tertiary" size="sm">
          <Link href="/">← Home</Link>
        </Button>
      </div>

      {error && (
        <Alert variant="error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {!subscription && !error && (
        <Alert variant="warning">
          <AlertDescription>
            No subscription found. Sign in as <code>test-user-1</code> on the home page.
          </AlertDescription>
        </Alert>
      )}

      {subscription && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Subscription</CardTitle>
                <CardDescription>Current plan and status</CardDescription>
              </div>
              <StatusBadge status={subscription.status} />
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <Row label="Plan">{subscription.plan}</Row>
            <Row label="Status">{subscription.status}</Row>
            {subscription.gatewaySubscription && (
              <Row label="Gateway">
                {subscription.gatewaySubscription.gatewayType === 'AUTHORIZE_NET'
                  ? 'Authorize.Net (card)'
                  : 'Solana (USDC)'}
              </Row>
            )}
            {subscription.currentPeriodEnd && (
              <Row label="Renews">
                {new Date(subscription.currentPeriodEnd).toLocaleDateString()}
              </Row>
            )}
            {subscription.cancelAtPeriodEnd && (
              <Alert variant="warning">
                <AlertDescription>
                  This subscription is scheduled to cancel at period end.
                </AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Credits</CardTitle>
          <CardDescription>Current balance and recent activity</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="mb-4 flex items-baseline gap-2">
            <span className="text-4xl font-bold">{credits?.balance ?? 0}</span>
            <span className="text-neutral-500">credits</span>
          </div>
          {history && history.transactions.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.transactions.map((tx) => (
                  <TableRow key={tx.id}>
                    <TableCell className="text-neutral-500">
                      {new Date(tx.createdAt).toLocaleDateString()}
                    </TableCell>
                    <TableCell>
                      <Badge variant={tx.amount > 0 ? 'success' : 'default'}>
                        {tx.type}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-neutral-700">{tx.description}</TableCell>
                    <TableCell className="text-right font-mono">
                      {tx.amount > 0 ? `+${tx.amount}` : tx.amount}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-neutral-500">No transactions yet.</p>
          )}
        </CardContent>
      </Card>

      <div className="flex gap-2">
        <Button asChild>
          <Link href="/billing/refund-request">Request a refund</Link>
        </Button>
      </div>
    </main>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between border-b border-neutral-100 pb-2 last:border-0">
      <span className="text-neutral-500">{label}</span>
      <span className="font-medium">{children}</span>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const variant =
    status === 'ACTIVE'
      ? 'success'
      : status === 'TRIALING'
        ? 'primary'
        : status === 'CANCELED'
          ? 'destructive'
          : 'default'
  return <Badge variant={variant as any}>{status}</Badge>
}
