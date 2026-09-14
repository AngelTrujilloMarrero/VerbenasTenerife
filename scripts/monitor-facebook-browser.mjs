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

function leerCuentas() {
  if (args.cuenta) return String(args.cuenta).split(',').map((s) => s.trim()).filter(Boolean);
  return ['aytofuencaliente']; // prueba con 1 por defecto
}

async function cuentasDesdeApi() {
  try {
    const r = await fetch(`${API}/api/fb-cuentas`);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    const lista = (d.cuentas || []).filter((c) => c.activa !== false).map((c) => c.url);
    if (lista.length) return lista;
    throw new Error('API vacía');
  } catch (e) {
    // Fallback: fichero local de /cuentas (mismo formato que guarda la API).
    const fb = path.join(ROOT, '.cache', 'fb-cuentas.json');
    if (!fs.existsSync(fb)) throw new Error('Sin API ni .cache/fb-cuentas.json: ' + e.message);
    const arr = JSON.parse(fs.readFileSync(fb, 'utf8'));
    return arr.filter((c) => c.activa !== false).map((c) => c.url);
  }
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
        const links = [...a.querySelectorAll('a')].map((x) => x.href)
          .filter((h) => /\/(posts|photo|reel)\/|fbid=|story_fbid=/.test(h));
        const imgs = [...a.querySelectorAll('img')].map((im) => im.src)
          .filter((s) => s.startsWith('http') && !s.includes('emoji'));
        const t = a.querySelector('time');
        const rel = (texto.match(/(\d+\s*min|\d+\s*h\b|ayer|\d+\s*d(?:[ií]as?)?\b|\d+\s*semanas?|\d{1,2}\s*de\s*[a-z]{3,}\.?)/i) || [])[1] || '';
        return {
          texto,
          url: links[0] || '',
          imagenes: imgs.slice(0, 4),
          fecha: t?.getAttribute('datetime') || rel
        };
      }),
      max * 3
    ).then((all) => all.filter((p) => p.texto.length > 40).slice(0, max));
  }
  return { login: false, posts };
}

async function main() {
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

  const cuentas = args.todas ? await cuentasDesdeApi() : leerCuentas();
  console.log(`Cuentas a revisar: ${cuentas.length} (máx ${MAX_POSTS} posts c/u)\n`);
  fs.mkdirSync(OUTDIR, { recursive: true });

  let i = 0;
  for (const cuenta of cuentas) {
    i++;
    const url = aPageUrl(cuenta);
    process.stdout.write(`[${i}/${cuentas.length}] ${url} … `);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForSelector('div[role="article"], input#email', { timeout: 20000 }).catch(() => {});
      const { login, posts } = await extraerPosts(page, MAX_POSTS);
      if (login) {
        console.log('PIDE LOGIN → ejecuta primero --login');
        break;
      }
      const slug = cuenta.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'cuenta';
      fs.writeFileSync(path.join(OUTDIR, `${slug}.json`),
        JSON.stringify({ cuenta, url, revisadoEl: new Date().toISOString(), posts }, null, 2));
      console.log(`${posts.length} posts ✓`);
      posts.forEach((p, k) => console.log(`   ${k + 1}. [${p.fecha || '?fecha'}] ${p.texto.slice(0, 120).replace(/\n/g, ' ')}`));
    } catch (e) {
      console.log('ERROR:', e.message?.split('\n')[0]);
    }
    if (i < cuentas.length) await pausaEducada();
  }
  await context.close();
  console.log(`\nListo. JSON en .cache/fb-posts/ (${fs.readdirSync(OUTDIR).length} ficheros)`);
}

main().catch((e) => { console.error('FALLO:', e.message); process.exit(1); });
