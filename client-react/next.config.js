/** @type {import('next').NextConfig} */
// URL du serveur backend (Railway/Render). En local : localhost:3001.
const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3001';

const nextConfig = {
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${SERVER_URL}/api/:path*` },
      { source: '/auth/:path*', destination: `${SERVER_URL}/auth/:path*` },
    ];
  },
};

module.exports = nextConfig;
