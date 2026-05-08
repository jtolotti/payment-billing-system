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

type Dispute = {
  id: string
  userId: string
  gateway: 'AUTHORIZE_NET' | 'SOLANA'
  gatewayDisputeId: string
  amount: number
  reason: string | null
  status: 'OPEN' | 'EVIDENCE_SUBMITTED' | 'WON' | 'LOST'
  openedAt: string
  resolvedAt: string | null
  user?: { email: string; name: string | null }
}

/**
 * Admin · Disputes
 *
 * Lists all disputes with status, amount, and links to detail views.
 * Chargebacks are ingested via the AuthorizeNet webhook controller.
 */
export default function AdminDisputesPage() {
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [data, setData] = React.useState<Dispute[]>([])

  const load = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await api.get<{ data: Dispute[] }>('/admin/disputes')
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

  return (
    <main className="mx-auto max-w-6xl px-6 py-12 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Admin · Disputes</h1>
          <p className="text-sm text-neutral-600 mt-1">
            Chargebacks and dispute tracking. Requires admin role.
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
          <CardTitle>Open disputes</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex justify-center py-8">
              <Spinner size="lg" />
            </div>
          ) : data.length === 0 ? (
            <p className="py-8 text-center text-sm text-neutral-500">
              No disputes yet. Fire one with:{' '}
              <code className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs">
                POST /__simulator__/card/chargeback
              </code>
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Gateway</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Opened</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.map((d) => (
                  <TableRow key={d.id} className="cursor-pointer hover:bg-neutral-50">
                    <TableCell>
                      <Link href={`/admin/disputes/${d.id}`} className="block">
                        <div className="font-medium">{d.user?.name || d.user?.email}</div>
                        <div className="text-xs text-neutral-500 font-mono">{d.userId}</div>
                      </Link>
                    </TableCell>
                    <TableCell>{d.gateway}</TableCell>
                    <TableCell className="font-mono">${(d.amount / 100).toFixed(2)}</TableCell>
                    <TableCell>
                      <StatusBadge status={d.status} />
                    </TableCell>
                    <TableCell className="text-sm text-neutral-500">
                      {new Date(d.openedAt).toLocaleDateString()}
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
    status === 'WON'
      ? 'success'
      : status === 'LOST'
        ? 'destructive'
        : status === 'EVIDENCE_SUBMITTED'
          ? 'primary'
          : 'warning'
  return <Badge variant={variant as any}>{status}</Badge>
}
