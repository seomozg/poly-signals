import type {NextConfig} from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

const nextConfig: NextConfig = {
  // Native module: keep it external to the server bundle
  serverExternalPackages: ['better-sqlite3'],
  images: {
    // Polymarket artwork is served from its own CDNs
    remotePatterns: [
      {protocol: 'https', hostname: 'polymarket-upload.s3.us-east-2.amazonaws.com'},
      {protocol: 'https', hostname: '**.amazonaws.com'},
      {protocol: 'https', hostname: '**.cloudfront.net'}
    ]
  }
};

export default withNextIntl(nextConfig);
