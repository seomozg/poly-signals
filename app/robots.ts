import type {MetadataRoute} from 'next';
import {config} from '@/lib/config';

/**
 * robots.txt for Google (Sitemap:) and Yandex (Host: + Sitemap:).
 * Yandex expects `Host` without a protocol, hence the explicit host name.
 */
export default function robots(): MetadataRoute.Robots {
  const host = new URL(config.siteUrl).host;

  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/api/']
      }
    ],
    sitemap: `${config.siteUrl}/sitemap.xml`,
    host
  };
}
