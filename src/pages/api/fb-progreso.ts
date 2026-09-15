import type { APIRoute } from 'astro';
import fs from 'node:fs';
import path from 'node:path';
import { leerNodoFB } from '../../lib/db.js';

export const prerender = false;

// Estado del proceso de lectura de Facebook para la página /lectura.
// Local (.cache) cuando hay; en Vercel tira de Firebase (meta/fb_progreso,
// meta/fb_revision) que escribe scripts/revision-auto.mjs en cada pasada.
const MIN_HORAS = 20;
const STALE_MS = 45 * 60 * 1000; // sin latido 45 min → se da por detenida

const json = (obj: unknown, status = 200): Response =>
  new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });

function leeJSON(p: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export const GET: APIRoute = async () => {
  const cache = (n: string): string => path.join(process.cwd(), '.cache', n);

  // Último sello (guardado de 20h del script).
  let stamp = 0;
  try {
    stamp = Number(fs.readFileSync(cache('fb-ultima-revision'), 'utf8')) || 0;
  } catch { /* sin sello: lista para revisar */ }

  // Progreso: gana el más fresco entre local y nube.
  const pLocal = leeJSON(cache('fb-progreso.json'));
  let pNube: any = null;
  try {
    pNube = await leerNodoFB('meta/fb_progreso');
  } catch { /* sin DB */ }
  const t = (p: any): number => Date.parse(p?.actualizadoEl || '') || 0;
  const progreso =
    pNube && t(pNube) >= t(pLocal) ? { ...pNube, fuente: 'db' }
    : pLocal ? { ...pLocal, fuente: 'local' }
    : null;

  // Última revisión terminada: local vs nube, la más nueva.
  const candLocal = leeJSON(cache('fb-candidatas.json'));
  let revNube: any = null;
  try {
    revNube = await leerNodoFB('meta/fb_revision');
  } catch { /* sin DB */ }
  const ultLocal = candLocal ? {
    at: candLocal.actualizadoEl || null,
    cuentas: candLocal.cuentas ?? null,
    posts: candLocal.posts ?? null,
    candidatas: (candLocal.candidatas || []).length,
    fuente: 'local'
  } : null;
  const ultNube = revNube?.at ? {
    at: new Date(revNube.at).toISOString(),
    cuentas: revNube.cuentas ?? null,
    posts: revNube.posts ?? null,
    candidatas: revNube.candidatas ?? null,
    fuente: 'db'
  } : null;
  const ultima =
    ultNube && Date.parse(ultNube.at || '') >= Date.parse(ultLocal?.at || '') ? ultNube
    : ultLocal;

  // Estado: en-curso solo con latido fresco; si no, detenida o reposo.
  let estado = 'reposo';
  if (progreso?.estado === 'en-curso') {
    estado = Date.now() - t(progreso) < STALE_MS ? 'en-curso' : 'detenida';
  }

  // Próxima: no antes de stamp+20h; plan diario 08:00 + al arrancar.
  const noAntesDe = stamp ? stamp + MIN_HORAS * 36e5 : 0;
  const proxima = {
    noAntesDe: noAntesDe ? new Date(noAntesDe).toISOString() : null,
    listaParaRevisar: !noAntesDe || Date.now() >= noAntesDe,
    plan: 'Diaria 08:00 + al arrancar el Mac (guardado 20h entre pasadas)'
  };

  // Informes recientes (solo local).
  let informes: string[] = [];
  try {
    informes = fs.readdirSync(path.join(process.cwd(), '.cache'))
      .filter((f) => /^fb-revision-\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort()
      .reverse()
      .slice(0, 7);
  } catch { /* sin .cache (Vercel) */ }

  // Cola del log (solo local, Mac).
  let log: string[] | null = null;
  try {
    const txt = fs.readFileSync('/tmp/verbenas-revision.log', 'utf8');
    log = txt.trim().split('\n').slice(-30);
  } catch { /* sin log */ }

  // Caché local: cuentas configuradas vs ficheros de posts.
  let cuentasConfig: number | null = null;
  let ficherosPosts: number | null = null;
  try {
    const arr = leeJSON(cache('fb-cuentas.json'));
    cuentasConfig = Array.isArray(arr) ? arr.length : null;
    ficherosPosts = fs.readdirSync(cache('fb-posts')).filter((f) => f.endsWith('.json')).length;
  } catch { /* sin .cache */ }

  // Solo el Mac local puede lanzar revisiones (tiene scripts + navegador).
  const puedeForzar = fs.existsSync(path.join(process.cwd(), 'scripts', 'revision-auto.mjs'));

  return json({
    ok: true,
    at: new Date().toISOString(),
    estado,
    progreso,
    ultima,
    proxima,
    informes,
    log,
    cache: { cuentasConfig, ficherosPosts },
    puedeForzar
  });
};
