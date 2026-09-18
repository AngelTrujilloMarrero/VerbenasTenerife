import type { APIRoute } from 'astro';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const prerender = false;

// Lanza una revisión de Facebook desde la web (/lectura).
// SOLO Mac local: en Vercel no hay scripts ni navegador y se rechaza (501).
// Se lanza en detached (sobrevive a la petición) con el log anexado a
// /tmp/verbenas-revision.log, que ya muestra /lectura. Guarda anti-doble:
// si hay una pasada en curso con latido fresco, 409 salvo forzar:true.
const STALE_MS = 45 * 60 * 1000;

const json = (obj: unknown, status = 200): Response =>
  new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });

const esLocal = (): boolean =>
  fs.existsSync(path.join(process.cwd(), 'scripts', 'revision-auto.mjs'));

function progresoLocal(): any | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.cwd(), '.cache', 'fb-progreso.json'), 'utf8'));
  } catch {
    return null;
  }
}

function enCurso(p: any): boolean {
  if (p?.estado !== 'en-curso') return false;
  return Date.now() - (Date.parse(p.actualizadoEl || '') || 0) < STALE_MS;
}

export const POST: APIRoute = async ({ request }) => {
  if (!esLocal()) {
    return json({ ok: false, error: 'Solo disponible en el Mac local (aquí no hay navegador ni scripts).' }, 501);
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch { /* sin body: modo completo */ }
  const modo = String(body.modo || 'completa'); // completa | prioritaria | clasificar
  const forzar = body.forzar === true;
  // Alcance y profundidad (solo modo completa; se reenvían al monitor).
  const NIVELES = ['auto', 'todo', 'caliente', 'templada', 'fria'];
  const nivel = NIVELES.includes(String(body.nivel || 'auto')) ? String(body.nivel) : 'auto';
  const posts = Math.max(1, Math.min(Number(body.posts || 3), 10)) || 3;

  const prog = progresoLocal();
  const hayEnCurso = enCurso(prog);
  if (hayEnCurso && !forzar) {
    return json({ ok: false, error: 'Ya hay una revisión en marcha.', progreso: prog }, 409);
  }

  // Prioritaria: Sili García + Ruta del Cherne (apertura de la web, ~1 min).
  // No pisa el guardado de 20h del barrido programado (sello propio de 6h).
  const args =
    modo === 'clasificar'
      ? ['scripts/revision-auto.mjs', '--forzar', '--sin-extraer']
      : modo === 'prioritaria'
        ? ['scripts/revision-auto.mjs', '--prioritaria', `--posts=${Math.max(1, Math.min(Number(body.posts || 5), 10)) || 5}`]
        : ['scripts/revision-auto.mjs', '--forzar', `--nivel=${nivel}`, `--posts=${posts}`];
  // Pre-aviso para que /lectura lo pinte al instante (el script lo pisa).
  // Si ya hay una pasada viva no se toca su fichero: es la dueña del latido.
  if (!hayEnCurso) {
    try {
      const f = path.join(process.cwd(), '.cache', 'fb-progreso.json');
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f + '.tmp', JSON.stringify({ ...prog, estado: 'en-curso', fase: 'iniciando',
        inicio: Date.now(), actualizadoEl: new Date().toISOString() }, null, 2));
      fs.renameSync(f + '.tmp', f);
    } catch { /* se sigue */ }
  }

  let logFd: number | undefined;
  try {
    logFd = fs.openSync('/tmp/verbenas-revision.log', 'a');
  } catch { /* sin log a fichero */ }
  const hijo = spawn(process.execPath, args, {
    cwd: process.cwd(),
    detached: true,
    stdio: logFd !== undefined ? ['ignore', logFd, logFd] : 'ignore'
  });
  hijo.unref();

  return json({ ok: true, modo, nivel: modo === 'completa' ? nivel : undefined,
    posts: modo === 'completa' || modo === 'prioritaria' ? posts : undefined, pid: hijo.pid ?? null,
    nota: modo === 'prioritaria'
      ? 'Revisión prioritaria lanzada (Sili García + Ruta del Cherne).'
      : 'Revisión lanzada en el Mac. Sigue el avance en esta misma página.' });
};
