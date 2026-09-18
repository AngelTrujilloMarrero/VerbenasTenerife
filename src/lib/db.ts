import admin from 'firebase-admin';
import fs from 'node:fs';
import { claveDe, fusionarDB, type Fusionable } from './dedup.js';
import { esFutura, hoyDMY } from './fechas.js';
import { normTxt } from './municipios.js';
import type { Verbena } from './types.js';

// Persistencia en Realtime Database (proyecto verbenastenerife).
// Técnicas anti-duplicados del proyecto admin (AdminDeBelingo):
// leer-antes-de-escribir, upsert por ID estable con `set` (nunca `push`),
// comparación normalizada NFD y borrado por ID sin rastros.
// Plan B Fase 1: además de por ID se fusiona por CLAVE canónica
// (municipio|day|orquesta), así el mismo baile de dos fuentes colapsa.
// Sin credenciales no rompe nada: avisa una vez y no persiste.
export type EstadoEvento = 'activo' | 'cancelado' | 'aplazado';
export interface EventoDB extends Verbena {
  fuente: string;
  /** Todas las fuentes que han visto este evento (se acumula al fusionar). */
  fuentes: string[];
  /** Clave canónica entre fuentes (ver dedup.ts). */
  clave: string;
  /** Ciclo de vida (Fase 3: cancelaciones). Los listados solo enseñan activos. */
  estado: EstadoEvento;
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

/** Volcado upsert con fusión por clave canónica: solo escribe lo nuevo o
 *  cambiado, y si otra fuente ya guardó el mismo evento lo fusiona en vez
 *  de duplicar. Devuelve stats. */
export async function volcarVerbenas(
  verbenas: Verbena[], fuenteId: string
): Promise<{ leidas: number; escritas: number; fusionadas: number }> {
  const base = db();
  if (!base) return { leidas: 0, escritas: 0, fusionadas: 0 };
  let escritas = 0, fusionadas = 0;
  const ahora = Date.now();
  // Mapa clave->id en memoria: el orderBy+equalTo por REST/Admin exige el
  // índice 'clave' desplegado en consola (si no, "Index not defined" y la
  // fusión entre fuentes muere en silencio). Así no depende de las reglas.
  const porClave = new Map<string, string>();
  try {
    const todo = await base.ref('events').get();
    if (todo.exists()) {
      for (const [id, e] of Object.entries(todo.val() as Record<string, EventoDB>)) {
        if (e?.clave && !porClave.has(e.clave)) porClave.set(e.clave, id);
      }
    }
  } catch (e) {
    console.error('db: precarga de claves fallo', (e as Error)?.message || e);
  }
  for (const v of verbenas) {
    // Solo presente y futuro: lo pasado no entra en la BD.
    if (!esFutura(v.day)) continue;
    try {
      const clave = claveDe(v.municipio, v.day, v.titulo, v.orquestas);
      const nuevo: Fusionable = {
        id: v.id, titulo: v.titulo, day: v.day, hora: v.hora,
        municipio: v.municipio, lugar: v.lugar, orquestas: v.orquestas,
        tipo: v.tipo, url: v.url, score: v.score, motivos: v.motivos,
        fuentes: [fuenteId]
      };
      // 1) ¿Ya existe con este ID?
      const r = base.ref(`events/${v.id}`);
      const snap = await r.get();
      if (snap.exists()) {
        const prev = snap.val() as EventoDB;
        const merged = fusionarDB(
          { ...prev, fuentes: prev.fuentes?.length ? prev.fuentes : [prev.fuente || fuenteId] }, nuevo);
        const doc: EventoDB = { ...v, ...merged, id: v.id, fuente: merged.fuentes[0],
          clave, estado: prev.estado || 'activo',
          actualizadoAt: ahora, dayNum: dayNum(v.day) };
        if (!iguales(snap.val() as Record<string, unknown>, doc as unknown as Record<string, unknown>)) {
          await r.set(doc);
          escritas++;
        }
        continue;
      }
      // 2) ¿Otra fuente lo guardó con otro ID? (misma clave canónica;
      // se busca en el mapa en memoria, sin orderBy por las reglas).
      const otroId = porClave.get(clave);
      if (otroId) {
        const prevSnap = await base.ref(`events/${otroId}`).get();
        if (!prevSnap.exists()) { porClave.delete(clave); }
        else {
          const prev = prevSnap.val() as EventoDB;
          const merged = fusionarDB(
            { ...prev, fuentes: prev.fuentes?.length ? prev.fuentes : [prev.fuente || ''] }, nuevo);
          const doc: EventoDB = { ...prev, ...merged, id: otroId, fuente: merged.fuentes[0],
            clave, estado: prev.estado || 'activo',
            actualizadoAt: ahora, dayNum: dayNum(merged.day) };
          await base.ref(`events/${otroId}`).set(doc);
          escritas++;
          fusionadas++;
          continue;
        }
      }
      // 3) Nuevo de verdad.
      const doc: EventoDB = { ...v, fuente: fuenteId, fuentes: [fuenteId],
        clave, estado: 'activo', actualizadoAt: ahora, dayNum: dayNum(v.day) };
      await r.set(doc);
      if (!porClave.has(clave)) porClave.set(clave, v.id);
      escritas++;
    } catch (e) {
      console.error(`db: volcado ${v.id} fallo`, (e as Error)?.message || e);
    }
  }
  try {
    await base.ref(`meta/${fuenteId}`).set({ at: ahora, eventos: verbenas.length, ok: true });
  } catch (e) {
    console.error('db: meta fallo', (e as Error)?.message || e);
  }
  return { leidas: verbenas.length, escritas, fusionadas };
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
