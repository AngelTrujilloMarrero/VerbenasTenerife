import type { APIRoute } from 'astro';
import fs from 'node:fs';
import path from 'node:path';
import { borrarCuentaFB, guardarCuentaFB, leerCuentasFB } from '../../lib/db.js';
import { generarId, handleDeUrl, validarCuenta, type CuentaFB } from '../../lib/fb-cuentas.js';

export const prerender = false;

// Fallback local (Raspberry / dev sin credenciales Firebase): .cache/ está
// gitignored y ya se usa para el OCR. Si hay DB, la DB manda.
const ARCHIVO = path.join(process.cwd(), '.cache', 'fb-cuentas.json');

function leerLocal(): CuentaFB[] {
  try {
    if (!fs.existsSync(ARCHIVO)) return [];
    const arr = JSON.parse(fs.readFileSync(ARCHIVO, 'utf8')) as CuentaFB[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function escribirLocal(cuentas: CuentaFB[]): void {
  fs.mkdirSync(path.dirname(ARCHIVO), { recursive: true });
  fs.writeFileSync(ARCHIVO, JSON.stringify(cuentas, null, 2));
}

const json = (obj: unknown, status = 200): Response =>
  new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });

/** GET: lista todas (DB o local). */
export const GET: APIRoute = async () => {
  const deDb = await leerCuentasFB();
  const cuentas = deDb ?? leerLocal();
  const fuente = deDb ? 'db' : 'local';
  return json({ ok: true, fuente, total: cuentas.length, cuentas });
};

/** POST: crear o editar. Body {id?, nombre, url, municipio, tipo, activa}. */
export const POST: APIRoute = async ({ request }) => {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: 'Body JSON no válido' }, 400);
  }
  let datos;
  try {
    datos = validarCuenta(body);
  } catch (e) {
    return json({ ok: false, error: (e as Error).message }, 400);
  }
  const id = typeof body.id === 'string' && body.id.trim()
    ? body.id.trim().slice(0, 80)
    : generarId(datos.nombre);
  const ahora = Date.now();

  // Deduplica por handle (misma página con distinta URL no entra dos veces).
  const handle = handleDeUrl(datos.url);
  const previas = (await leerCuentasFB()) ?? leerLocal();
  const dup = previas.find((c) => c.handle === handle && c.id !== id);
  if (dup) return json({ ok: false, error: `Ya existe como "${dup.nombre}"` }, 409);

  const anterior = previas.find((c) => c.id === id);
  const cuenta: CuentaFB = {
    ...datos, handle, id,
    createdAt: anterior?.createdAt || ahora,
    updatedAt: ahora
  };
  if (await guardarCuentaFB(cuenta)) return json({ ok: true, fuente: 'db', cuenta });
  const resto = previas.filter((c) => c.id !== id);
  resto.push(cuenta);
  resto.sort((a, b) => a.nombre.localeCompare(b.nombre));
  escribirLocal(resto);
  return json({ ok: true, fuente: 'local', cuenta });
};

/** DELETE ?id=xxx : borra una cuenta. */
export const DELETE: APIRoute = async ({ url }) => {
  const id = (url.searchParams.get('id') || '').trim();
  if (!id) return json({ ok: false, error: 'Falta ?id=' }, 400);
  if (await borrarCuentaFB(id)) return json({ ok: true, fuente: 'db', id });
  const previas = leerLocal();
  if (!previas.some((c) => c.id === id)) return json({ ok: false, error: 'No existe' }, 404);
  escribirLocal(previas.filter((c) => c.id !== id));
  return json({ ok: true, fuente: 'local', id });
};
