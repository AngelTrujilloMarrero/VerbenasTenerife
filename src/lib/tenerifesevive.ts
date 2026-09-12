import * as cheerio from 'cheerio';
import { mesANum, tipoDeEvento } from './classifier.js';
import { fetchText } from './http.js';
import { resolverMunicipio } from './municipios.js';
import type { Verbena } from './types.js';

// Tenerife Se Vive (blog WordPress.com): tabla viva de verbenas 2026
// (Fecha | Localidad | Tipo | Orquestas) vía REST pública. Cubre barrios
// que los ayuntamientos no detallan (Chumberas, Abrigos, Fañabé, Vilaflor...).
// Agregador como lagenda: va ÚLTIMO y sus duplicados con ayuntamientos se
// fusionan (gana la fuente oficial). Solo filas con fecha válida.
const POST_URL = 'https://tenerifesevive.wordpress.com/2026/09/08/verbenas-tenerife/';
const REST = 'https://public-api.wordpress.com/wp/v2/sites/tenerifesevive.wordpress.com/posts?slug=verbenas-tenerife';
export const TENERIFESEVIVE_URL = POST_URL;

const MES_ABBR: Record<string, string> = {
  ene: '01', feb: '02', mar: '03', abr: '04', may: '05', jun: '06',
  jul: '07', ago: '08', sep: '09', oct: '10', nov: '11', dic: '12'
};

let cache: { at: number; data: Verbena[] } | null = null;
const TTL = 1000 * 60 * 60;

function sinHtml(s: string): string {
  return (s || '').replace(/\s+/g, ' ').trim();
}

/** "Las Chumberas, La Laguna" -> municipio por la última parte ("La Laguna");
 *  "Tejina de Guía, Guía de Isora" -> "Guía de Isora" (no Tegueste).
 *  "Santa Cruz" a secas es la capital: el token "cruz" resolvería a
 *  Puerto de la Cruz (primero en la lista). */
function municipioDe(localidad: string): string | null {
  if (/santa\s+cruz/i.test(localidad) && !/puerto/i.test(localidad)) return 'Santa Cruz de Tenerife';
  const partes = localidad.split(',');
  for (let i = partes.length - 1; i >= 0; i--) {
    const m = resolverMunicipio(partes[i]);
    if (m) return m;
  }
  return resolverMunicipio(localidad);
}

function lugarDe(localidad: string): string {
  const partes = localidad.split(',').map((p) => p.trim()).filter(Boolean);
  return partes.length > 1 ? partes[0] : localidad.trim();
}

export async function obtenerVerbenasTenerifeSeVive(): Promise<Verbena[]> {
  if (cache && Date.now() - cache.at < TTL) return cache.data;
  const verbenas: Verbena[] = [];

  const j = JSON.parse(await fetchText(REST));
  const post = Array.isArray(j) ? j[0] : j;
  const html: string = post?.content?.rendered || '';
  if (!html) {
    cache = { at: Date.now(), data: verbenas };
    return verbenas;
  }

  const $ = cheerio.load(html);
  // Recorre en orden: el mes vigente lo fija el encabezado previo
  // ("Septiembre 2026", "Octubre 2026") y vale para la tabla siguiente.
  let mes = '', anyo = '';
  const cuerpos = $('body').find('h1, h2, h3, h4, p, table').toArray();
  for (const el of cuerpos) {
    const tag = (el as any).tagName?.toLowerCase() || '';
    const txt = sinHtml($(el).text());
    if (tag !== 'table') {
      const m = txt.match(/(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\s+(20\d{2})/i);
      if (m) {
        mes = mesANum(m[1]);
        anyo = m[2];
      }
      continue;
    }
    if (!mes || !anyo) continue;
    $(el).find('tr').each((_, tr) => {
      const celdas = $(tr).find('td').toArray().map((td) => sinHtml($(td).text()));
      if (celdas.length < 4) return;
      const [fecha, localidad, tipo, orqs] = celdas;
      if (/fecha/i.test(fecha)) return; // cabecera
      const mDia = fecha.match(/(\d{1,2})\s*(ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic)?/i);
      if (!mDia) return;
      const mesFila = mDia[2] ? (MES_ABBR[mDia[2].toLowerCase()] || mes) : mes;
      const day = `${mDia[1].padStart(2, '0')}-${mesFila}-${anyo}`;
      const municipio = municipioDe(localidad);
      if (!municipio) return;
      const orquestas = /cartel por confirmar/i.test(orqs)
        ? []
        : orqs.split('+').map((o) => o.trim()).filter((o) => o.length > 2);
      const titulo = `${tipo || 'Verbena'} en ${lugarDe(localidad)}`;
      const score = orquestas.length ? 5 : 3;
      verbenas.push({
        id: `tenerifesevive-${day}-${titulo.split(/\s+/).slice(0, 3).join(' ')}`.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9-]+/g, '-'),
        titulo, day, hora: '', municipio,
        lugar: lugarDe(localidad), orquestas,
        tipo: tipoDeEvento(tipo), url: POST_URL,
        score, motivos: [`tabla ${mesFila}-${anyo} Tenerife Se Vive`]
      });
    });
  }

  cache = { at: Date.now(), data: verbenas };
  return verbenas;
}
