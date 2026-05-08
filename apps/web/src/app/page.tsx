'use client'

import * as React from 'react'
import Link from 'next/link'
import {
  Button,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  Alert,
  AlertTitle,
  AlertDescription,
} from '@billing/ui'
import { setUserId, clearUserId } from '@/lib/api-client'

/**
 * Landing page + dev user switcher.
 *
 * This page lets you pick which seeded user to impersonate. Your choice
 * is persisted in localStorage and sent as `x-user-id` on every API call.
 *
 * Note: auth is currently a header-based stub. See IMPLEMENTATION_PLAN.md for
 * the planned JWT migration.
 */
export default function HomePage() {
  const [activeUser, setActiveUser] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (typeof window !== 'undefined') {
      setActiveUser(window.localStorage.getItem('x-user-id'))
    }
  }, [])

  function switchUser(userId: string) {
    setUserId(userId)
    setActiveUser(userId)
  }

  function signOut() {
    clearUserId()
    setActiveUser(null)
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-12 space-y-6">
      <header className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight">Payment & Billing System</h1>
        <p className="text-neutral-600">
          Production-grade billing stack with double-entry ledger, chargeback handling, and
          multi-gateway support. See{' '}
          <code className="rounded bg-neutral-100 px-1.5 py-0.5 text-sm">README.md</code> for
          full documentation.
        </p>
      </header>

      <Alert variant="warning">
        <AlertTitle>Dev environment</AlertTitle>
        <AlertDescription>
          Authentication is a header stub — pick a seeded user below to impersonate. See
          IMPLEMENTATION_PLAN.md for the planned JWT migration.
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle>Dev user switcher</CardTitle>
          <CardDescription>
            {activeUser ? (
              <>
                Currently signed in as <code className="font-mono">{activeUser}</code>
              </>
            ) : (
              'Not signed in'
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Button
            variant={activeUser === 'test-user-1' ? 'primary' : 'outline'}
            onClick={() => switchUser('test-user-1')}
            fullWidth
          >
            test-user-1 · regular user (STANDARD plan, 1,000 credits)
          </Button>
          <Button
            variant={activeUser === 'test-admin-1' ? 'primary' : 'outline'}
            onClick={() => switchUser('test-admin-1')}
            fullWidth
          >
            test-admin-1 · admin
          </Button>
          {activeUser && (
            <Button variant="tertiary" onClick={signOut} fullWidth>
              Sign out
            </Button>
          )}
        </CardContent>
        <CardFooter className="flex flex-wrap gap-2">
          <Button asChild variant="secondary">
            <Link href="/billing">Billing</Link>
          </Button>
          <Button asChild variant="secondary">
            <Link href="/billing/refund-request">Request refund</Link>
          </Button>
          <Button asChild variant="secondary">
            <Link href="/admin/disputes">Admin: disputes</Link>
          </Button>
          <Button asChild variant="secondary">
            <Link href="/admin/refunds">Admin: refunds</Link>
          </Button>
        </CardFooter>
      </Card>
    </main>
  )
}
