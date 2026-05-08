'use client'

import * as React from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  Spinner,
  Textarea,
} from '@billing/ui'
import { api } from '@/lib/api-client'

type Evidence = {
  id: string
  submittedBy: string
  evidenceType: string
  content: string
  submittedAt: string
}

type Dispute = {
  id: string
  userId: string
  gateway: 'AUTHORIZE_NET' | 'SOLANA'
  gatewayDisputeId: string
  originalTransactionId: string
  amount: number
  reason: string | null
  status: 'OPEN' | 'EVIDENCE_SUBMITTED' | 'WON' | 'LOST'
  openedAt: string
  resolvedAt: string | null
  ledgerReversalTxnId: string | null
  user?: { id: string; email: string; name: string | null }
  evidence: Evidence[]
}

export default function DisputeDetailPage() {
  const { id } = useParams<{ id: string }>()
  const [dispute, setDispute] = React.useState<Dispute | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [acting, setActing] = React.useState(false)

  // Evidence form state
  const [evidenceType, setEvidenceType] = React.useState('access_log')
  const [evidenceContent, setEvidenceContent] = React.useState('')

  const load = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await api.get<Dispute>(`/admin/disputes/${id}`)
      setDispute(res)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [id])

  React.useEffect(() => {
    load()
  }, [load])

  async function submitEvidence() {
    if (!evidenceContent.trim() || evidenceContent.length < 10) return
    setActing(true)
    setError(null)
    try {
      await api.post(`/admin/disputes/${id}/evidence`, {
        evidenceType,
        content: evidenceContent,
      })
      setEvidenceContent('')
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setActing(false)
    }
  }

  async function setOutcome(outcome: 'WON' | 'LOST') {
    setActing(true)
    setError(null)
    try {
      await api.post(`/admin/disputes/${id}/outcome`, { outcome })
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setActing(false)
    }
  }

  const isResolved = dispute?.status === 'WON' || dispute?.status === 'LOST'

  return (
    <main className="mx-auto max-w-4xl px-6 py-12 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Dispute Detail</h1>
          <p className="text-sm text-neutral-500 font-mono mt-1">{id}</p>
        </div>
        <Button asChild variant="tertiary" size="sm">
          <Link href="/admin/disputes">← All Disputes</Link>
        </Button>
      </div>

      {error && (
        <Alert variant="error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {loading ? (
        <div className="flex justify-center py-12">
          <Spinner size="lg" />
        </div>
      ) : !dispute ? (
        <Alert variant="error">
          <AlertDescription>Dispute not found.</AlertDescription>
        </Alert>
      ) : (
        <>
          {/* Dispute overview */}
          <Card>
            <CardHeader>
              <CardTitle>Overview</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-2 gap-x-8 gap-y-4 text-sm">
                <div>
                  <dt className="text-neutral-500">Status</dt>
                  <dd className="mt-1"><StatusBadge status={dispute.status} /></dd>
                </div>
                <div>
                  <dt className="text-neutral-500">Amount</dt>
                  <dd className="mt-1 font-mono font-medium">${(dispute.amount / 100).toFixed(2)}</dd>
                </div>
                <div>
                  <dt className="text-neutral-500">User</dt>
                  <dd className="mt-1">
                    <span className="font-medium">{dispute.user?.name || dispute.user?.email}</span>
                    <span className="text-neutral-500 font-mono text-xs ml-2">{dispute.userId}</span>
                  </dd>
                </div>
                <div>
                  <dt className="text-neutral-500">Gateway</dt>
                  <dd className="mt-1">{dispute.gateway}</dd>
                </div>
                <div>
                  <dt className="text-neutral-500">Original Transaction</dt>
                  <dd className="mt-1 font-mono text-xs">{dispute.originalTransactionId}</dd>
                </div>
                <div>
                  <dt className="text-neutral-500">Gateway Dispute ID</dt>
                  <dd className="mt-1 font-mono text-xs">{dispute.gatewayDisputeId}</dd>
                </div>
                <div>
                  <dt className="text-neutral-500">Opened</dt>
                  <dd className="mt-1">{new Date(dispute.openedAt).toLocaleString()}</dd>
                </div>
                <div>
                  <dt className="text-neutral-500">Resolved</dt>
                  <dd className="mt-1">{dispute.resolvedAt ? new Date(dispute.resolvedAt).toLocaleString() : '—'}</dd>
                </div>
                {dispute.ledgerReversalTxnId && (
                  <div className="col-span-2">
                    <dt className="text-neutral-500">Ledger Reversal Txn</dt>
                    <dd className="mt-1 font-mono text-xs">{dispute.ledgerReversalTxnId}</dd>
                  </div>
                )}
                {dispute.reason && (
                  <div className="col-span-2">
                    <dt className="text-neutral-500">Reason</dt>
                    <dd className="mt-1">{dispute.reason}</dd>
                  </div>
                )}
              </dl>
            </CardContent>
          </Card>

          {/* Evidence section */}
          <Card>
            <CardHeader>
              <CardTitle>Evidence</CardTitle>
              <CardDescription>
                {dispute.evidence.length} item{dispute.evidence.length !== 1 ? 's' : ''} submitted
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {dispute.evidence.length === 0 ? (
                <p className="text-sm text-neutral-500 py-2">No evidence submitted yet.</p>
              ) : (
                <div className="space-y-3">
                  {dispute.evidence.map((ev) => (
                    <div key={ev.id} className="border rounded-lg p-3 text-sm">
                      <div className="flex items-center gap-2 mb-2">
                        <Badge variant="default">{ev.evidenceType}</Badge>
                        <span className="text-xs text-neutral-500">
                          {new Date(ev.submittedAt).toLocaleString()}
                        </span>
                        <span className="text-xs text-neutral-400 font-mono">by {ev.submittedBy}</span>
                      </div>
                      <p className="whitespace-pre-wrap text-neutral-700">{ev.content}</p>
                    </div>
                  ))}
                </div>
              )}

              {!isResolved && (
                <div className="border-t pt-4 space-y-3">
                  <p className="text-sm font-medium">Submit evidence</p>
                  <div className="flex gap-3">
                    <Select value={evidenceType} onValueChange={setEvidenceType}>
                      <SelectTrigger className="w-48">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="access_log">Access Log</SelectItem>
                        <SelectItem value="communications">Communications</SelectItem>
                        <SelectItem value="terms_accepted">Terms Accepted</SelectItem>
                        <SelectItem value="other">Other</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <Textarea
                    placeholder="Evidence content (min 10 characters)..."
                    value={evidenceContent}
                    onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setEvidenceContent(e.target.value)}
                    rows={3}
                  />
                  <Button
                    size="sm"
                    onClick={submitEvidence}
                    loading={acting}
                    disabled={evidenceContent.length < 10}
                  >
                    Submit Evidence
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Outcome actions */}
          {!isResolved && (
            <Card>
              <CardHeader>
                <CardTitle>Resolve Dispute</CardTitle>
                <CardDescription>
                  Mark the dispute outcome. WON reverses the ledger entry and restores credits.
                  LOST records a $15 chargeback fee.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex gap-3">
                <Button
                  variant="primary"
                  onClick={() => setOutcome('WON')}
                  loading={acting}
                >
                  Mark as WON
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => setOutcome('LOST')}
                  loading={acting}
                >
                  Mark as LOST
                </Button>
              </CardContent>
            </Card>
          )}
        </>
      )}
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
