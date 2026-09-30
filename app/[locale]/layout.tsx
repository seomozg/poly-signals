import type {Metadata} from 'next';
import {hasLocale, NextIntlClientProvider} from 'next-intl';
import {getMessages, getTranslations, setRequestLocale} from 'next-intl/server';
import {notFound} from 'next/navigation';
import {routing} from '@/i18n/routing';
import {config} from '@/lib/config';
import {alternates} from '@/lib/seo';
import SiteHeader from '@/components/SiteHeader';
import SiteFooter from '@/components/SiteFooter';
import YandexMetrika from '@/components/YandexMetrika';
import '../globals.css';

type Props = {
  children: React.ReactNode;
  params: Promise<{locale: string}>;
};

export function generateStaticParams() {
  return routing.locales.map((locale) => ({locale}));
}

export async function generateMetadata({
  params
}: Pick<Props, 'params'>): Promise<Metadata> {
  const {locale} = await params;
  const t = await getTranslations({locale, namespace: 'Metadata'});

  return {
    metadataBase: new URL(config.siteUrl),
    title: {
      default: t('catalogTitle'),
      template: `%s | ${t('siteName')}`
    },
    description: t('catalogDescription'),
    applicationName: t('siteName'),
    keywords: ['polymarket', 'prediction market', 'AI analysis', 'signals', 'edge', 'ставки'],
    robots: {index: true, follow: true},
    alternates: alternates(locale as 'ru' | 'en', '/'),
    verification: {
      yandex: config.yandexVerification || undefined,
      google: config.googleSiteVerification || undefined
    },
    openGraph: {
      type: 'website',
      siteName: t('siteName'),
      locale: locale === 'ru' ? 'ru_RU' : 'en_US',
      url: config.siteUrl
    }
  };
}

export default async function LocaleLayout({children, params}: Props) {
  const {locale} = await params;
  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }
  setRequestLocale(locale);

  const t = await getTranslations({locale, namespace: 'Header'});
  // Client components (e.g. the localized not-found page) need the messages:
  // without them their SSR throws and the whole body fails to render.
  const messages = await getMessages({locale});

  return (
    <html lang={locale} className="dark" suppressHydrationWarning>
      <body>
        <YandexMetrika id={config.yandexMetrikaId} />
        <NextIntlClientProvider locale={locale} messages={messages}>
          <SiteHeader
            locale={locale}
            brand={t('brand')}
            brandSubtitle={t('brandSubtitle')}
            catalogLabel={t('catalog')}
            languageLabel={t('language')}
          />
          <main className="container-page py-8 sm:py-12">{children}</main>
          <SiteFooter locale={locale} />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
