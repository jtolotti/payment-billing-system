import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Payment & Billing System',
  description: 'Production-grade billing system with double-entry ledger, chargeback handling, and multi-gateway support',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="min-h-screen">{children}</div>
      </body>
    </html>
  )
}
