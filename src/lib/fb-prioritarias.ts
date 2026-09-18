// Sili García y La Ruta del Cherne como FUENTES de primer nivel (como una
// web de ayuntamiento): leen de Firebase los eventos que el monitor de
// Facebook ya verificó y dio de alta (scripts/revision-auto.mjs), filtrados
// por la URL del post (contiene el handle). Van las ÚLTIMAS en FUENTES para
// que ante duplicados gane la fuente oficial (ayuntamiento/agregador) y se
// fusionen hora/orquestas/motivos.
import { esFutura } from './fechas.js';
import type { Verbena } from './types.js';

export const SILI_GARCIA_URL = 'https://www.facebook.com/sili.garcia';
export const RUTA_CHERNE_URL = 'https://www.facebook.com/larutadelcherne';
export const SILI_GARCIA_HANDLE = 'sili.garcia';
export const RUTA_CHERNE_HANDLE = 'larutadelcherne';

function dbUrl(): string {
  const u =
    (typeof process !== 'undefined' && process.env?.PUBLIC_FIREBASE_DATABASE_URL) ||
    (import.meta.env?.PUBLIC_FIREBASE_DATABASE_URL as string) ||
    '';
  return String(u || '').replace(/\/$/, '');
}

interface EventoFB {
  id?: string;
  titulo?: string;
  day?: string;
  hora?: string;
  municipio?: string;
  lugar?: string;
  orquestas?: string[];
  tipo?: string;
  url?: string;
  score?: number;
  motivos?: string[];
  estado?: string;
}

const cache = new Map<string, { at: number; data: Verbena[] }>();
const TTL = 1000 * 60 * 60; // 1h, como los adaptadores web

async function eventosPorHandle(handle: string): Promise<Verbena[]> {
  const hit = cache.get(handle);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  const verbenas: Verbena[] = [];
  try {
    const base = dbUrl();
    if (!base) return verbenas;
    const r = await fetch(`${base}/events.json`, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`HTTP ${r.status} en events.json`);
    const todo = (await r.json()) as Record<string, EventoFB>;
    for (const [id, e] of Object.entries(todo || {})) {
      if (!e || typeof e !== 'object') continue;
      if (!String(e.url || '').toLowerCase().includes('/' + handle)) continue;
      if ((e.estado || 'activo') !== 'activo') continue;
      if (e.day && !esFutura(e.day)) continue;
      verbenas.push({
        id: String((e as { id?: string }).id || id),
        titulo: String(e.titulo || 'Verbena'),
        day: String(e.day || ''),
        hora: String(e.hora || ''),
        municipio: String(e.municipio || ''),
        lugar: String(e.lugar || ''),
        orquestas: Array.isArray(e.orquestas) ? e.orquestas : [],
        tipo: String(e.tipo || 'Baile Normal'),
        url: String(e.url || ''),
        score: Number(e.score ?? 4),
        motivos: Array.isArray(e.motivos) ? e.motivos : []
      });
    }
  } catch (e) {
    console.error(`fuente facebook ${handle} falló:`, (e as Error)?.message || e);
  }
  verbenas.sort((a, b) => `${a.day} ${a.hora}`.localeCompare(`${b.day} ${b.hora}`));
  cache.set(handle, { at: Date.now(), data: verbenas });
  return verbenas;
}

/** Eventos verificados de Sili García (posts de su agenda semanal). */
export async function obtenerVerbenasSiliGarcia(): Promise<Verbena[]> {
  return eventosPorHandle(SILI_GARCIA_HANDLE);
}

/** Eventos verificados de La Ruta del Cherne. */
export async function obtenerVerbenasRutaCherne(): Promise<Verbena[]> {
  return eventosPorHandle(RUTA_CHERNE_HANDLE);
}
