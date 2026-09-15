// Monitor de Facebook con TU sesión: maneja un Chromium con tu login de
// Facebook y extrae los últimos posts de cada cuenta. Todo queda en local,
// la sesión nunca sale de tu máquina.
//
// Uso:
//   1) Login una vez (abre ventana, inicias sesión, pulsas Enter aquí):
//      node scripts/monitor-facebook-browser.mjs --login
//   2) Prueba con 1 cuenta:
//      node scripts/monitor-facebook-browser.mjs --cuenta=aytofuencaliente
//   3) Todas las de /cuentas (requiere `pnpm dev` en otro terminal):
//      node scripts/monitor-facebook-browser.mjs --todas
//
// Opciones: --posts=3 --visible (ver lo que hace) --api=http://localhost:4322
//   --nivel=auto|todo|caliente|templada|fria (filtro por ritmo medido)
//   --solo-orden (imprime la cola priorizada y sale, sin navegador)
// Cola: 🎺 en cartel > 📅 temporada/pre-fiesta > 🔥 ritmo > tipo.
//   --cdp=http://localhost:9222 (en vez de perfil propio, maneja tu Chrome
//   abierto; ábrelo antes con --remote-debugging-port=9222)
//
// Ritmo educado: ~8-20 s aleatorios entre cuentas, secuencial, 1 pasada.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k, v.join('=') || true];
  })
);
const MAX_POSTS = Math.min(Number(args.posts || 3), 10);
const VISIBLE = args.visible !== undefined && args.visible !== 'false';
// Filtro de ritmo (Plan C): auto = todas salvo abandonadas; todo = incluso
// esas; o un nivel concreto (las sin medir entran siempre, como calientes).
const NIVEL = String(args.nivel || 'auto').toLowerCase();
const PROFILE = path.join(ROOT, '.cache', 'fb-profile');
const OUTDIR = path.join(ROOT, '.cache', 'fb-posts');
const API = String(args.api || 'http://localhost:4322');

function executablePropio() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  // Caché de Playwright en este Mac (chromium-1243 ARM).
  const mac = path.join(
    process.env.HOME || '', 'Library', 'Caches', 'ms-playwright',
    'chromium-1243', 'chrome-mac-arm64', 'Google Chrome for Testing.app',
    'Contents', 'MacOS', 'Google Chrome for Testing'
  );
  if (fs.existsSync(mac)) return mac;
  // Linux/Raspberry: chromium del sistema o cache de playwright.
  for (const c of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) {
    if (fs.existsSync(c)) return c;
  }
  return undefined; // playwright-core probará su registro interno
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const pausaEducada = () => espera(8000 + Math.random() * 12000);

// Progreso para la web (/lectura): lo pinta revision-auto.mjs y esta fase
// lo va rellenando cuenta a cuenta. Solo fichero local (sync, barato).
const PROGRESO = path.join(ROOT, '.cache', 'fb-progreso.json');
function marcarProgreso(parche) {
  let doc = {};
  try { doc = JSON.parse(fs.readFileSync(PROGRESO, 'utf8')); } catch {}
  try {
    fs.mkdirSync(path.dirname(PROGRESO), { recursive: true });
    // Atómico (tmp+rename): la API lo lee en caliente y un JSON a medias
    // tumbaría el guardado anti-doble y la web.
    fs.writeFileSync(PROGRESO + '.tmp', JSON.stringify(
      { ...doc, fase: 'extrayendo', ...parche, actualizadoEl: new Date().toISOString() }));
    fs.renameSync(PROGRESO + '.tmp', PROGRESO);
  } catch { /* se sigue sin progreso */ }
}

function leerCuentas() {
  if (args.cuenta) return String(args.cuenta).split(',').map((s) => s.trim()).filter(Boolean);
  return ['aytofuencaliente']; // prueba con 1 por defecto
}

async function cuentasDesdeApi() {
  // Devuelve las cuentas ENTERAS (no solo URLs): el orden por prioridad y el
  // filtro de ritmo los calcula ordenarCuentas() con estos mismos objetos.
  try {
    const r = await fetch(`${API}/api/fb-cuentas`);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    const lista = (d.cuentas || []).filter((c) => c.activa !== false);
    if (lista.length) return lista;
    throw new Error('API vacía');
  } catch (e) {
    // Fallback: fichero local de /cuentas (mismo formato que guarda la API).
    const fb = path.join(ROOT, '.cache', 'fb-cuentas.json');
    if (!fs.existsSync(fb)) throw new Error('Sin API ni .cache/fb-cuentas.json: ' + e.message);
    const arr = JSON.parse(fs.readFileSync(fb, 'utf8'));
    return arr.filter((c) => c.activa !== false);
  }
}

// ---------- Prioridad de cola (Plan C ritmo + Plan D temporada/cartel) ----------
const normTxt = (s) => String(s || '').toLowerCase().normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z]+/g, ' ').trim();

let CAL = null;
function calendario() {
  if (CAL) return CAL;
  try {
    CAL = JSON.parse(fs.readFileSync(
      path.join(ROOT, 'src', 'lib', 'data', 'calendario-fiestas.json'), 'utf8')).municipios || {};
  } catch { CAL = {}; }
  return CAL;
}

/** Meses calientes del municipio (los nombres del calendario vienen en forma
 *  corta: "Laguna", "Guia"…; se casa por token distintivo). */
function mesesCalientesDe(municipio) {
  const toks = new Set(normTxt(municipio).split(' ').filter((w) => w.length > 3));
  if (!toks.size) return [];
  for (const [k, v] of Object.entries(calendario())) {
    if (normTxt(k).split(' ').some((t) => toks.has(t))) return v.calientes || [];
  }
  return [];
}

/** temporada si el mes actual es caliente; pre-fiesta si alguno cae en el
 *  próximo mes; null si no hay datos o está fuera de temporada. */
function enTemporada(municipio, ahora = new Date()) {
  const cal = mesesCalientesDe(municipio).map(Number).filter(Boolean);
  if (!cal.length) return null;
  const mes = ahora.getMonth() + 1;
  if (cal.includes(mes)) return 'temporada';
  if (cal.some((m) => (((m - mes) % 12) + 12) % 12 <= 1)) return 'pre-fiesta';
  return null;
}

/** Orquestas con eventos presentes/futuros (las escribe revision-auto.mjs en
 *  .cache/fb-cola.json; caducan en 14 días). Vigilancia máxima: son las que
 *  pueden anunciar cambios o cancelaciones de lo ya publicado. */
function leerBoostCartel() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(ROOT, '.cache', 'fb-cola.json'), 'utf8'));
    if (Date.now() - (c.at || 0) > 14 * 864e5) return [];
    return (c.orquestas || []).map(normTxt).filter(Boolean);
  } catch { return []; }
}

const PESO_TIPO = { orquesta: 10, comision: 10, ayuntamiento: 5, otro: 0 };
const PESO_RITMO = { caliente: 30, templada: 15, fria: 5 };

function ordenarCuentas(cuentas) {
  const boost = leerBoostCartel();
  return cuentas
    .map((c) => (typeof c === 'string' ? { url: c } : c))
    .filter((c) => (c.activa ?? true) !== false)
    .map((c) => {
      const temp = enTemporada(c.municipio || '');
      const nom = normTxt(c.nombre || '');
      const enCartel = c.tipo === 'orquesta' && nom &&
        boost.some((b) => nom.includes(b) || b.includes(nom));
      const ritmo = c.ritmo || 'caliente'; // sin medir: entra siempre
      let score = (PESO_TIPO[c.tipo] || 0) + (PESO_RITMO[ritmo] ?? 30);
      const motivos = [];
      if (enCartel) { score += 200; motivos.push('🎺 en-cartel'); }
      if (temp) { score += 100; motivos.push(temp === 'temporada' ? '📅 temporada' : '📅 pre-fiesta'); }
      motivos.push(ritmo === 'caliente' && !c.ritmo ? '🆕 sin-medir' : '🔥' + ritmo);
      return { ...c, _score: score, _motivo: motivos.join(' ') };
    })
    .filter((c) => {
      if (NIVEL === 'todo') return true;
      if ((c.ritmo || '') === 'abandonada') return false;
      if (NIVEL === 'auto') return true;
      return (c.ritmo || 'caliente') === NIVEL;
    })
    .sort((a, b) => b._score - a._score);
}

function aPageUrl(cuenta) {
  if (/^https?:\/\//i.test(cuenta)) return cuenta;
  return `https://www.facebook.com/${cuenta.replace(/^@/, '')}/posts/`;
}

async function extraerPosts(page, max) {
  // ¿Pide login?
  const pideLogin = await page.evaluate(() => {
    const tieneEmail = !!document.querySelector('input#email, input[name="email"]');
    const articulos = document.querySelectorAll('div[role="article"]').length;
    return { tieneEmail, articulos };
  });
  if (pideLogin.articulos === 0 && pideLogin.tieneEmail) return { login: true, posts: [] };
  // Scroll hasta tener suficientes artículos NO vacíos (los vacíos suelen ser
  // cajas laterales o sugeridos que también llevan role=article).
  let posts = [];
  for (let i = 0; i < 8 && posts.length < max; i++) {
    await page.evaluate(() => window.scrollBy(0, 1500));
    await espera(1500);
    posts = await page.$$eval(
      'div[role="article"]',
      (els, n) => els.map((a) => {
        const texto = (a.innerText || '').slice(0, 2000).trim();
        const hrefs = [...a.querySelectorAll('a')].map((x) => x.href);
        const links = hrefs
          .filter((h) => /\/(posts|photo|reel)\/|fbid=|story_fbid=/.test(h));
        // PDFs: directos, Drive, o tras el redirector l.php?u=<url real>
        const pdfs = [...new Set(hrefs.map((h) => {
          try {
            const u = new URL(h);
            if (u.pathname === '/l.php' && u.searchParams.get('u')) return u.searchParams.get('u');
            return h;
          } catch { return h; }
        }).filter((h) => /\.pdf(\?|#|$)/i.test(h) || /drive\.google\.com/i.test(h)))].slice(0, 4);
        const imgs = [...a.querySelectorAll('img')].map((im) => im.src)
          .filter((s) => s.startsWith('http') && !s.includes('emoji'));
        const t = a.querySelector('time');
        const rel = (texto.match(/(\d+\s*min|\d+\s*h\b|ayer|\d+\s*d(?:[ií]as?)?\b|\d+\s*semanas?|\d{1,2}\s*de\s*[a-z]{3,}\.?)/i) || [])[1] || '';
        // Reels: no se verifican (solo importan imagen, texto y PDF).
        const esReel = /\/reel\//.test(links[0] || '') || /\d+:\d+\s*\/\s*\d+:\d+/.test(texto);
        return {
          texto,
          url: links[0] || '',
          imagenes: imgs.slice(0, 4),
          pdfs,
          esReel,
          fecha: t?.getAttribute('datetime') || rel
        };
      }),
      max * 3
    ).then((all) => all.filter((p) => p.texto.length > 40).slice(0, max));
  }
  return { login: false, posts };
}

async function main() {
  // La cola se calcula antes de abrir el navegador: --solo-orden sale sin
  // tocar Chromium (rápido, sin sesión).
  const brutas = (args.todas || args['solo-orden']) ? await cuentasDesdeApi() : leerCuentas();
  const cuentas = (args.todas || args['solo-orden']) ? ordenarCuentas(brutas) : brutas.map((u) => ({ url: u }));
  console.log(`Cuentas a revisar: ${cuentas.length} (máx ${MAX_POSTS} posts c/u, nivel=${NIVEL})\n`);
  if (args.todas) {
    // Solo se leen las no abandonadas (nivel auto): se anuncia lo omitido.
    const activas = brutas.filter((c) => (c.activa ?? true) !== false).length;
    const omitidas = activas - cuentas.length;
    if (omitidas > 0) console.log(NIVEL === 'auto'
      ? `Omitidas por abandono: ${omitidas} (usa --nivel=todo para incluirlas)\n`
      : `Omitidas por nivel=${NIVEL}: ${omitidas}\n`);
  }
  if (args['solo-orden']) {
    // Previsualiza la cola sin abrir el navegador.
    cuentas.forEach((c, k) => console.log(
      `${String(k + 1).padStart(3)}. [${c._score ?? '-'}] ${c._motivo || ''} ${c.url || c}`));
    return;
  }
  const exe = executablePropio();
  const launchOpts = { headless: !VISIBLE && !args.login, executablePath: exe };
  let context;
  if (args.cdp) {
    const browser = await chromium.connectOverCDP(String(args.cdp));
    context = browser.contexts()[0] || await browser.newContext();
    console.log('Conectado a tu Chrome abierto vía CDP.');
  } else {
    fs.mkdirSync(PROFILE, { recursive: true });
    context = await chromium.launchPersistentContext(PROFILE, {
      ...launchOpts,
      locale: 'es-ES',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    });
    console.log('Perfil de sesión:', PROFILE);
  }
  const page = context.pages()[0] || await context.newPage();

  if (args.login) {
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded' });
    console.log('\n👉 Inicia sesión en Facebook en la ventana abierta y pulsa Enter aquí.');
    await new Promise((res) => readline.createInterface({ input: process.stdin }).once('line', res));
    const cookies = await context.cookies('https://www.facebook.com');
    console.log(cookies.some((c) => c.name === 'c_user') ? 'Sesión guardada ✓ (c_user presente)' : 'Aviso: no veo c_user; ¿seguro que entraste?');
    await context.close();
    return;
  }

  marcarProgreso({ estado: 'en-curso', fase: 'extrayendo', inicio: Date.now(),
    cuentasTotal: cuentas.length, cuentasHechas: 0, cuentaActual: '' });
  fs.mkdirSync(OUTDIR, { recursive: true });

  let i = 0;
  for (const c of cuentas) {
    i++;
    const idOrUrl = c.url || c;
    const url = aPageUrl(idOrUrl);
    const motivo = c._motivo ? `[${c._motivo}] ` : '';
    process.stdout.write(`[${i}/${cuentas.length}] ${motivo}${url} … `);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForSelector('div[role="article"], input#email', { timeout: 20000 }).catch(() => {});
      const { login, posts } = await extraerPosts(page, MAX_POSTS);
      if (login) {
        console.log('PIDE LOGIN → ejecuta primero --login');
        break;
      }
      const slug = String(idOrUrl).replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'cuenta';
      fs.writeFileSync(path.join(OUTDIR, `${slug}.json`),
        JSON.stringify({ cuenta: idOrUrl, url, revisadoEl: new Date().toISOString(), posts }, null, 2));
      console.log(`${posts.length} posts ✓`);
      posts.forEach((p, k) => console.log(`   ${k + 1}. [${p.fecha || '?fecha'}]${(p.pdfs || []).length ? ' 📄PDF' : ''}${(p.imagenes || []).length ? ` 🖼×${p.imagenes.length}` : ''} ${p.texto.slice(0, 120).replace(/\n/g, ' ')}`));
    } catch (e) {
      console.log('ERROR:', e.message?.split('\n')[0]);
    }
    marcarProgreso({ cuentasHechas: i, cuentaActual: `${motivo}${url}` });
    if (i < cuentas.length) await pausaEducada();
  }
  await context.close();
  console.log(`\nListo. JSON en .cache/fb-posts/ (${fs.readdirSync(OUTDIR).length} ficheros)`);
}

main().catch((e) => { console.error('FALLO:', e.message); process.exit(1); });
