// Clave canónica de evento para deduplicar ENTRE fuentes y en el tiempo.
// El mismo baile visto por ayuntamiento, lagenda y Facebook debe colapsar en
// una sola fila: la clave no depende del origen, solo de municipio + día +
// orquesta principal (o slug del título si no hay orquesta).
// Fase 1 del Plan B (ver PLANES.txt).
import { normTxt } from './municipios.js';
import HIST from './data/orquestas.json';

const ORQ_HIST: { nombre: string; n: number }[] =
  (HIST as { orquestas: { nombre: string; n: number }[] }).orquestas;

const STOP = new Set(['de', 'la', 'el', 'las', 'los', 'del', 'en', 'con', 'por',
  'una', 'uno', 'y', 'al', 'fin', 'gran', 'san', 'santa', 'fiesta', 'fiestas',
  'baile', 'verbena', 'orquesta', 'orquestas', 'grupo', 'grupos', 'plaza',
  'parque', 'recinto', 'el', 'la']);

const alnum = (s: string): string => normTxt(s).replace(/[^a-z0-9]/g, '');

/** Primera orquesta histórica mencionada (o primera sin más), normalizada. */
export function orquestaPrincipal(orquestas: string[], titulo = ''): string {
  const hay = normTxt([...orquestas, titulo].join(' '));
  for (const { nombre } of ORQ_HIST) {
    const low = normTxt(nombre);
    if (!low) continue;
    if (low.includes(' ') ? ` ${hay} `.includes(` ${low} `) : ` ${hay} `.split(' ').includes(low)) {
      return alnum(nombre);
    }
  }
  return orquestas.length ? alnum(orquestas[0]).slice(0, 24) : '';
}

/** Slug con las primeras palabras significativas del título. */
export function slugTitulo(titulo: string, n = 5): string {
  return normTxt(titulo).split(' ').filter((w) => w.length > 2 && !STOP.has(w)).slice(0, n).join('-');
}

/** municipio|day|orquesta-o-slug. Estable entre fuentes y pasadas. */
export function claveDe(municipio: string, day: string, titulo: string, orquestas: string[] = []): string {
  const m = normTxt(municipio).replace(/ /g, '');
  const base = orquestaPrincipal(orquestas, titulo) || slugTitulo(titulo);
  return `${m}|${day}|${base}`;
}

export interface Fusionable {
  id: string;
  titulo: string;
  day: string;
  hora: string;
  municipio: string;
  lugar: string;
  orquestas: string[];
  tipo: string;
  url: string;
  score: number;
  motivos: string[];
  fuentes: string[];
}

/** Fusiona `b` en `a` (conserva id de `a`): hora más precisa, unión de
 *  orquestas/motivos/fuentes, mejor score. Misma semántica que fusionar()
 *  de verbenas.ts pero persistente y multi-fuente. */
export function fusionarDB(a: Fusionable, b: Fusionable): Fusionable {
  const conHora = a.hora ? a : b.hora ? b : a;
  const otra = conHora === a ? b : a;
  const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const orq = [...conHora.orquestas];
  for (const o of otra.orquestas) {
    if (!orq.some((x) => norm(x) === norm(o))) orq.push(o);
  }
  const fuentes = [...conHora.fuentes];
  for (const f of otra.fuentes) if (!fuentes.includes(f)) fuentes.push(f);
  const titulo = conHora.titulo.length >= otra.titulo.length ? conHora.titulo : otra.titulo;
  return {
    ...conHora, titulo, orquestas: orq, fuentes,
    lugar: conHora.lugar || otra.lugar,
    url: conHora.url || otra.url,
    score: Math.max(a.score, b.score),
    motivos: [...new Set([...a.motivos, ...b.motivos])]
  };
}
