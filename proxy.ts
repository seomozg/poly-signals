import createMiddleware from 'next-intl/middleware';
import {routing} from './i18n/routing';

/**
 * Locale detection + redirect (/ -> /ru, /signal/x -> /en/signal/x by Accept-Language).
 * In Next.js 16 this file is called proxy.ts (it was middleware.ts before).
 */
export default createMiddleware(routing);

export const config = {
  // Skip API routes, Next internals and files with an extension (sitemap.xml, robots.txt, icons)
  matcher: '/((?!api|trpc|_next|_vercel|.*\\..*).*)'
};
