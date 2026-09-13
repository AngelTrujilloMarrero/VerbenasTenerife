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
import { anyoDelTexto, obtenerTextoPdf } from './pdf.js';
import type { Verbena } from './types.js';

// Garachico: WordPress con plugin de noticias propio (?news=slug sin año,
// categorías ?news-category=fiestas; sin meta de fecha ni ?s= útil). La
// vigencia sale de la fecha visible ("23 julio, 2026" / "23 Feb, 2026").
// Patronales Santa Ana y San Roque (24 jul–16 ago, 24 días). El programa
// en PDF es una revista escaneada de 35 MB (fuera de presupuesto): queda
// en aviso. Plaza principal: Plaza de La Libertad.
const BASE = 'https://www.garachico.es';
export const GARACHICO_URL = `${BASE}/?news-category=fiestas`;

const MUNI = 'Garachico';
const NUCLEOS = ['Garachico', 'Las Cruces', 'La Caleta de Interián', 'San Juan del Reparo',
  'El Guincho', 'La Montañeta', 'San Pedro'];

let cache: { at: number; data: Verbena[] } | null = null;
const TTL = 1000 * 60 * 60;
const PAUSA_MS = 1200;
const MAX_DETALLES = 10;
const MAX_PDFS = 5;
const MAX_PDF_BYTES = 15 * 1024 * 1024;

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Candidato { titulo: string; url: string }

const RE_GARACHICO = /garachico|santa ana|san roque|roqu|caleta|cruces|sansusino|trevejo|romer[ií]a|verbena|baile|orquesta|programa|fiesta|tributo|carnaval|navidad|coso/i;

/** Descubre noticias en portada, archivo y categoría de fiestas. */
async function descubrir(): Promise<Candidato[]> {
  const out: Candidato[] = [];
  const seen = new Set<string>();
  const mete = (titulo: string, url: string) => {
    const t = titulo.trim().replace(/\s+/g, ' ');
    if (!t || t.length < 12 || seen.has(url)) return;
    if (!url.startsWith(BASE + '/') || url === BASE + '/') return;
    if (!/\?news=/.test(url)) return;
    if (/\.(pdf|jpg|jpeg|png|webp)$/i.test(url.split('?')[0])) return;
    if (!clasificarTitulo(t).esVerbena && !esContenedor(t) && !RE_GARACHICO.test(t)) return;
    seen.add(url);
    out.push({ titulo: t, url });
  };
  const paginas = [`${BASE}/`, GARACHICO_URL, `${BASE}/?page_id=258`];
  for (const page of paginas) {
    try {
      const html = await fetchText(page);
      rastrearProgramas(MUNI, html, BASE);
      const $ = cheerio.load(html);
      $('a[href]').each((_, a) => {
        let href = $(a).attr('href') || '';
        if (href.startsWith('/')) href = BASE + href;
        else if (href.startsWith('?')) href = BASE + '/' + href;
        if (!href.startsWith(BASE + '/')) return;
        mete($(a).text(), href);
      });
    } catch { /* sigue con la siguiente página */ }
    if (out.length >= MAX_DETALLES) break;
  }
  return out.slice(0, MAX_DETALLES);
}

/** Año de la fecha visible ("23 julio, 2026" / "23 Feb, 2026"). */
function anyoDe(html: string, url: string): string {
  const mSlug = url.match(/(20\d{2})/);
  if (mSlug) return mSlug[1];
  const mVis = html.match(/(\d{1,2})\s+([a-záéíóúñ]+),?\s*(20\d{2})/i);
  if (mVis && mesANum(mVis[2])) return mVis[3];
  return String(new Date().getFullYear());
}

function nucleoDe(texto: string): string {
  const low = texto.toLowerCase();
  for (const n of NUCLEOS) if (low.includes(n.toLowerCase())) return n;
  return '';
}

export async function obtenerVerbenasGarachico(): Promise<Verbena[]> {
  if (cache && Date.now() - cache.at < TTL) return cache.data;
  const verbenas: Verbena[] = [];
  const push = (v: Verbena) => {
    // Evita duplicados del mismo acto entre noticia y programa.
    const dup = verbenas.some((x) =>
      x.id === v.id ||
      (x.day === v.day && x.hora === v.hora &&
        x.orquestas.length > 0 && v.orquestas.length > 0 &&
        x.orquestas.some((o) => v.orquestas.includes(o))));
    if (!dup) verbenas.push(v);
  };

  /** Parte un texto por días y extrae verbenas. */
  const procesar = (cuerpo: string, opts: { anyo: string; slug: string; url: string; etiqueta: string }) => {
    const ctx = mesContexto(cuerpo);
    const ref = ctx.mes && opts.anyo ? { mes: ctx.mes, anyo: opts.anyo } : undefined;
    const lugar = lugarCercano(cuerpo.slice(0, 2000), opts.etiqueta) || nucleoDe(cuerpo) || MUNI;
    let mesPrev = '', anyoPrev = '';
    const secciones = partirPorDias(cuerpo, ref);
    for (const [i, sec] of secciones.entries()) {
      if (sec.mes) mesPrev = sec.mes;
      if (sec.anyo) anyoPrev = sec.anyo;
      let mes = mesANum(sec.mes) || mesANum(mesPrev) || ctx.mes;
      if (!mes) {
        for (let j = i - 1; j >= 0 && !mes; j--) {
          if (secciones[j].mes && /de\s+[a-záéíóúñ]+/i.test(secciones[j].texto.slice(0, 60))) mes = mesANum(secciones[j].mes);
        }
        for (let j = i + 1; j < secciones.length && !mes; j++) {
          if (secciones[j].mes && /de\s+[a-záéíóúñ]+/i.test(secciones[j].texto.slice(0, 60))) mes = mesANum(secciones[j].mes);
        }
      }
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
          id: `garachico-${opts.slug.slice(0, 20)}-${l.hora.replace(':', '') || 'sh'}-${day}-${l.titulo.split(/\s+/).slice(0, 3).join(' ')}`.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9-]+/g, '-'),
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
    console.error('garachico índice fallo', e);
  }

  const htmlCache: string[] = [];
  for (const it of items) {
    try {
      await espera(PAUSA_MS);
      const d = await fetchText(it.url);
      htmlCache.push(d);
      const anyo = anyoDe(d, it.url);
      if (anyo !== String(new Date().getFullYear())) {
        console.warn(`garachico post antiguo (${anyo}) descartado: ${it.url}`);
        continue;
      }
      const cuerpo = normalizarHoras(textoConSaltos(d));
      const slug = (it.url.match(/[?&]news=([^&]+)/)?.[1] || 'noticia').slice(0, 30);
      procesar(cuerpo, { anyo, slug, url: it.url, etiqueta: `noticia: ${it.titulo.slice(0, 50)}` });
    } catch (e) {
      console.error('garachico detalle fallo', it.url, e);
    }
  }

  // PDFs del año vigente enlazados (programas; la revista 2026 pesa 35 MB
  // y queda fuera de presupuesto con aviso).
  const rePdf = /(?:href|src)="([^"]+\.pdf[^"]*)"/gi;
  const vigentes = new Set<string>();
  for (const html of htmlCache) {
    let m: RegExpExecArray | null;
    rePdf.lastIndex = 0;
    while ((m = rePdf.exec(html)) !== null && vigentes.size < MAX_PDFS) {
      let href = m[1];
      if (href.startsWith('/')) href = BASE + href;
      if (!href.startsWith('http') || vigentes.has(href)) continue;
      const anyo = href.match(/(20\d{2})/)?.[1] || '';
      if (anyo && anyo !== String(new Date().getFullYear())) continue;
      if (!anyo && !href.includes(String(new Date().getFullYear()))) continue;
      if (!/programa|fiesta|garachico|roque|verbena|lustrales/i.test(href)) continue;
      vigentes.add(href);
    }
  }
  for (const url of vigentes) {
    try {
      await espera(PAUSA_MS);
      const head = await fetch(url, { method: 'HEAD' });
      const tam = Number(head.headers.get('content-length') || 0);
      if (tam > MAX_PDF_BYTES) {
        console.warn(`garachico pdf pesado (${(tam / 1048576).toFixed(1)} MB) omitido: ${url}`);
        continue;
      }
      const pdf = await obtenerTextoPdf(url, MAX_PDF_BYTES, false, MUNI);
      if (pdf.escaneado) continue; // central (pdf.ts) ya intentó el OCR auto
      const anyo = anyoDelTexto(pdf.texto) || url.match(/(20\d{2})/)?.[1] || String(new Date().getFullYear());
      if (anyo !== String(new Date().getFullYear())) continue;
      const slug = (url.split('/').pop() || 'programa').toLowerCase().replace(/\.pdf.*$/, '').replace(/[^a-z0-9]+/g, '-').slice(0, 30);
      procesar(normalizarHoras(pdf.texto), { anyo, slug, url, etiqueta: `programa: ${slug.slice(0, 40)}` });
    } catch (e) {
      console.error('garachico programa fallo', url, e);
    }
  }

  if (verbenas.length === 0) {
    avisar(MUNI, 'sin-eventos', GARACHICO_URL, 'sin verbenas vigentes (patronales 24 jul-16 ago)');
  }

  cache = { at: Date.now(), data: verbenas };
  return verbenas;
}
