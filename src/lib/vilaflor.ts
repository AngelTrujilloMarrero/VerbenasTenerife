import { fetchText } from './http.js';
import { avisar } from './avisos.js';
import type { Verbena } from './types.js';

// Vilaflor de Chasna: web municipal obsoleta para fiestas (portal de
// trámites sin noticias ni agenda; igual que Guía de Isora y Los Silos,
// que ya viven de agregadores). Adaptador PREPARADO: mantiene la entrada
// en FUENTES (chips, monitor, coords) y deja el gancho `fuentesAlternativas`
// para cuando inventemos de dónde tirar (Facebook/Instagram con login,
// scraping de carteles, etc.). Hoy los eventos llegan vía agregadores
// (TenerifeSeVive); si la web revive, el rastreo genérico los coge solo.
const BASE = 'https://www.vilaflor.es';
export const VILAFLOR_URL = `${BASE}/`;

const MUNI = 'Vilaflor';

let cache: { at: number; data: Verbena[] } | null = null;
const TTL = 1000 * 60 * 60;

interface FuenteAlternativa {
  id: string;
  // Poned aquí cada fuente nueva que inventemos: debe devolver verbenas
  // con el formato de `types.ts` (id, titulo, day dd-mm-yyyy, hora,
  // municipio, lugar, orquestas, tipo, url, score, motivos).
  obtener: () => Promise<Verbena[]>;
}

/** Gancho para fuentes alternativas (hoy vacío a propósito). */
async function fuentesAlternativas(): Promise<Verbena[]> {
  const fuentes: FuenteAlternativa[] = [
    // Ejemplo futuro:
    // { id: 'vilaflor-facebook', obtener: obtenerVerbenasVilaflorFacebook },
  ];
  const verbenas: Verbena[] = [];
  for (const f of fuentes) {
    try {
      for (const v of await f.obtener()) {
        if (!verbenas.some((x) => x.id === v.id)) verbenas.push(v);
      }
    } catch (e) {
      console.error(`vilaflor alternativa ${f.id} fallo`, e);
    }
  }
  return verbenas;
}

export async function obtenerVerbenasVilaflor(): Promise<Verbena[]> {
  if (cache && Date.now() - cache.at < TTL) return cache.data;
  const verbenas = await fuentesAlternativas();

  // Rastreo genérico por si la web revive (enlaces con año vigente a
  // programas o fiestas). Barato: solo portada.
  try {
    const html = await fetchText(BASE + '/');
    const vigente = String(new Date().getFullYear());
    const re = /<a[^>]+href=["']([^"']+)["\'][^>]*>(.*?)<\/a>/gis;
    let m: RegExpExecArray | null;
    let n = 0;
    while ((m = re.exec(html)) !== null && n < 3) {
      const href = (m[1] || '').trim();
      const texto = (m[2] || '').replace(/<[^>]+>/g, ' ');
      if (!/programa|fiesta|verbena|romer/i.test(href + ' ' + texto)) continue;
      if (!href.includes(vigente)) continue;
      n++;
      avisar(MUNI, 'programa-pdf', href.startsWith('http') ? href : BASE + href, 'posible programa en web revivida');
    }
  } catch (e) {
    console.error('vilaflor rastreo fallo', e);
  }

  if (verbenas.length === 0) {
    avisar(MUNI, 'sin-eventos', VILAFLOR_URL, 'web obsoleta: eventos vía agregadores (ver TenerifeSeVive)');
  }

  cache = { at: Date.now(), data: verbenas };
  return verbenas;
}
