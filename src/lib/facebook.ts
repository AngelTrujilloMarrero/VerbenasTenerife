// Extracción de posts PÚBLICOS de Facebook sin login.
// VERIFICADO 14-sep-2026 con https://www.facebook.com/photo/?fbid=1517662860391049...:
//  - URL concreta de post/foto SÍ devuelve texto (meta description + canonical).
//  - Feed de página (/aytofuencaliente, /posts, /photos) NO: sin login solo
//    sirve cabecera/CSS (muro tras login-wall). Por eso el monitor trabaja
//    sobre URLs de posts que el usuario pega, no auto-descubre el timeline.
export interface PostFB {
  id: string;
  texto: string;
  url: string;
  canonica: string;
  handle: string;
}

const UA_CRAWLER = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

function decodificar(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/** Extrae texto + canónica de una URL concreta de post/foto pública. */
export async function extraerPostFacebook(postUrl: string, timeoutMs = 25000): Promise<PostFB> {
  const r = await fetch(postUrl, {
    headers: { 'User-Agent': UA_CRAWLER, 'Accept-Language': 'es-ES,es;q=0.9' },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} en ${postUrl}`);
  const html = await r.text();
  const desc = decodificar(html.match(/<meta name="description" content="(.*?)"\s*\/?>/s)?.[1] || '');
  const canonica = decodificar(html.match(/<link rel="canonical" href="(.*?)"/)?.[1] || '');
  if (!desc) throw new Error('Sin meta description: post no público o tras login');
  const fbid = postUrl.match(/fbid=(\d+)/)?.[1]
    || canonica.match(/\/(\d+)\/?$/)?.[1]
    || `post-${Date.now().toString(36)}`;
  const handle = (() => {
    try {
      const u = new URL(canonica || postUrl);
      return u.pathname.split('/').filter(Boolean)[0] || '';
    } catch { return ''; }
  })();
  return { id: `fb-${fbid}`, texto: desc.trim(), url: postUrl, canonica, handle };
}
