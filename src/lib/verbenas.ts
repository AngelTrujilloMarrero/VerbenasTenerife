import { ADEJE_URL, obtenerVerbenasAdeje } from './adeje.js';
import { ARONA_URL, obtenerVerbenasArona } from './arona.js';
import { GUIADEISORA_URL, obtenerVerbenasGuiaDeIsora } from './guiadeisora.js';
import { LAGENDA_URL, obtenerVerbenasLagenda } from './lagenda.js';
import { LALAGUNA_URL, obtenerVerbenasLaLaguna } from './lalaguna.js';
import { TEGUESTE_URL, obtenerVerbenasTegueste } from './tegueste.js';
import { normTxt } from './municipios.js';
import { porFecha, type Fuente, type Verbena } from './types.js';

// Registro de fuentes. Añadir un municipio = 1 línea + su adaptador.
// Escala a 31 sin tocar API ni página. Lagenda va ÚLTIMA: es agregador y
// sus duplicados con ayuntamientos se descartan (gana la fuente oficial).
export const FUENTES: Fuente[] = [
  { id: 'arona', nombre: 'Arona', agendaUrl: ARONA_URL, obtener: obtenerVerbenasArona },
  { id: 'adeje', nombre: 'Adeje', agendaUrl: ADEJE_URL, obtener: obtenerVerbenasAdeje },
  { id: 'tegueste', nombre: 'Tegueste', agendaUrl: TEGUESTE_URL, obtener: obtenerVerbenasTegueste },
  { id: 'lalaguna', nombre: 'La Laguna', agendaUrl: LALAGUNA_URL, obtener: obtenerVerbenasLaLaguna },
  { id: 'guiadeisora', nombre: 'Guía de Isora', agendaUrl: GUIADEISORA_URL, obtener: obtenerVerbenasGuiaDeIsora },
  { id: 'lagenda', nombre: 'Lagenda', agendaUrl: LAGENDA_URL, obtener: obtenerVerbenasLagenda }
];

export type { Verbena };

const STOPW = new Set(['de', 'la', 'el', 'las', 'los', 'del', 'en', 'con', 'por', 'una', 'uno', 'y', 'al', 'fin', 'gran', 'san', 'santa']);

function toks(s: string): Set<string> {
  return new Set(normTxt(s).split(' ').filter((w) => w.length > 3 && !STOPW.has(w)));
}

/** ¿Es `b` la misma verbena ya vista en `a`? Mismo municipio+día y
 *  (misma hora con solape, u orquesta común, o ≥2 palabras del título). */
function esDuplicada(a: Verbena, b: Verbena): boolean {
  if (normTxt(a.municipio) !== normTxt(b.municipio)) return false;
  if (!a.day || a.day !== b.day) return false;
  const ta = toks(a.titulo), tb = toks(b.titulo);
  let comunes = 0;
  for (const w of ta) if (tb.has(w)) comunes++;
  const oa = toks((a.orquestas || []).join(' ')), ob = toks((b.orquestas || []).join(' '));
  let orqs = 0;
  for (const w of oa) if (ob.has(w)) orqs++;
  if (orqs >= 1 || comunes >= 2) return true;
  return !!a.hora && a.hora === b.hora && (comunes >= 1 || (!ta.size && !tb.size));
}

/** Agrega todas las fuentes en paralelo; si una falla, las demás siguen.
 *  Lagenda solo APORTA lo que no esté ya cubierto por un ayuntamiento. */
export async function obtenerVerbenas(municipio?: string): Promise<Verbena[]> {
  const fuentes = municipio
    ? FUENTES.filter((f) => f.id === municipio.toLowerCase())
    : FUENTES;
  const res = await Promise.allSettled(fuentes.map((f) => f.obtener()));
  const todas: Verbena[] = [];
  res.forEach((r, i) => {
    if (r.status !== 'fulfilled') {
      console.error(`fuente ${fuentes[i].id} falló:`, r.reason);
      return;
    }
    for (const v of r.value) {
      if (fuentes[i].id === 'lagenda' && todas.some((t) => esDuplicada(t, v))) {
        console.log(`lagenda duplicada (gana ayuntamiento): ${v.day} ${v.titulo.slice(0, 50)}`);
        continue;
      }
      todas.push(v);
    }
  });
  return todas.sort(porFecha);
}
