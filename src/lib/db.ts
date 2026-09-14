import admin from 'firebase-admin';
import fs from 'node:fs';
import { hoyDMY } from './fechas.js';
import { normTxt } from './municipios.js';
import type { Verbena } from './types.js';

// Persistencia en Realtime Database (proyecto verbenastenerife).
// Técnicas anti-duplicados del proyecto admin (AdminDeBelingo):
// leer-antes-de-escribir, upsert por ID estable con `set` (nunca `push`),
// comparación normalizada NFD y borrado por ID sin rastros.
// Sin credenciales no rompe nada: avisa una vez y no persiste.
export interface EventoDB extends Verbena {
  fuente: string;
  actualizadoAt: number;
  /** yyyymmdd para purgar/ordenar por rango en RTDB. */
  dayNum: number;
}

let app: admin.app.App | null = null;
let avisado = false;

function sinDb(): null {
  if (!avisado) {
    avisado = true;
    console.warn('db: sin credenciales Firebase (FIREBASE_SERVICE_ACCOUNT_JSON); no se persiste');
  }
  return null;
}

function db(): admin.database.Database | null {
  if (app) return admin.database(app);
  try {
    const sa = (process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
    const url = (process.env.PUBLIC_FIREBASE_DATABASE_URL || '').trim();
    if (!sa || !url) return sinDb();
    // Vale JSON inline o ruta a fichero.
    const cred = sa.startsWith('{') ? JSON.parse(sa) : JSON.parse(fs.readFileSync(sa, 'utf8'));
    if (!cred.project_id || !cred.private_key) return sinDb();
    app = admin.initializeApp({
      credential: admin.credential.cert(cred as admin.ServiceAccount),
      databaseURL: url
    });
    return admin.database(app);
  } catch (e) {
    if (!avisado) {
      avisado = true;
      console.error('db: no se pudo iniciar Firebase Admin:', (e as Error)?.message || e);
    }
    return null;
  }
}

/** yyyymmdd desde dd-mm-yyyy (para rangos y purga). */
export function dayNum(day: string): number {
  const [d, m, y] = day.split('-').map(Number);
  if (!d || !m || !y) return 0;
  return y * 10000 + m * 100 + d;
}

/** dd-mm-yyyy de hoy menos N días (hora local servidor). */
function haceDias(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return hoyDMY(d);
}

/** ¿Trae el raspado algo distinto a lo guardado? (normalizado NFD). */
function iguales(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const norm = (v: unknown): string =>
    Array.isArray(v) ? v.map(String).join('|') : normTxt(String(v ?? ''));
  const claves = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of claves) {
    if (k === 'actualizadoAt') continue;
    if (norm(a[k]) !== norm(b[k])) return false;
  }
  return true;
}

/** Volcado upsert: solo escribe lo nuevo o cambiado. Devuelve stats. */
export async function volcarVerbenas(
  verbenas: Verbena[], fuenteId: string
): Promise<{ leidas: number; escritas: number }> {
  const base = db();
  if (!base) return { leidas: 0, escritas: 0 };
  let escritas = 0;
  const ahora = Date.now();
  for (const v of verbenas) {
    try {
      const r = base.ref(`events/${v.id}`);
      const snap = await r.get();
      const doc: EventoDB = { ...v, fuente: fuenteId, actualizadoAt: ahora, dayNum: dayNum(v.day) };
      if (!snap.exists() || !iguales(snap.val() as Record<string, unknown>, doc as unknown as Record<string, unknown>)) {
        await r.set(doc);
        escritas++;
      }
    } catch (e) {
      console.error(`db: volcado ${v.id} fallo`, (e as Error)?.message || e);
    }
  }
  try {
    await base.ref(`meta/${fuenteId}`).set({ at: ahora, eventos: verbenas.length, ok: true });
  } catch (e) {
    console.error('db: meta fallo', (e as Error)?.message || e);
  }
  return { leidas: verbenas.length, escritas };
}

/** ¿Hay base de datos disponible? (para que la API use fallback local si no). */
export function hayDb(): boolean {
  return db() !== null;
}

/** Lee todas las cuentas FB monitorizadas. null = sin DB (usar fallback local). */
export async function leerCuentasFB(): Promise<import('./fb-cuentas.js').CuentaFB[] | null> {
  const base = db();
  if (!base) return null;
  try {
    const snap = await base.ref('fb_cuentas').get();
    if (!snap.exists()) return [];
    const val = snap.val() as Record<string, import('./fb-cuentas.js').CuentaFB>;
    return Object.values(val).sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));
  } catch (e) {
    console.error('db: leer fb_cuentas fallo', (e as Error)?.message || e);
    return null;
  }
}

/** Guarda (upsert) una cuenta FB. null = sin DB. */
export async function guardarCuentaFB(c: import('./fb-cuentas.js').CuentaFB): Promise<boolean> {
  const base = db();
  if (!base) return false;
  try {
    await base.ref(`fb_cuentas/${c.id}`).set(c);
    return true;
  } catch (e) {
    console.error('db: guardar fb_cuentas fallo', (e as Error)?.message || e);
    return false;
  }
}

/** Borra una cuenta FB por id. null = sin DB. */
export async function borrarCuentaFB(id: string): Promise<boolean> {
  const base = db();
  if (!base) return false;
  try {
    await base.ref(`fb_cuentas/${id}`).remove();
    return true;
  } catch (e) {
    console.error('db: borrar fb_cuentas fallo', (e as Error)?.message || e);
    return false;
  }
}
/** Lee un nodo entero de RTDB (objeto o null si no hay DB/fallo). */
export async function leerNodoFB(nodo: string): Promise<Record<string, any> | null> {
  const base = db();
  if (!base) return null;
  try {
    const snap = await base.ref(nodo).get();
    return snap.exists() ? snap.val() : {};
  } catch (e) {
    console.error(`db: leer ${nodo} fallo`, (e as Error)?.message || e);
    return null;
  }
}

/** Borra eventos con day anterior a hoy-N días. Devuelve cuántos. */
export async function purgarAntiguas(dias = 2): Promise<number> {
  const base = db();
  if (!base) return 0;
  const limite = dayNum(haceDias(dias));
  try {
    const snap = await base.ref('events').orderByChild('dayNum').endAt(limite - 1).get();
    if (!snap.exists()) return 0;
    let n = 0;
    for (const k of Object.keys(snap.val())) {
      await base.ref(`events/${k}`).remove();
      n++;
    }
    return n;
  } catch (e) {
    console.error('db: purga fallo', (e as Error)?.message || e);
    return 0;
  }
}
