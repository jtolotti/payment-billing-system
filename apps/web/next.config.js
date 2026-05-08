/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@billing/ui'],
  experimental: {
    typedRoutes: false,
  },
}

module.exports = nextConfig
