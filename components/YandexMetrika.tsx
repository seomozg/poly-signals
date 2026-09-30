'use client';

import {useEffect} from 'react';

type Props = {
  /** Yandex.Metrika counter id (passed from the server layout). */
  id: string;
};

type YmFn = ((...args: unknown[]) => void) & {a?: unknown[][]; l?: number};

/**
 * Client-side fallback used when the inline snippet could not run.
 * Mirrors Yandex's own loader: defines `window.ym` with a pending-call queue,
 * appends tag.js (unless it is already in the document) and fires `init`.
 */
function initMetrika(id: string): void {
  const scope = window as unknown as {ym?: YmFn};
  if (typeof scope.ym === 'function') return; // inline snippet already ran

  const ym: YmFn = (...args: unknown[]) => {
    ym.a = ym.a ?? [];
    ym.a.push(args);
  };
  ym.l = Date.now();
  scope.ym = ym;

  const src = `https://mc.yandex.ru/metrika/tag.js?id=${id}`;
  const alreadyLoaded = Array.from(document.scripts).some((s) => s.src === src);
  if (!alreadyLoaded) {
    const el = document.createElement('script');
    el.src = src;
    el.async = true;
    const first = document.getElementsByTagName('script')[0];
    first?.parentNode?.insertBefore(el, first);
  }

  scope.ym(id, 'init', {
    ssr: true,
    webvisor: true,
    clickmap: true,
    ecommerce: 'dataLayer',
    referrer: document.referrer,
    url: location.href,
    accurateTrackBounce: true,
    trackLinks: true
  });
}

/**
 * Yandex.Metrika counter.
 *
 * - On every server-rendered page the verbatim snippet is the first element
 *   of <body> (the layout places it there).
 * - Next.js does not server-render the body of 404 responses (the whole page
 *   is client-rendered from the RSC payload, and scripts injected via
 *   innerHTML never run), so on mount we detect that case — `window.ym` is
 *   missing — and initialise the counter programmatically. On normal pages
 *   the inline snippet has already defined `window.ym`, so the effect does
 *   nothing and there is never a double init.
 */
export default function YandexMetrika({id}: Props) {
  useEffect(() => {
    if (typeof window === 'undefined' || !id) return;
    initMetrika(id);
  }, [id]);

  if (!id) return null;

  const code = `<!-- Yandex.Metrika counter -->
<script type="text/javascript">
    (function(m,e,t,r,i,k,a){
        m[i]=m[i]||function(){(m[i].a=m[i].a||[]).push(arguments)};
        m[i].l=1*new Date();
        for (var j = 0; j < document.scripts.length; j++) {if (document.scripts[j].src === r) { return; }}
        k=e.createElement(t),a=e.getElementsByTagName(t)[0],k.async=1,k.src=r,a.parentNode.insertBefore(k,a)
    })(window, document,'script','https://mc.yandex.ru/metrika/tag.js?id=${id}', 'ym');

    ym(${id}, 'init', {ssr:true, webvisor:true, clickmap:true, ecommerce:"dataLayer", referrer: document.referrer, url: location.href, accurateTrackBounce:true, trackLinks:true});
</script>
<noscript><div><img src="https://mc.yandex.ru/watch/${id}" style="position:absolute; left:-9999px;" alt="" /></div></noscript>
<!-- /Yandex.Metrika counter -->`;

  return <div dangerouslySetInnerHTML={{__html: code}} />;
}
