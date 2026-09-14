// Prueba con 1 cuenta pública: aytofuencaliente (tu link de ejemplo).
// Estrategia sin login: 1) mbasic feed 2) fallback og:description del post.
// Uso: node scripts/probar-facebook.mjs [handle-o-url]
const TARGET = process.argv[2] || 'aytofuencaliente';
const PHOTO_URL = 'https://www.facebook.com/photo/?fbid=1517662860391049&set=a.294695026021178';

const UA_MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const UA_CRAWLER = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

async function get(url, ua, ms = 25000) {
  const r = await fetch(url, { headers: { 'User-Agent': ua, 'Accept-Language': 'es-ES,es;q=0.9' }, signal: AbortSignal.timeout(ms) });
  const text = await r.text();
  return { status: r.status, len: text.length, text };
}

function extraerPostsMbasic(html, base) {
  // mbasic: cada story suele ir en <div> con enlaces a /story.php, /posts/, /photo.php o ?fbid=
  const posts = [];
  const reLink = /<a[^>]+href="([^"]*(?:\/posts\/|\/photo\.php|\/photo\/|story\.php\?|fbid=)[^"]*)"[^>]*>([\s\S]{0,300}?)<\/a>/gi;
  let m;
  const vistos = new Set();
  while ((m = reLink.exec(html)) !== null && posts.length < 10) {
    let href = m[1].replace(/&amp;/g, '&');
    if (!href.startsWith('http')) href = base.replace(/\/$/, '') + (href.startsWith('/') ? href : '/' + href);
    const idm = href.match(/fbid=(\d+)|posts\/(\d+|pfbid\w+)|story_fbid=(\d+)/);
    const id = idm ? (idm[1] || idm[2] || idm[3]) : href.slice(0, 80);
    if (vistos.has(id)) continue;
    vistos.add(id);
    posts.push({ id, url: href });
  }
  // Texto cercano a cada enlace (ventana de 600 chars antes)
  return posts.map((p) => {
    const idx = html.indexOf(p.id.length > 6 ? p.id : p.url.slice(0, 40));
    const win = idx >= 0 ? html.slice(Math.max(0, idx - 600), idx + 200) : '';
    const txt = win.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
    return { ...p, contexto: txt };
  });
}

function extraerOg(html) {
  const getMeta = (re) => {
    const m = html.match(re);
    return m ? m[1].replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d)).replace(/&amp;/g, '&').replace(/&quot;/g, '"') : '';
  };
  const desc = getMeta(/<meta name="description" content="(.*?)"\s*\/?>/s);
  const canon = getMeta(/<link rel="canonical" href="(.*?)"/);
  const seoTitle = (html.match(/"seo_title":"(.*?)"/) || [])[1] || '';
  const msgFull = (html.match(/"message":\{"text":"((?:[^"\\]|\\.)*)"/) || [])[1] || '';
  return { desc: desc.slice(0, 500), canon, seoTitle, msgFull: msgFull.slice(0, 2000) };
}

console.log('=== PRUEBA 1 CUENTA:', TARGET, '===\n');

// 1) Feed mbasic
const feedUrl = TARGET.startsWith('http') ? TARGET : `https://mbasic.facebook.com/${TARGET}`;
try {
  const r = await get(feedUrl, UA_MOBILE);
  console.log(`[mbasic] HTTP ${r.status} · ${r.len} bytes · ${feedUrl}`);
  if (r.status === 200 && r.len > 5000) {
    const posts = extraerPostsMbasic(r.text, 'https://mbasic.facebook.com');
    console.log(`[mbasic] enlaces tipo post/foto encontrados: ${posts.length}`);
    posts.slice(0, 3).forEach((p, i) => console.log(`  ${i + 1}. id=${p.id}\n     url=${p.url.slice(0, 120)}\n     ctx=${p.contexto.slice(0, 160)}`));
  } else {
    console.log('[mbasic] respuesta corta o bloqueo, se pasa al fallback og.');
  }
} catch (e) {
  console.log('[mbasic] ERROR:', e.message);
}

console.log('');
// 2) Fallback: post concreto (tu link) vía og tags
try {
  const r = await get(PHOTO_URL, UA_CRAWLER);
  console.log(`[og] HTTP ${r.status} · ${r.len} bytes · post ejemplo`);
  const og = extraerOg(r.text);
  console.log('[og] description:', og.desc.slice(0, 300));
  console.log('[og] canonical:', og.canon);
  console.log('[og] seo_title:', og.seoTitle);
  console.log('[og] message completo:', og.msgFull.slice(0, 600).replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\n/g, ' | '));
  const ok = og.desc.includes('Pino de la Virgen') || og.msgFull.includes('Pino');
  console.log('\n=== RESULTADO:', ok ? 'OK ✓ extrae texto del post' : 'FALLO ✗ no extrae texto', '===');
} catch (e) {
  console.log('[og] ERROR:', e.message);
}
