import { PrismaClient, LedgerAccountType, SubscriptionStatus } from '@prisma/client'

const prisma = new PrismaClient()

/**
 * Seed the database with baseline data:
 *   - 3 plans (BASIC, STANDARD, PREMIUM) — placeholder prices
 *   - 2 test users (one regular, one admin)
 *   - Opening ledger accounts for each user (ASSET) + system accounts (LIABILITY, REVENUE, EXPENSE)
 *   - STANDARD subscription for the regular user, with opening credits
 *   - billing_config defaults (e.g. chargeback_fee_cents = 1500)
 */
async function main() {
  console.log('Seeding database...')

  // Plans --------------------------------------------------------------
  await prisma.plan.upsert({
    where: { key: 'BASIC' },
    update: {},
    create: {
      key: 'BASIC',
      displayName: 'Basic',
      priceCents: 0,
      monthlyCredits: 100,
      description: 'Entry tier',
    },
  })

  await prisma.plan.upsert({
    where: { key: 'STANDARD' },
    update: {},
    create: {
      key: 'STANDARD',
      displayName: 'Standard',
      priceCents: 1000, // $10.00 — placeholder
      monthlyCredits: 1000,
      description: 'Mid tier',
    },
  })

  await prisma.plan.upsert({
    where: { key: 'PREMIUM' },
    update: {},
    create: {
      key: 'PREMIUM',
      displayName: 'Premium',
      priceCents: 10000, // $100.00 — placeholder
      monthlyCredits: 10000,
      description: 'Top tier',
    },
  })

  // Users --------------------------------------------------------------
  const testUser = await prisma.user.upsert({
    where: { email: 'test-user@example.com' },
    update: {},
    create: {
      id: 'test-user-1',
      email: 'test-user@example.com',
      name: 'Test User',
      role: 'USER',
    },
  })

  const adminUser = await prisma.user.upsert({
    where: { email: 'admin@example.com' },
    update: {},
    create: {
      id: 'test-admin-1',
      email: 'admin@example.com',
      name: 'Admin User',
      role: 'ADMIN',
    },
  })

  // Ledger accounts ----------------------------------------------------
  await prisma.ledgerAccount.upsert({
    where: {
      userId_accountType: { userId: testUser.id, accountType: LedgerAccountType.ASSET },
    },
    update: {},
    create: {
      userId: testUser.id,
      accountType: LedgerAccountType.ASSET,
      balance: 0,
    },
  })

  await prisma.ledgerAccount.upsert({
    where: {
      userId_accountType: { userId: adminUser.id, accountType: LedgerAccountType.ASSET },
    },
    update: {},
    create: {
      userId: adminUser.id,
      accountType: LedgerAccountType.ASSET,
      balance: 0,
    },
  })

  // Shared system accounts (LIABILITY = escrow, REVENUE, EXPENSE = chargeback costs)
  // Owned by the admin user as a stand-in for "system" — see IMPLEMENTATION_PLAN.md
  // for the planned dedicated system-user row refactor.
  await prisma.ledgerAccount.upsert({
    where: {
      userId_accountType: { userId: adminUser.id, accountType: LedgerAccountType.LIABILITY },
    },
    update: {},
    create: {
      userId: adminUser.id,
      accountType: LedgerAccountType.LIABILITY,
      balance: 0,
    },
  })

  await prisma.ledgerAccount.upsert({
    where: {
      userId_accountType: { userId: adminUser.id, accountType: LedgerAccountType.REVENUE },
    },
    update: {},
    create: {
      userId: adminUser.id,
      accountType: LedgerAccountType.REVENUE,
      balance: 0,
    },
  })

  await prisma.ledgerAccount.upsert({
    where: {
      userId_accountType: { userId: adminUser.id, accountType: LedgerAccountType.EXPENSE },
    },
    update: {},
    create: {
      userId: adminUser.id,
      accountType: LedgerAccountType.EXPENSE,
      balance: 0,
    },
  })

  // Credits record (flat balance) for test user
  await prisma.credits.upsert({
    where: { userId: testUser.id },
    update: {},
    create: {
      userId: testUser.id,
      balance: 1000,
    },
  })

  // Subscription (active STANDARD for test user, funded by AuthorizeNet)
  const subscription = await prisma.subscription.upsert({
    where: { userId: testUser.id },
    update: {},
    create: {
      userId: testUser.id,
      status: SubscriptionStatus.ACTIVE,
      plan: 'STANDARD',
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  })

  await prisma.gatewaySubscription.upsert({
    where: { subscriptionId: subscription.id },
    update: {},
    create: {
      subscriptionId: subscription.id,
      gatewayType: 'AUTHORIZE_NET',
      gatewaySubscriptionId: 'arb_seed_123',
      gatewayCustomerId: 'an_cust_seed_test_user_1',
      gatewayData: {
        profileId: 'an_profile_seed_123',
        arbSubscriptionId: 'arb_seed_123',
      },
    },
  })

  await prisma.gatewayCustomer.upsert({
    where: { userId_gateway: { userId: testUser.id, gateway: 'AUTHORIZE_NET' } },
    update: {},
    create: {
      userId: testUser.id,
      gateway: 'AUTHORIZE_NET',
      gatewayCustomerId: 'an_cust_seed_test_user_1',
    },
  })

  console.log('Seed complete.')
  console.log('Test users:')
  console.log('  - test-user-1 (role=USER, plan=STANDARD, 1000 credits)')
  console.log('  - test-admin-1 (role=ADMIN)')
  console.log('Send the x-user-id header with either of those IDs to authenticate.')

  // Billing config defaults
  await prisma.billingConfig.upsert({
    where: { key: 'chargeback_fee_cents' },
    update: {},
    create: { key: 'chargeback_fee_cents', value: '1500' },
  })

  console.log('BillingConfig seeded: chargeback_fee_cents=1500')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
