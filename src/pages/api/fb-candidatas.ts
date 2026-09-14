import type { APIRoute } from 'astro';
import fs from 'node:fs';
import path from 'node:path';
import { leerNodoFB } from '../../lib/db.js';

export const prerender = false;

// Listado completo de candidatas de Facebook (texto + fotos + PDFs).
// Fuente 1: Firebase `fb_candidatos` (cuando hay service account).
// Fuente 2: `.cache/fb-candidatas.json` que escribe scripts/revision-auto.mjs.
const LOCAL = path.join(process.cwd(), '.cache', 'fb-candidatas.json');

const json = (obj: unknown, status = 200): Response =>
  new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });

export const GET: APIRoute = async () => {
  // Solo hallazgos frescos (post de <=7 días): nada de pasado.
  const fresca = (c: any): boolean => (c?.dias ?? 999) <= 7;
  const deDb = await leerNodoFB('fb_candidatos');
  if (deDb && Object.keys(deDb).length) {
    const meta = (await leerNodoFB('meta/fb_revision')) || {};
    const candidatas = Object.values(deDb).filter(fresca).sort(
      (a: any, b: any) => (b.score || 0) - (a.score || 0) || (a.dias ?? 999) - (b.dias ?? 999)
    );
    return json({ ok: true, fuente: 'db', total: candidatas.length, meta, candidatas });
  }
  try {
    if (!fs.existsSync(LOCAL)) {
      return json({ ok: true, fuente: 'ninguna', total: 0, candidatas: [],
        aviso: 'Aún no hay revisión. Ejecuta: pnpm fb:revision' });
    }
    const d = JSON.parse(fs.readFileSync(LOCAL, 'utf8'));
    const candidatas = (d.candidatas || []).filter(fresca);
    return json({ ok: true, fuente: 'local', total: candidatas.length,
      meta: { at: d.actualizadoEl, cuentas: d.cuentas, posts: d.posts }, candidatas });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e) }, 500);
  }
};
