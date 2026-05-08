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

type RefundRequest = {
  id: string
  userId: string
  type: 'CREDITS' | 'PAYMENT'
  amount: number
  reason: string
  status: 'PENDING' | 'APPROVED' | 'DENIED' | 'PROCESSED'
  gatewayType?: 'AUTHORIZE_NET' | 'SOLANA' | null
  paymentRefundId?: string | null
  originalGatewayTransactionId?: string | null
  processAttempts?: number
  lastProcessError?: string | null
  createdAt: string
  user?: { email: string; name: string | null }
}

export default function AdminRefundsPage() {
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [data, setData] = React.useState<RefundRequest[]>([])
  const [acting, setActing] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await api.get<{ data: RefundRequest[] }>('/refunds/admin')
      setData(res.data)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    load()
  }, [load])

  async function approve(id: string) {
    setActing(id)
    try {
      await api.post(`/refunds/admin/${id}/approve`, { notes: 'Approved via admin UI' })
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setActing(null)
    }
  }

  async function process(id: string) {
    setActing(id)
    try {
      await api.post(`/refunds/admin/${id}/process`)
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setActing(null)
    }
  }

  return (
    <main className="mx-auto max-w-6xl px-6 py-12 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Admin · Refunds</h1>
          <p className="text-sm text-neutral-600 mt-1">
            Review, approve, and process refund requests. Requires admin role.
          </p>
        </div>
        <Button asChild variant="tertiary" size="sm">
          <Link href="/">← Home</Link>
        </Button>
      </div>

      {error && (
        <Alert variant="error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>All refund requests</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex justify-center py-8">
              <Spinner size="lg" />
            </div>
          ) : data.length === 0 ? (
            <p className="py-8 text-center text-sm text-neutral-500">
              No refund requests yet. Sign in as <code>test-user-1</code> and submit one to
              see it here.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>
                      <div className="font-medium">{r.user?.name || r.user?.email}</div>
                      <div className="text-xs text-neutral-500 font-mono">{r.userId}</div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={r.type === 'CREDITS' ? 'primary' : 'warning'}>
                        {r.type}
                      </Badge>
                      {r.gatewayType && (
                        <div className="text-xs text-neutral-500 mt-1">{r.gatewayType}</div>
                      )}
                    </TableCell>
                    <TableCell className="font-mono">{r.amount}</TableCell>
                    <TableCell className="max-w-xs truncate text-sm text-neutral-600">
                      {r.reason}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={r.status} />
                      {r.paymentRefundId && (
                        <div className="text-xs text-neutral-500 mt-1 font-mono truncate max-w-[160px]" title={r.paymentRefundId}>
                          Refund: {r.paymentRefundId}
                        </div>
                      )}
                      {r.lastProcessError && r.status === 'APPROVED' && (
                        <div className="mt-1 space-y-0.5">
                          <div className="text-xs text-red-600 truncate max-w-[200px]" title={r.lastProcessError}>
                            Error: {r.lastProcessError}
                          </div>
                          <div className="text-xs text-neutral-400">
                            Attempts: {r.processAttempts}
                          </div>
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {r.status === 'PENDING' && (
                        <Button
                          size="sm"
                          onClick={() => approve(r.id)}
                          loading={acting === r.id}
                        >
                          Approve
                        </Button>
                      )}
                      {r.status === 'APPROVED' && (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => process(r.id)}
                          loading={acting === r.id}
                        >
                          Process
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </main>
  )
}

function StatusBadge({ status }: { status: string }) {
  const variant =
    status === 'PROCESSED'
      ? 'success'
      : status === 'APPROVED'
        ? 'primary'
        : status === 'DENIED'
          ? 'destructive'
          : 'default'
  return <Badge variant={variant as any}>{status}</Badge>
}
