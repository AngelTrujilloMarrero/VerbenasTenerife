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
import { avisar, rastrearProgramas } from './avisos.js';
import { textoOcr } from './ocr.js';
import { lanzarOcrAutoImagenes, leerOcrAuto, textoSimilar } from './ocr-auto.js';
import { anyoDelTexto, obtenerTextoPdf } from './pdf.js';
import type { Verbena } from './types.js';

const BASE = 'https://www.sanjuandelarambla.es';
export const SANJUANRAMBLA_URL = `${BASE}/actualidad/category/fiestas/`;
const AREA_FIESTAS = `${BASE}/areas-municipales/area-de-fiestas/`;

const MUNI = 'San Juan de la Rambla';
const NUCLEOS = ['San José', 'San Juan', 'La Vera', 'Las Aguas', 'Las Rosas', 'Los Canarios', 'La Paz', 'El Rosario Oramas', 'Rosario Oramas'];

let cache: { at: number; data: Verbena[] } | null = null;
const TTL = 1000 * 60 * 60;
const PAUSA_MS = 1200;
const MAX_DETALLES = 8;
const MAX_PDF_BYTES = 8 * 1024 * 1024;

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
  const paginas = [`${BASE}/`, SANJUANRAMBLA_URL, `${BASE}/?s=verbena`, `${BASE}/?s=fiestas`];
  for (const page of paginas) {
    try {
      const html = await fetchText(page);
      rastrearProgramas(MUNI, html, BASE);
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

/** Programas del año en curso enlazados desde el área de Fiestas
 *  ("Programa 2026" -> .../Programa-San-Jose-2026.pdf). */
async function descubrirProgramas(): Promise<string[]> {
  try {
    const html = await fetchText(AREA_FIESTAS);
    const $ = cheerio.load(html);
    const out: string[] = [];
    const vigente = String(new Date().getFullYear());
    $('a[href$=".pdf"]').each((_, a) => {
      const href = $(a).attr('href') || '';
      if (!href.includes(vigente)) return;
      const url = href.startsWith('http') ? href : BASE + href;
      if (!out.includes(url)) out.push(url);
    });
    return out;
  } catch {
    return [];
  }
}

/** Año de publicación del post (`<span class="published">19 junio, 2026</span>`),
 *  o null. Sin esto los posts de 2025 (URL sin año) se fecharían con el actual. */
function anyoPublicacion(html: string): number | null {
  const m = html.match(/<span class="published">[^<]*?(20\d{2})/i) ||
    html.match(/Fecha de publicaci[oó]n[\s\S]{0,400}?(20\d{2})/i);
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
 *  src/lib/data/ocr-programas.json (generado por scripts/ocr-programas.mjs)
 *  o en la caché automática (.cache/ocr-auto, ver ocr-auto.ts).
 *  Devuelve la página si encontró galería (para procesar su caché). */
function programasPendientes(html: string, url: string): string | null {
  const raw = html.match(/["']([^"']*PROGRAMA[^"']*?[_-]page-\d+\.(?:jpg|jpeg|png|webp))["']/gi) || [];
  const imgs: string[] = [];
  for (const m of raw) {
    let src = m.slice(1, -1);
    if (/-\d{2,4}x\d{2,4}\.(jpg|jpeg|png|webp)$/i.test(src)) continue; // miniatura WP
    if (src.startsWith('/')) src = BASE + src;
    if (!/^https?:/i.test(src) || imgs.includes(src)) continue;
    imgs.push(src);
  }
  if (imgs.length <= 2) return null;
  const manual = textoOcr('sanjuanrambla');
  if (manual?.texto && manual.fuente === url) return null; // ya cubierto
  if (!leerOcrAuto(url)?.texto) {
    lanzarOcrAutoImagenes(url, imgs, MUNI);
    avisar(MUNI, 'programa-imagen', url, `solo-imagen (${imgs.length} págs) sin OCR`);
  }
  return url;
}

export async function obtenerVerbenasSanJuanRambla(): Promise<Verbena[]> {
  if (cache && Date.now() - cache.at < TTL) return cache.data;
  const verbenas: Verbena[] = [];
  const push = (v: Verbena) => {
    // Evita duplicados del mismo acto entre noticia, programa y OCR.
    const dup = verbenas.some((x) =>
      x.id === v.id ||
      (x.day === v.day && x.hora === v.hora &&
        x.orquestas.length > 0 && v.orquestas.length > 0 &&
        x.orquestas.some((o) => v.orquestas.includes(o))));
    if (!dup) verbenas.push(v);
  };

  /** Parte un texto (noticia, programa PDF u OCR) por días y extrae verbenas. */
  const procesar = (cuerpo: string, opts: { anyo: string; slug: string; url: string; etiqueta: string }) => {
    const ctx = mesContexto(cuerpo);
    const ref = ctx.mes && opts.anyo ? { mes: ctx.mes, anyo: opts.anyo } : undefined;
    const lugar = lugarCercano(cuerpo.slice(0, 2000), opts.etiqueta) || nucleoDe(cuerpo) || MUNI;
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
          id: `sanjuanrambla-${opts.slug.slice(0, 20)}-${l.hora.replace(':', '') || 'sh'}-${day}-${l.titulo.split(/\s+/).slice(0, 3).join(' ')}`.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9-]+/g, '-'),
          titulo: l.titulo, day, hora: l.hora, municipio: MUNI,
          lugar: lugarLinea, orquestas: l.orquestas,
          tipo: tipoDeEvento(l.titulo), url: opts.url,
          score: cls.score, motivos: [...cls.motivos, opts.etiqueta]
        });
      }
    }
  };

  let items: Candidato[] = [];
  const paginasImagen: string[] = [];
  try {
    items = await descubrir();
  } catch (e) {
    console.error('sanjuanrambla índice fallo', e);
  }

  for (const it of items) {
    try {
      await espera(PAUSA_MS);
      const d = await fetchText(it.url);
      // Filtro de vigencia: los slugs no llevan año y hay posts de 2025.
      const pub = anyoPublicacion(d);
      if (pub && pub < new Date().getFullYear()) {
        console.warn(`sanjuanrambla post antiguo (${pub}) descartado: ${it.url}`);
        continue;
      }
      const pg = programasPendientes(d, it.url);
      if (pg && !paginasImagen.includes(pg)) paginasImagen.push(pg);
      const cuerpo = normalizarHoras(textoConSaltos(d));
      const anyo = anyoDe(d, it.url);
      const slug = it.url.split('/').filter(Boolean).pop() || 'noticia';
      procesar(cuerpo, { anyo, slug, url: it.url, etiqueta: `noticia: ${it.titulo.slice(0, 50)}` });
    } catch (e) {
      console.error('sanjuanrambla detalle fallo', it.url, e);
    }
  }

  // Programas oficiales (los PDF son escaneados; el texto viene del OCR).
  // Si ya hay OCR cacheado de esa URL, no se descarga de nuevo.
  const ocrPrevio = textoOcr('sanjuanrambla');
  for (const url of await descubrirProgramas()) {
    try {
      if (ocrPrevio && url === ocrPrevio.fuente) continue;
      await espera(PAUSA_MS);
      // Evita descargas pesadas (San Felipe Neri: 22 MB de escaneos).
      const head = await fetch(url, { method: 'HEAD' });
      const tam = Number(head.headers.get('content-length') || 0);
      if (tam > MAX_PDF_BYTES) {
        console.warn(`sanjuanrambla pdf pesado (${(tam / 1048576).toFixed(1)} MB) omitido: ${url}`);
        continue;
      }
      const pdf = await obtenerTextoPdf(url, undefined, false, MUNI);
      if (pdf.escaneado) continue; // avisado en pdf.ts (monitor /api/estado.json)
      const anyo = anyoDelTexto(pdf.texto) || url.match(/(20\d{2})/)?.[1] || String(new Date().getFullYear());
      const slug = (url.split('/').pop() || 'programa').toLowerCase().replace(/\.pdf.*$/, '').replace(/[^a-z0-9]+/g, '-').slice(0, 30);
      procesar(normalizarHoras(pdf.texto), { anyo, slug, url, etiqueta: `programa: ${slug.slice(0, 40)}` });
    } catch (e) {
      console.error('sanjuanrambla programa fallo', url, e);
    }
  }

  // Programa publicado solo como imágenes (OCR manual versionado o
  // automático en caché, ver scripts/ocr-programas.mjs y ocr-auto.ts).
  const ocr = textoOcr('sanjuanrambla');
  if (ocr?.texto) {
    procesar(normalizarHoras(ocr.texto), {
      anyo: ocr.anyo || String(new Date().getFullYear()),
      slug: `ocr-${ocr.anyo || 'prog'}`,
      url: ocr.fuente,
      etiqueta: `programa OCR ${ocr.anyo}`
    });
  }
  for (const pg of paginasImagen) {
    const auto = leerOcrAuto(pg);
    if (!auto?.texto) continue;
    if (ocr?.texto && textoSimilar(auto.texto, ocr.texto)) continue; // ya cubierto
    procesar(normalizarHoras(auto.texto), {
      anyo: pg.match(/(20\d{2})/)?.[1] || String(new Date().getFullYear()),
      slug: 'ocr-auto',
      url: pg,
      etiqueta: 'programa OCR auto'
    });
  }

  cache = { at: Date.now(), data: verbenas };
  return verbenas;
}
