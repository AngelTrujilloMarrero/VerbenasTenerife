import * as cheerio from 'cheerio';
import {
  clasificarDetalle,
  clasificarTitulo,
  diaValido,
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
import { anyoDelTexto, obtenerTextoPdf } from './pdf.js';
import type { Verbena } from './types.js';

// La Matanza de Acentejo: WordPress Divi (REST bloqueado, 401), como
// El Sauzal / Santa Úrsula. Noticias en /{area}/2026/{slug}/ con fecha
// publicada en meta Yoast (article:published_time). El programa de las
// Fiestas Patronales (El Salvador y Ntra. Sra. del Rosario, 25 jul–6 ago)
// se publica en Heyzine (flip-book) cuyo PDF es ESCANEADO (32 págs sin
// texto en 2026): el texto viene del OCR cacheado en
// src/lib/data/ocr-programas.json (scripts/ocr-programas.mjs --pdf).
// Solo año vigente: slugs y titulares llevan año o fecha visible.
const BASE = 'https://www.matanceros.es';
export const LAMATANZA_URL = `${BASE}/fiestas/`;

const MUNI = 'La Matanza';
const NUCLEOS = ['La Matanza', 'San Antonio', 'San Cristóbal', 'Las Breñas',
  'Guía', 'El Caletón', 'Acentejo', 'El Pirul', 'El Reventón', 'La Vica',
  'Puntillo del Sol', 'El Salvador', 'Tinguaro', 'El Montillo'];

let cache: { at: number; data: Verbena[] } | null = null;
const TTL = 1000 * 60 * 60;
const PAUSA_MS = 1200;
const MAX_DETALLES = 8;
const MAX_PDF_BYTES = 30 * 1024 * 1024;

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Candidato { titulo: string; url: string }

const RE_MATANZA = /matanza|acentejo|salvador|rosario|san antonio|tiguaro|tinguaro|patronal|verbena|baile|orquesta|programa|fiesta|romer[ií]a|noche en blanco|fiesta del vino|octava|ganadera/i;

/** Descubre posts en portada, página de fiestas y buscador WP (?s=). */
async function descubrir(): Promise<Candidato[]> {
  const out: Candidato[] = [];
  const seen = new Set<string>();
  const mete = (titulo: string, url: string) => {
    const t = titulo.trim().replace(/\s+/g, ' ');
    if (!t || t.length < 15 || seen.has(url)) return;
    if (!url.startsWith(BASE + '/') || url === BASE + '/') return;
    if (/\.(pdf|jpg|jpeg|png|webp)$/i.test(url.split('?')[0])) return;
    if (!clasificarTitulo(t).esVerbena && !esContenedor(t) && !RE_MATANZA.test(t)) return;
    seen.add(url);
    out.push({ titulo: t, url });
  };
  const paginas = [`${BASE}/`, LAMATANZA_URL, `${BASE}/?s=verbena`, `${BASE}/?s=fiestas`, `${BASE}/?s=orquesta`];
  for (const page of paginas) {
    try {
      const html = await fetchText(page);
      rastrearProgramas(MUNI, html, BASE);
      const $ = cheerio.load(html);
      $('a[href]').each((_, a) => {
        let href = $(a).attr('href') || '';
        if (!href.startsWith(BASE + '/') && href.startsWith('/')) href = BASE + href;
        if (!href.startsWith(BASE + '/')) return;
        mete($(a).text(), href);
      });
    } catch { /* sigue con la siguiente página */ }
    if (out.length >= MAX_DETALLES) break;
  }
  const porSlug = new Map<string, Candidato>();
  for (const c of out) {
    const slug = c.url.split('/').filter(Boolean).pop() || c.url;
    if (!porSlug.has(slug)) porSlug.set(slug, c);
  }
  return [...porSlug.values()].slice(0, MAX_DETALLES);
}

/** Resuelve un flip-book de Heyzine a su PDF directo (cdnm.heyzine.com). */
async function resolverHeyzine(url: string): Promise<string | null> {
  try {
    const html = await fetchText(url);
    const m = html.match(/https:\/\/cdnm\.heyzine\.com\/files\/uploaded\/[^"' \]]+\.pdf/);
    return m ? m[0] : null;
  } catch {
    return null;
  }
}

/** Programas del año en curso: PDFs enlazados + flip-books Heyzine. */
async function descubrirProgramas(): Promise<string[]> {
  const out: string[] = [];
  const vigente = String(new Date().getFullYear());
  const paginas = [LAMATANZA_URL, `${BASE}/`];
  for (const page of paginas) {
    let html = '';
    try {
      html = await fetchText(page);
    } catch {
      continue;
    }
    rastrearProgramas(MUNI, html, BASE);
    const $ = cheerio.load(html);
    $('a[href]').each((_, a) => {
      let href = $(a).attr('href') || '';
      if (href.startsWith('/')) href = BASE + href;
      if (/heyzine\.com\/flip-book\//i.test(href)) {
        if (!out.includes(href)) {
          out.push(href);
          avisar(MUNI, 'programa-pdf', href, 'flip-book Heyzine (PDF escaneado, OCR)');
        }
        return;
      }
      if (!/\.pdf(?:[?#]|$)/i.test(href.split('?')[0])) return;
      const abs = href.startsWith('http') ? href : null;
      if (!abs || out.includes(abs)) return;
      const anyo = abs.match(/(20\d{2})/)?.[1] || '';
      if (anyo && anyo !== vigente) return;
      if (!anyo && !abs.includes(vigente)) return;
      if (!/programa|fiesta|salvador|rosario|antonio|verbena/i.test(abs)) return;
      out.push(abs);
    });
  }
  // Heyzine -> PDF directo (es lo que cachea el OCR).
  const resueltos: string[] = [];
  for (const u of out) {
    if (/heyzine\.com\/flip-book\//i.test(u)) {
      const pdf = await resolverHeyzine(u).catch(() => null);
      const final = pdf || u;
      if (pdf) heyzinePdfs.add(pdf);
      resueltos.push(final);
    } else {
      resueltos.push(u);
    }
  }
  return [...new Set(resueltos)].slice(0, 5);
}

/** PDFs directos que vinieron de un flip-book Heyzine (programa de
 *  Patronales bimensual: necesitan mesPorDia, no mes único). */
const heyzinePdfs = new Set<string>();

/** Año del slug (…/2026/…), si no del meta Yoast, si no el actual. */
function anyoDe(html: string, url: string): string {
  const mSlug = url.match(/(20\d{2})/);
  if (mSlug) return mSlug[1];
  const mMeta = html.match(/article:published_time"\s+content="(20\d{2})/)
    || html.match(/datetime="(20\d{2})-\d{2}-\d{2}/)
    || html.match(/(\d{1,2})\s+[a-záéíóúñ]+,?\s*(20\d{2})/i);
  if (mMeta) return mMeta[mMeta.length - 1];
  return String(new Date().getFullYear());
}

function nucleoDe(texto: string): string {
  const low = texto.toLowerCase();
  for (const n of NUCLEOS) if (low.includes(n.toLowerCase())) return n;
  return '';
}

/** Las Patronales van del ~25 de julio al ~6 de agosto: sin mes explícito
 *  en la sección, el día manda (>=20 -> julio, si no agosto). */
function mesPatronales(dia: number): string {
  return dia >= 20 ? '07' : '08';
}

/** Día de la semana que abre la sección (la cabecera), si lo trae. */
function diaSemanaSecion(texto: string): string {
  const m = texto.slice(0, 60).match(/(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)/i);
  return m ? m[1] : '';
}

export async function obtenerVerbenasLaMatanza(): Promise<Verbena[]> {
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
  const procesar = (cuerpo: string, opts: { anyo: string; slug: string; url: string; etiqueta: string; patronales?: boolean }) => {
    const ctx = mesContexto(cuerpo);
    // Las Patronales cubren DOS meses (25 jul–6 ago): un único ref de mes
    // invalidaría las cabeceras día-primero del otro mes (día-semana) y
    // fusionaría sus bailes en la primera sección. Sin ref + mes por día.
    const ref = opts.patronales || !ctx.mes || !opts.anyo ? undefined : { mes: ctx.mes, anyo: opts.anyo };
    const lugar = lugarCercano(cuerpo.slice(0, 2000), opts.etiqueta) || nucleoDe(cuerpo) || MUNI;
    let mesPrev = '', anyoPrev = '';
    for (const sec of partirPorDias(cuerpo, ref)) {
      if (sec.mes) mesPrev = sec.mes;
      if (sec.anyo) anyoPrev = sec.anyo;
      const mes = opts.patronales
        ? mesANum(sec.mes) || mesPatronales(sec.dia)
        : mesANum(sec.mes) || mesANum(mesPrev) || ctx.mes;
      if (!mes) continue;
      // Compuerta anti-ruido OCR: día imposible o día-semana incoherente
      // con el calendario (p. ej. "69 MIÉRCOLES" del tesseract) tumba la
      // sección entera antes de publicar fechas basura.
      const anyoSec = sec.anyo || anyoPrev || opts.anyo;
      if (opts.patronales && (sec.dia < 1 || sec.dia > 31)) continue;
      if (opts.patronales && diaSemanaSecion(sec.texto)
        && !diaValido(sec.dia, mes, anyoSec, diaSemanaSecion(sec.texto))) continue;
      const day = `${String(sec.dia).padStart(2, '0')}-${mes}-${anyoSec}`;
      const lineas = [
        ...extraerSubEventos(sec.texto).map((s) => ({ titulo: s.titulo, hora: s.hora, orquestas: s.orquestas, extra: 0 })),
        ...extraerBailesSinHora(sec.texto).map((s) => ({ titulo: s.titulo, hora: s.hora || horaPrevia(sec.texto, s.titulo), orquestas: s.orquestas, extra: s.explicita ? 2 : 0 }))
      ];
      for (const l of lineas) {
        const lugarLinea = lugarCercano(sec.texto, l.titulo) || lugar;
        const cls = clasificarDetalle(l.titulo, ventana(sec.texto, l.titulo, 400), l.hora, lugarLinea, l.extra);
        if (!cls.esVerbena) continue;
        push({
          id: `lamatanza-${opts.slug.slice(0, 20)}-${l.hora.replace(':', '') || 'sh'}-${day}-${l.titulo.split(/\s+/).slice(0, 3).join(' ')}`.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9-]+/g, '-'),
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
    console.error('lamatanza índice fallo', e);
  }

  for (const it of items) {
    try {
      await espera(PAUSA_MS);
      const d = await fetchText(it.url);
      const anyo = anyoDe(d, it.url);
      if (anyo !== String(new Date().getFullYear())) {
        console.warn(`lamatanza post antiguo (${anyo}) descartado: ${it.url}`);
        continue;
      }
      const cuerpo = normalizarHoras(textoConSaltos(d));
      const slug = it.url.split('/').filter(Boolean).pop() || 'noticia';
      procesar(cuerpo, { anyo, slug, url: it.url, etiqueta: `noticia: ${it.titulo.slice(0, 50)}` });
      // El programa vive en Heyzine: se resuelve y procesa si trae texto.
      const hey = d.match(/https:\/\/heyzine\.com\/flip-book\/[A-Za-z0-9]+\.html/);
      if (hey && anyo === String(new Date().getFullYear())) {
        const pdf = await resolverHeyzine(hey[0]).catch(() => null);
        const ocrPrevio = textoOcr('lamatanza');
        if (pdf && (!ocrPrevio || pdf !== ocrPrevio.fuente)) {
          try {
            await espera(PAUSA_MS);
            heyzinePdfs.add(pdf);
            // obtenerTextoPdf ya trae el OCR automático si el PDF es
            // escaneado (ver pdf.ts); aquí solo se añade patronales:true.
            const doc = await obtenerTextoPdf(pdf, MAX_PDF_BYTES, false, MUNI);
            if (doc.escaneado) continue;
            const a = anyoDelTexto(doc.texto) || anyo;
            procesar(normalizarHoras(doc.texto), { anyo: a, slug: 'heyzine-pdf', url: hey[0], etiqueta: 'programa Heyzine', patronales: true });
          } catch (e) {
            console.error('lamatanza heyzine fallo', hey[0], e);
          }
        }
      }
    } catch (e) {
      console.error('lamatanza detalle fallo', it.url, e);
    }
  }

  // Programas oficiales (el de Patronales es escaneado; el texto viene del OCR).
  // Si ya hay OCR cacheado de esa URL, no se descarga de nuevo.
  const ocrPrevio = textoOcr('lamatanza');
  for (const url of await descubrirProgramas()) {
    try {
      if (ocrPrevio && url === ocrPrevio.fuente) continue;
      if (/heyzine\.com\/flip-book\//i.test(url)) continue; // ya resuelto arriba
      await espera(PAUSA_MS);
      const head = await fetch(url, { method: 'HEAD' });
      const tam = Number(head.headers.get('content-length') || 0);
      if (tam > MAX_PDF_BYTES) {
        console.warn(`lamatanza pdf pesado (${(tam / 1048576).toFixed(1)} MB) omitido: ${url}`);
        continue;
      }
      const pdf = await obtenerTextoPdf(url, MAX_PDF_BYTES, false, MUNI);
      if (pdf.escaneado) continue; // central (pdf.ts) ya intentó el OCR auto
      const anyo = anyoDelTexto(pdf.texto) || url.match(/(20\d{2})/)?.[1] || String(new Date().getFullYear());
      if (anyo !== String(new Date().getFullYear())) continue;
      const slug = (url.split('/').pop() || 'programa').toLowerCase().replace(/\.pdf.*$/, '').replace(/[^a-z0-9]+/g, '-').slice(0, 30);
      procesar(normalizarHoras(pdf.texto), { anyo, slug, url, etiqueta: `programa: ${slug.slice(0, 40)}`, patronales: heyzinePdfs.has(url) || undefined });
    } catch (e) {
      console.error('lamatanza programa fallo', url, e);
    }
  }

  // Programa de Patronales (OCR cacheado, ver scripts/ocr-programas.mjs --pdf).
  const ocr = textoOcr('lamatanza');
  if (ocr?.texto) {
    procesar(normalizarHoras(ocr.texto), {
      anyo: ocr.anyo || String(new Date().getFullYear()),
      slug: `ocr-${ocr.anyo || 'prog'}`,
      url: ocr.fuente,
      etiqueta: `programa OCR ${ocr.anyo}`,
      patronales: true
    });
  }

  if (verbenas.length === 0) {
    avisar(MUNI, 'sin-eventos', LAMATANZA_URL, 'sin verbenas vigentes (patronales 25 jul-6 ago)');
  }

  cache = { at: Date.now(), data: verbenas };
  return verbenas;
}
