import { ADEJE_URL, obtenerVerbenasAdeje } from './adeje.js';
import { ARICO_URL, obtenerVerbenasArico } from './arico.js';
import { ARONA_URL, obtenerVerbenasArona } from './arona.js';
import { ELROSARIO_URL, obtenerVerbenasElRosario } from './elrosario.js';
import { FASNIA_URL, obtenerVerbenasFasnia } from './fasnia.js';
import { GRANADILLA_URL, obtenerVerbenasGranadilla } from './granadilla.js';
import { GUIADEISORA_URL, obtenerVerbenasGuiaDeIsora } from './guiadeisora.js';
import { ICODVINOS_URL, obtenerVerbenasIcodVinos } from './icodvinos.js';
import { LOSSILOS_URL, obtenerVerbenasLosSilos } from './lossilos.js';
import { BUENAVISTA_URL, obtenerVerbenasBuenavista } from './buenavista.js';
import { LAOROTAVA_URL, obtenerVerbenasLaOrotava } from './laorotava.js';
import { LOSREALEJOS_URL, obtenerVerbenasLosRealejos } from './losrealejos.js';
import { GUIMAR_URL, obtenerVerbenasGuimar } from './guimar.js';
import { CANDELARIA_URL, obtenerVerbenasCandelaria } from './candelaria.js';
import { ELSAUZAL_URL, obtenerVerbenasElSauzal } from './elsauzal.js';
import { SANTAURSULA_URL, obtenerVerbenasSantaUrsula } from './santaursula.js';
import { LAGENDA_URL, obtenerVerbenasLagenda } from './lagenda.js';
import { TENERIFESEVIVE_URL, obtenerVerbenasTenerifeSeVive } from './tenerifesevive.js';
import { CANARIASFIESTAS_URL, obtenerVerbenasCanariasFiestas } from './canariasfiestas.js';
import { LALAGUNA_URL, obtenerVerbenasLaLaguna } from './lalaguna.js';
import { SANTACRUZ_URL, obtenerVerbenasSantaCruz } from './santacruz.js';
import { SANJUANRAMBLA_URL, obtenerVerbenasSanJuanRambla } from './sanjuanrambla.js';
import { TACORONTE_URL, obtenerVerbenasTacoronte } from './tacoronte.js';
import { TEGUESTE_URL, obtenerVerbenasTegueste } from './tegueste.js';
import { normTxt } from './municipios.js';
import { avisar } from './avisos.js';
import { porFecha, type Fuente, type Verbena } from './types.js';

// Registro de fuentes. Añadir un municipio = 1 línea + su adaptador.
// Escala a 31 sin tocar API ni página. Los agregadores van ÚLTIMOS (lagenda,
// tenerifesevive, canariasfiestas): sus duplicados con ayuntamientos se
// descartan (gana la fuente oficial).
export const FUENTES: Fuente[] = [
  { id: 'arona', nombre: 'Arona', agendaUrl: ARONA_URL, obtener: obtenerVerbenasArona },
  { id: 'adeje', nombre: 'Adeje', agendaUrl: ADEJE_URL, obtener: obtenerVerbenasAdeje },
  { id: 'elrosario', nombre: 'El Rosario', agendaUrl: ELROSARIO_URL, obtener: obtenerVerbenasElRosario },
  { id: 'tegueste', nombre: 'Tegueste', agendaUrl: TEGUESTE_URL, obtener: obtenerVerbenasTegueste },
  { id: 'lalaguna', nombre: 'La Laguna', agendaUrl: LALAGUNA_URL, obtener: obtenerVerbenasLaLaguna },
  { id: 'guiadeisora', nombre: 'Guía de Isora', agendaUrl: GUIADEISORA_URL, obtener: obtenerVerbenasGuiaDeIsora },
  { id: 'granadilla', nombre: 'Granadilla de Abona', agendaUrl: GRANADILLA_URL, obtener: obtenerVerbenasGranadilla },
  { id: 'santacruz', nombre: 'Santa Cruz de Tenerife', agendaUrl: SANTACRUZ_URL, obtener: obtenerVerbenasSantaCruz },
  { id: 'arico', nombre: 'Arico', agendaUrl: ARICO_URL, obtener: obtenerVerbenasArico },
  { id: 'fasnia', nombre: 'Fasnia', agendaUrl: FASNIA_URL, obtener: obtenerVerbenasFasnia },
  { id: 'tacoronte', nombre: 'Tacoronte', agendaUrl: TACORONTE_URL, obtener: obtenerVerbenasTacoronte },
  { id: 'sanjuanrambla', nombre: 'San Juan de la Rambla', agendaUrl: SANJUANRAMBLA_URL, obtener: obtenerVerbenasSanJuanRambla },
  { id: 'icodvinos', nombre: 'Icod de los Vinos', agendaUrl: ICODVINOS_URL, obtener: obtenerVerbenasIcodVinos },
  { id: 'lossilos', nombre: 'Los Silos', agendaUrl: LOSSILOS_URL, obtener: obtenerVerbenasLosSilos },
  { id: 'buenavista', nombre: 'Buenavista del Norte', agendaUrl: BUENAVISTA_URL, obtener: obtenerVerbenasBuenavista },
  { id: 'laorotava', nombre: 'La Orotava', agendaUrl: LAOROTAVA_URL, obtener: obtenerVerbenasLaOrotava },
  { id: 'losrealejos', nombre: 'Los Realejos', agendaUrl: LOSREALEJOS_URL, obtener: obtenerVerbenasLosRealejos },
  { id: 'guimar', nombre: 'Güímar', agendaUrl: GUIMAR_URL, obtener: obtenerVerbenasGuimar },
  { id: 'candelaria', nombre: 'Candelaria', agendaUrl: CANDELARIA_URL, obtener: obtenerVerbenasCandelaria },
  { id: 'elsauzal', nombre: 'El Sauzal', agendaUrl: ELSAUZAL_URL, obtener: obtenerVerbenasElSauzal },
  { id: 'santaursula', nombre: 'Santa Úrsula', agendaUrl: SANTAURSULA_URL, obtener: obtenerVerbenasSantaUrsula },
  { id: 'lagenda', nombre: 'Lagenda', agendaUrl: LAGENDA_URL, obtener: obtenerVerbenasLagenda },
  { id: 'tenerifesevive', nombre: 'TenerifeSeVive', agendaUrl: TENERIFESEVIVE_URL, obtener: obtenerVerbenasTenerifeSeVive },
  { id: 'canariasfiestas', nombre: 'CanariasFiestas', agendaUrl: CANARIASFIESTAS_URL, obtener: obtenerVerbenasCanariasFiestas }
];

export type { Verbena };

/** Último resultado por fuente (para el monitor /api/estado.json). */
export const estadoFuentes: Record<string, { at: number; eventos: number; ok: boolean }> = {};

const STOPW = new Set(['de', 'la', 'el', 'las', 'los', 'del', 'en', 'con', 'por', 'una', 'uno', 'y', 'al', 'fin', 'gran', 'san', 'santa',
  // Genéricos musicales: "orquesta" en común NO significa mismo baile
  // (Kadetes 22:30 vs Acapulco 22:30). "Popular" sí se conserva.
  'orquesta', 'orquestas', 'grupo', 'grupos', 'amenizado', 'amenizada', 'amenizados', 'amenizadas',
  // Lugares genéricos: dos bailes en la misma plaza NO son el mismo baile.
  // (Solo cuentan para el veto por lugar distinto, no para el solape.)
  'plaza', 'calle', 'parque', 'teatro', 'iglesia', 'avenida', 'recinto', 'cancha',
  'auditorio', 'ermita', 'parroquia', 'plazoleta', 'pabellon', 'campo', 'puente']);

function toks(s: string): Set<string> {
  return new Set(normTxt(s).split(' ').filter((w) => w.length > 3 && !STOPW.has(w)));
}

/** Lugar normalizado (sin ", Municipio"); '' si es el fallback = municipio. */
function normLugar(v: Verbena): string {
  return normTxt(v.lugar.replace(new RegExp(',?\\s*' + v.municipio + '$', 'i'), '')).trim();
}

/** ¿Es `b` la misma verbena ya vista en `a`? Mismo municipio+día y
 *  (orquesta común o ≥2 palabras del título). Con lugares reales distintos
 *  se veta salvo solape fuerte (orquesta o ≥3 palabras). Y con cartel
 *  distinto en ambos (orquestas disjuntas no vacías) nunca se fusiona:
 *  dos bailes pueden compartir noche y plaza. */
function esDuplicada(a: Verbena, b: Verbena): boolean {
  if (normTxt(a.municipio) !== normTxt(b.municipio)) return false;
  if (!a.day || a.day !== b.day) return false;
  const ta = toks(a.titulo), tb = toks(b.titulo);
  let comunes = 0;
  for (const w of ta) if (tb.has(w)) comunes++;
  const oa = toks((a.orquestas || []).join(' ')), ob = toks((b.orquestas || []).join(' '));
  let orqs = 0;
  for (const w of oa) if (ob.has(w)) orqs++;
  const aOrq = (a.orquestas || []).length > 0, bOrq = (b.orquestas || []).length > 0;
  if (aOrq && bOrq && orqs === 0 && comunes < 3) return false;
  const la = normLugar(a), lb = normLugar(b);
  if (la && lb && la !== lb && !(orqs >= 1 || comunes >= 3)) return false;
  return orqs >= 1 || comunes >= 2;
}

/** Fusiona duplicados: prefiere la que tiene hora, une orquestas, motivos y mejor score. */
function fusionar(a: Verbena, b: Verbena): Verbena {
  const conHora = a.hora ? a : b.hora ? b : a;
  const otra = conHora === a ? b : a;
  const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const orq = [...conHora.orquestas];
  for (const o of otra.orquestas) {
    if (!orq.some((x) => norm(x) === norm(o))) orq.push(o);
  }
  return { ...conHora, orquestas: orq, score: Math.max(a.score, b.score),
    motivos: [...new Set([...a.motivos, ...b.motivos])] };
}

/** Agrega todas las fuentes en paralelo; si una falla, las demás siguen.
 *  Deduplica en general (prosa+agenda del mismo programa, lagenda vs
 *  ayuntamientos): gana la primera fuente, fusionando hora/orquestas. */
export async function obtenerVerbenas(municipio?: string): Promise<Verbena[]> {
  const fuentes = municipio
    ? FUENTES.filter((f) => f.id === municipio.toLowerCase())
    : FUENTES;
  const res = await Promise.allSettled(fuentes.map((f) => f.obtener()));
  const todas: Verbena[] = [];
  res.forEach((r, i) => {
    if (r.status !== 'fulfilled') {
      console.error(`fuente ${fuentes[i].id} falló:`, r.reason);
      avisar(fuentes[i].nombre, 'fuente-fallo', fuentes[i].agendaUrl, String(r.reason?.message || r.reason || 'error').slice(0, 120));
      estadoFuentes[fuentes[i].id] = { at: Date.now(), eventos: 0, ok: false };
      return;
    }
    estadoFuentes[fuentes[i].id] = { at: Date.now(), eventos: r.value.length, ok: true };
    for (const v of r.value) {
      const dup = todas.findIndex((t) => esDuplicada(t, v));
      if (dup === -1) {
        todas.push(v);
      } else {
        todas[dup] = fusionar(todas[dup], v);
        if (fuentes[i].id === 'lagenda') {
          console.log(`lagenda duplicada (fusionada): ${v.day} ${v.titulo.slice(0, 50)}`);
        }
      }
    }
  });
  return todas.sort(porFecha);
}
