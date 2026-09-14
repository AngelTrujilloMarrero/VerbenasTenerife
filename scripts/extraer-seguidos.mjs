// Extrae TU lista de seguidos (quién sigues) para usarla como lista a monitorizar.
// Requiere sesión: antes `pnpm fb:login` (o --cdp con tu Chrome abierto).
//
// Uso:
//   node scripts/extraer-seguidos.mjs [--url="...sk=following"] [--importar] [--api=http://localhost:4322]
//   --importar sube cada seguido a /api/fb-cuentas (necesita `pnpm dev` aparte).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k, v.join('=') || true];
  })
);
const LISTA_URL = String(args.url || 'https://www.facebook.com/profile.php?id=61587088775574&sk=following');
const PROFILE = path.join(ROOT, '.cache', 'fb-profile');
const OUT = path.join(ROOT, '.cache', 'fb-seguidos.json');
const API = String(args.api || 'http://localhost:4322');
const VISIBLE = args.visible !== undefined && args.visible !== 'false';

function executablePropio() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const mac = path.join(
    process.env.HOME || '', 'Library', 'Caches', 'ms-playwright',
    'chromium-1243', 'chrome-mac-arm64', 'Google Chrome for Testing.app',
    'Contents', 'MacOS', 'Google Chrome for Testing'
  );
  if (fs.existsSync(mac)) return mac;
  for (const c of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) {
    if (fs.existsSync(c)) return c;
  }
  return undefined;
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// Enlaces que NO son entidades seguidas (navegación/ayuda de FB).
const BASURA = /^\/(login|reg|help|settings|policies|privacy|marketplace|gaming|watch|groups|events|friends|memories|saved|pages\/create|ads|business|developers|about|careers)(\/|$|\?)/i;

async function main() {
  let context;
  if (args.cdp) {
    const browser = await chromium.connectOverCDP(String(args.cdp));
    context = browser.contexts()[0] || await browser.newContext();
  } else {
    fs.mkdirSync(PROFILE, { recursive: true });
    context = await chromium.launchPersistentContext(PROFILE, {
      headless: !VISIBLE,
      executablePath: executablePropio(),
      locale: 'es-ES',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    });
  }
  const page = context.pages()[0] || await context.newPage();
  await page.goto(LISTA_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await espera(4000);

  // ¿Sesión válida o muro de login?
  const estado = await page.evaluate(() => ({
    login: !!document.querySelector('input#email, input[name="email"]'),
    titulo: document.title
  }));
  if (estado.login) {
    console.log('PIDE LOGIN → ejecuta primero: pnpm fb:login (entra en FB y pulsa Enter).');
    await context.close();
    process.exit(2);
  }
  console.log('Sesión OK ·', estado.titulo);

  // Scroll para cargar toda la lista (carga perezosa).
  let anteriores = -1, quietas = 0;
  for (let i = 0; i < 40 && quietas < 3; i++) {
    await page.evaluate(() => window.scrollBy(0, 2000));
    await espera(1500);
    const n = await page.$$eval('div[role="main"] a[href]', (els) => els.length).catch(() => 0);
    if (n === anteriores) quietas++;
    else { quietas = 0; anteriores = n; }
  }

  const seguidos = await page.$$eval('div[role="main"] a[href]', (els) =>
    els.map((a) => ({ nombre: (a.innerText || '').trim().split('\n')[0].slice(0, 120), href: a.href }))
  );
  const vistos = new Map();
  for (const s of seguidos) {
    let u;
    try { u = new URL(s.href); } catch { continue; }
    if (!/facebook\.com$/i.test(u.hostname.replace(/^www\.|^m\.|^mbasic\./, ''))) continue;
    if (BASURA.test(u.pathname + u.search)) continue;
    if (!s.nombre || s.nombre.length < 2) continue;
    if (/editar perfil|solicitudes de amistad/i.test(s.nombre)) continue;
    if (u.searchParams.get('id') === '61587088775574') continue;
    // Solo entidades: /<handle>/ o /profile.php?id= o /pages/...
    const esEntidad = /^\/[^/?#]+\/?$/.test(u.pathname) || /profile\.php/i.test(u.pathname) || /^\/pages\//i.test(u.pathname);
    if (!esEntidad) continue;
    const clave = u.pathname + u.searchParams.get('id');
    if (!vistos.has(clave)) vistos.set(clave, { nombre: s.nombre, url: 'https://www.facebook.com' + u.pathname + (u.searchParams.get('id') ? `?id=${u.searchParams.get('id')}` : '') });
  }
  const lista = [...vistos.values()];
  fs.writeFileSync(OUT, JSON.stringify({ extraidoEl: new Date().toISOString(), total: lista.length, seguidos: lista }, null, 2));
  console.log(`\nSeguidos encontrados: ${lista.length} → .cache/fb-seguidos.json`);
  lista.slice(0, 20).forEach((s, i) => console.log(`  ${i + 1}. ${s.nombre} · ${s.url}`));
  if (lista.length > 20) console.log(`  … y ${lista.length - 20} más (ver fichero)`);

  if (args.importar) {
    console.log('\nImportando a las cuentas a monitorizar…');
    const { execSync } = await import('node:child_process');
    try {
      execSync('node scripts/importar-seguidos.mjs', { cwd: ROOT, stdio: 'inherit' });
    } catch (e) {
      console.error('Error importando:', e.message);
    }
  }
  await context.close();
}

main().catch((e) => { console.error('FALLO:', e.message); process.exit(1); });
