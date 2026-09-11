import * as cheerio from 'cheerio';
import {
  clasificarDetalle,
  clasificarTitulo,
  esContenedor,
  extraerBailesSinHora,
  extraerSubEventos,
  horaPrevia,
  lugarCercano,
  mesANum,
  mesContexto,
  normalizarHoras,
  partirPorDias,
  tipoDeEvento,
  ventana
} from './classifier.js';
import { fetchText, textoConSaltos } from './http.js';
import { textoOcr } from './ocr.js';
import type { Verbena } from './types.js';

const BASE = 'https://www.ayuntamientodearico.com';
export const ARICO_URL = `${BASE}/category/fiestas/`;

const MUNI = 'Arico';
const NUCLEOS = ['Villa de Arico', 'Arico Viejo', 'Punta de Abona', 'La Sabinita', 'El Río'];

let cache: { at: number; data: Verbena[] } | null = null;
const TTL = 1000 * 60 * 60;
const PAUSA_MS = 1200;
const MAX_DETALLES = 8;

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Candidato { titulo: string; url: string }

/** Descubre posts en portada, categoría de fiestas y buscador WP (?s=). */
async function descubrir(): Promise<Candidato[]> {
  const out: Candidato[] = [];
  const seen = new Set<string>();
  const mete = (titulo: string, url: string) => {
    const t = titulo.trim().replace(/\s+/g, ' ');
    if (!t || t.length < 15 || seen.has(url)) return;
    if (!clasificarTitulo(t).esVerbena && !esContenedor(t)) return;
    seen.add(url);
    out.push({ titulo: t, url });
  };
  const paginas = [`${BASE}/`, `${BASE}/category/fiestas/`, `${BASE}/?s=verbena`, `${BASE}/?s=fiestas`];
  for (const page of paginas) {
    try {
      const html = await fetchText(page);
      const $ = cheerio.load(html);
      $('a[href]').each((_, a) => {
        let href = $(a).attr('href') || '';
        if (!href.startsWith(BASE + '/') && href.startsWith('/')) href = BASE + href;
        if (!href.startsWith(BASE + '/') || href === BASE + '/') return;
        if (/\.(pdf|jpg|jpeg|png|webp)$/i.test(href.split('?')[0])) return;
        mete($(a).text(), href);
      });
    } catch { /* sigue con la siguiente página */ }
    if (out.length >= MAX_DETALLES) break;
  }
  return out.slice(0, MAX_DETALLES);
}

/** Año de publicación del post ("Fecha de publicación: ... 2024"), o null.
 *  Sin esto los posts de 2024 (URL sin año) se fechaban con el año actual. */
function anyoPublicacion(html: string): number | null {
  const m = html.match(/Fecha de publicaci[oó]n[\s\S]{0,400}?(20\d{2})/i);
  return m ? Number(m[1]) : null;
}

/** Año del slug (…-2026), si no de la fecha de publicación, si no el actual. */
function anyoDe(html: string, url: string): string {
  const mSlug = url.match(/(20\d{2})/);
  if (mSlug) return mSlug[1];
  const pub = anyoPublicacion(html);
  if (pub) return String(pub);
  const mTime = html.match(/datetime="(20\d{2})-\d{2}-\d{2}/);
  if (mTime) return mTime[1];
  return String(new Date().getFullYear());
}

function nucleoDe(texto: string): string {
  const low = texto.toLowerCase();
  for (const n of NUCLEOS) if (low.includes(n.toLowerCase())) return n;
  return '';
}

/** Programas publicados solo como imágenes: el texto OCR vive en
 *  src/lib/data/ocr-programas.json (generado por scripts/ocr-programas.mjs). */
function programasPendientes(html: string, url: string): void {
  const imgs = html.match(/PROGRAMA[^"']*?[_-]page-\d+\.(?:jpg|jpeg|png|webp)/gi);
  if (imgs && imgs.length > 2 && !textoOcr('arico')) {
    console.warn(`arico programa solo-imagen (${imgs.length} págs) sin OCR: ${url}`);
  }
}

export async function obtenerVerbenasArico(): Promise<Verbena[]> {
  if (cache && Date.now() - cache.at < TTL) return cache.data;
  const verbenas: Verbena[] = [];
  const push = (v: Verbena) => {
    // Evita duplicados del mismo acto entre noticia y OCR (mismo día y lineup).
    const dup = verbenas.some((x) =>
      x.id === v.id ||
      (x.day === v.day && x.hora === v.hora &&
        x.orquestas.length > 0 && v.orquestas.length > 0 &&
        x.orquestas.some((o) => v.orquestas.includes(o))));
    if (!dup) verbenas.push(v);
  };

  /** Parte un texto (noticia o programa OCR) por días y extrae verbenas. */
  const procesar = (cuerpo: string, opts: { anyo: string; slug: string; url: string; etiqueta: string }) => {
    const ctx = mesContexto(cuerpo);
    const ref = ctx.mes && opts.anyo ? { mes: ctx.mes, anyo: opts.anyo } : undefined;
    const lugar = lugarCercano(cuerpo.slice(0, 2000), opts.etiqueta) || nucleoDe(cuerpo) || MUNI;
    // La prosa solo nombra el mes la primera vez ("...13 de agosto... sábado
    // 5 se celebrará..."). Se hereda del encabezado anterior.
    let mesPrev = '', anyoPrev = '';
    for (const sec of partirPorDias(cuerpo, ref)) {
      if (sec.mes) mesPrev = sec.mes;
      if (sec.anyo) anyoPrev = sec.anyo;
      const mes = mesANum(sec.mes) || mesANum(mesPrev) || ctx.mes;
      if (!mes) continue;
      const day = `${String(sec.dia).padStart(2, '0')}-${mes}-${sec.anyo || anyoPrev || opts.anyo}`;
      const lineas = [
        ...extraerSubEventos(sec.texto).map((s) => ({ titulo: s.titulo, hora: s.hora, orquestas: s.orquestas, extra: 0 })),
        ...extraerBailesSinHora(sec.texto).map((s) => ({ titulo: s.titulo, hora: s.hora || horaPrevia(sec.texto, s.titulo), orquestas: s.orquestas, extra: s.explicita ? 2 : 0 }))
      ];
      for (const l of lineas) {
        const lugarLinea = lugarCercano(sec.texto, l.titulo) || lugar;
        const cls = clasificarDetalle(l.titulo, ventana(sec.texto, l.titulo, 400), l.hora, lugarLinea, l.extra);
        if (!cls.esVerbena) continue;
        push({
          id: `arico-${opts.slug.slice(0, 20)}-${l.hora.replace(':', '') || 'sh'}-${day}-${l.titulo.split(/\s+/).slice(0, 3).join(' ')}`.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9-]+/g, '-'),
          titulo: l.titulo, day, hora: l.hora, municipio: MUNI,
          lugar: lugarLinea, orquestas: l.orquestas,
          tipo: tipoDeEvento(l.titulo), url: opts.url,
          score: cls.score, motivos: [...cls.motivos, opts.etiqueta]
        });
      }
    }
  };

  let items: Candidato[] = [];
  try {
    items = await descubrir();
  } catch (e) {
    console.error('arico índice fallo', e);
  }

  for (const it of items) {
    try {
      await espera(PAUSA_MS);
      const d = await fetchText(it.url);
      // Filtro de vigencia: la agenda de Arico reutiliza slugs sin año, así que
      // los programas de 2024 se colaban fechados en 2026. Se descarta lo viejo.
      const pub = anyoPublicacion(d);
      if (pub && pub < new Date().getFullYear()) {
        console.warn(`arico post antiguo (${pub}) descartado: ${it.url}`);
        continue;
      }
      programasPendientes(d, it.url);
      const cuerpo = normalizarHoras(textoConSaltos(d));
      const anyo = anyoDe(d, it.url);
      const slug = it.url.split('/').filter(Boolean).pop() || 'noticia';
      procesar(cuerpo, { anyo, slug, url: it.url, etiqueta: `noticia: ${it.titulo.slice(0, 50)}` });
    } catch (e) {
      console.error('arico detalle fallo', it.url, e);
    }
  }

  // Programa publicado solo como imágenes (OCR cacheado, ver scripts/ocr-programas.mjs).
  const ocr = textoOcr('arico');
  if (ocr?.texto) {
    procesar(normalizarHoras(ocr.texto), {
      anyo: ocr.anyo || String(new Date().getFullYear()),
      slug: `ocr-${ocr.anyo || 'prog'}`,
      url: ocr.fuente,
      etiqueta: `programa OCR ${ocr.anyo}`
    });
  }

  cache = { at: Date.now(), data: verbenas };
  return verbenas;
}
