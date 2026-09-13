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

// La Guancha: WordPress Bones con REST bloqueada (401), como El Sauzal.
// Dos formatos: fichas /actividad/slug con fecha estructurada ("Detalles
// Fecha: 4 marzo, 2023 Hora: 17:30" + "Este evento ha pasado") y noticias
// con fecha en meta Yoast (article:published_time) y programa inline
// ("...sábado 22 de agosto... 23:00 horas... gran verbena, con las
// actuaciones de Kimbara, Malibú Band y Orquesta Revelación...").
// Slugs a veces sin año: vigencia por meta/detalle, nunca por defecto.
// Barrios con fiestas propias (Coromoto, Asomada, Pinalete, Rosario).
const BASE = 'https://www.laguancha.es';
export const LAGUANCHA_URL = `${BASE}/agenda/`;

const MUNI = 'La Guancha';
const NUCLEOS = ['La Guancha', 'El Casco', 'El Farrobo', 'El Pinalete', 'La Guancha de Abajo',
  'Santa Catalina', 'Santo Domingo', 'Las Cucharas', 'La Asomada', 'San Juan', 'El Dulce Nombre'];

let cache: { at: number; data: Verbena[] } | null = null;
const TTL = 1000 * 60 * 60;
const PAUSA_MS = 1200;
const MAX_DETALLES = 14;
const MAX_PDFS = 5;
const MAX_PDF_BYTES = 8 * 1024 * 1024;

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));
interface Candidato { titulo: string; url: string }

const RE_GUANCHA = /guancha|papada|havas|hayas|coromoto|asomada|pinalete|rosario|esperanza|carnaval|verbena|baile|orquesta|programa|fiesta|romer[ií]a|traslado|pregon/i;

/** Descubre fichas y noticias en portada, categorías y buscador WP (?s=). */
async function descubrir(): Promise<Candidato[]> {
  const out: Candidato[] = [];
  const seen = new Set<string>();
  const mete = (titulo: string, url: string) => {
    const t = titulo.trim().replace(/\s+/g, ' ');
    if (!t || t.length < 12 || seen.has(url)) return;
    if (!url.startsWith(BASE + '/') || url === BASE + '/') return;
    if (/\.(pdf|jpg|jpeg|png|webp)$/i.test(url.split('?')[0])) return;
    // Páginas institucionales (mencionan "Guancha" en el menú y llenarían
    // el cupo): nunca son noticias. Se quedan posts, fichas y categorías.
    const path = new URL(url).pathname;
    if (/^\/(municipio|servicios|ayuntamiento-2|documentos|sede-electronica-borrador)\//.test(path)
      || path === '/d-fiestas/') return;
    if (!clasificarTitulo(t).esVerbena && !esContenedor(t) && !RE_GUANCHA.test(t)) return;
    seen.add(url);
    out.push({ titulo: t, url });
  };
  // Sin archivos de categoría: /category/fiestas/ solo trae 2018 y se
  // comería el cupo. Portada (reciente) + buscador ?s= (filtra anyoDe).
  const paginas = [`${BASE}/`,
    `${BASE}/?s=verbena`, `${BASE}/?s=fiestas`, `${BASE}/?s=orquesta`, `${BASE}/?s=baile`];
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

/** Año del slug, si no del meta Yoast, si no de "Posted 4 septiembre, 2026"
 *  o fecha visible, si no el actual (los slugs van sin año a menudo). */
function anyoDe(html: string, url: string): string {
  const mSlug = url.match(/(20\d{2})/);
  if (mSlug) return mSlug[1];
  const mMeta = html.match(/article:published_time"\s+content="(20\d{2})/)
    || html.match(/Posted\s+(\d{1,2})\s+[a-záéíóúñ]+,?\s*(20\d{2})/i)
    || html.match(/(\d{1,2})\s+[a-záéíóúñ]+,?\s*(20\d{2})/i)
    || html.match(/datetime="(20\d{2})-\d{2}-\d{2}/);
  if (mMeta) return mMeta[mMeta.length - 1];
  return String(new Date().getFullYear());
}

function nucleoDe(texto: string): string {
  const low = texto.toLowerCase();
  for (const n of NUCLEOS) if (low.includes(n.toLowerCase())) return n;
  return '';
}

/** "el recinto festivo" genérico -> recinto con nombre para lugarCercano. */
function aliasLugares(cuerpo: string): string {
  return cuerpo.replace(/el recinto festivo/gi, 'Recinto Festivo');
}

/** Ficha estructurada de /actividad/: "Detalles Fecha: 4 marzo, 2023
 *  Hora: 17:30" (o "TÍTULO 4 marzo, 2023 a las 17:30"). */
function fichaActividad(cuerpo: string): { day: string; hora: string } | null {
  const m = cuerpo.match(/Detalles?\s*Fecha:\s*(\d{1,2})\s+([a-záéíóúñ]+),?\s*(20\d{2})\s*Hora:\s*(\d{1,2}:\d{2})/i)
    || cuerpo.match(/(\d{1,2})\s+([a-záéíóúñ]+),?\s*(20\d{2})\s+a las\s*(\d{1,2}:\d{2})/i);
  if (!m) return null;
  const mes = mesANum(m[2]);
  if (!mes) return null;
  return { day: `${m[1].padStart(2, '0')}-${mes}-${m[3]}`, hora: m[4] };
}

export async function obtenerVerbenasLaGuancha(): Promise<Verbena[]> {
  if (cache && Date.now() - cache.at < TTL) return cache.data;
  const verbenas: Verbena[] = [];
  const push = (v: Verbena) => {
    // Evita duplicados del mismo acto entre ficha y noticia.
    const dup = verbenas.some((x) =>
      x.id === v.id ||
      (x.day === v.day && x.hora === v.hora &&
        x.orquestas.length > 0 && v.orquestas.length > 0 &&
        x.orquestas.some((o) => v.orquestas.includes(o))));
    if (!dup) verbenas.push(v);
  };

  /** Parte un texto (ficha o noticia) por días y extrae verbenas. */
  const procesar = (cuerpo: string, opts: { anyo: string; slug: string; url: string; etiqueta: string; diaFijo?: string; horaFicha?: string }) => {
    const limpio = aliasLugares(cuerpo);
    // Ficha de un solo día sin cabeceras: todo el cuerpo es una sección.
    const lista = opts.diaFijo
      ? [{ day: opts.diaFijo, texto: limpio }]
      : seccionesFechadas(limpio, opts.anyo);
    const lugar = lugarCercano(limpio.slice(0, 2000), opts.etiqueta) || nucleoDe(limpio) || MUNI;
    for (const sec of lista) {
      const lugarSec = nucleoDe(sec.texto) || MUNI;
      const lineas = [
        ...extraerSubEventos(sec.texto).map((s) => ({ titulo: s.titulo, hora: s.hora, orquestas: s.orquestas, extra: 0 })),
        ...extraerBailesSinHora(sec.texto).map((s) => ({
          titulo: s.titulo, hora: s.hora || opts.horaFicha || horaPrevia(sec.texto, s.titulo),
          orquestas: s.orquestas, extra: s.explicita ? 2 : 0
        }))
      ];
      for (const l of lineas) {
        const lugarLinea = lugarCercano(sec.texto, l.titulo) || (limpio.length < 3000 ? lugar : lugarSec);
        const cls = clasificarDetalle(l.titulo, ventana(sec.texto, l.titulo, 400), l.hora, lugarLinea, l.extra);
        if (!cls.esVerbena) continue;
        push({
          id: `laguancha-${opts.slug.slice(0, 20)}-${l.hora.replace(':', '') || 'sh'}-${sec.day}-${l.titulo.split(/\s+/).slice(0, 3).join(' ')}`.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9-]+/g, '-'),
          titulo: l.titulo, day: sec.day, hora: l.hora, municipio: MUNI,
          lugar: lugarLinea, orquestas: l.orquestas,
          tipo: tipoDeEvento(l.titulo), url: opts.url,
          score: cls.score, motivos: [...cls.motivos, opts.etiqueta]
        });
      }
    }
  };

  /** Secciones de noticia con fecha resuelta (herencia de mes anterior
   *  y posterior, como El Sauzal: la prosa nombra el mes en otro punto). */
  function seccionesFechadas(limpio: string, anyo: string): { day: string; texto: string }[] {
    const ctx = mesContexto(limpio);
    const ref = ctx.mes && anyo ? { mes: ctx.mes, anyo } : undefined;
    const secciones = partirPorDias(limpio, ref);
    let mesPrev = '', anyoPrev = '';
    const out: { day: string; texto: string }[] = [];
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
      out.push({ day: `${String(sec.dia).padStart(2, '0')}-${mes}-${sec.anyo || anyoPrev || anyo}`, texto: sec.texto });
    }
    return out;
  }

  let items: Candidato[] = [];
  try {
    items = await descubrir();
  } catch (e) {
    console.error('laguancha índice fallo', e);
  }

  const htmlCache: string[] = [];
  for (const it of items) {
    try {
      await espera(PAUSA_MS);
      const d = await fetchText(it.url);
      htmlCache.push(d);
      const anyo = anyoDe(d, it.url);
      if (anyo !== String(new Date().getFullYear())) {
        console.warn(`laguancha post antiguo (${anyo}) descartado: ${it.url}`);
        continue;
      }
      const cuerpo = normalizarHoras(textoConSaltos(d));
      const slug = it.url.split('/').filter(Boolean).pop() || 'noticia';
      // Ficha /actividad/ con día explícito: manda sobre las cabeceras.
      const ficha = it.url.includes('/actividad/') ? fichaActividad(cuerpo) : null;
      procesar(cuerpo, ficha && ficha.day.endsWith(anyo)
        ? { anyo, slug, url: it.url, etiqueta: `ficha: ${it.titulo.slice(0, 50)}`, diaFijo: ficha.day, horaFicha: ficha.hora }
        : { anyo, slug, url: it.url, etiqueta: `noticia: ${it.titulo.slice(0, 50)}` });
    } catch (e) {
      console.error('laguancha detalle fallo', it.url, e);
    }
  }

  // PDFs del año vigente enlazados (programa de patronales).
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
      if (!/programa|fiesta|guancha|verbena|papada/i.test(href)) continue;
      vigentes.add(href);
    }
  }
  for (const url of vigentes) {
    try {
      await espera(PAUSA_MS);
      const head = await fetch(url, { method: 'HEAD' });
      const tam = Number(head.headers.get('content-length') || 0);
      if (tam > MAX_PDF_BYTES) {
        console.warn(`laguancha pdf pesado (${(tam / 1048576).toFixed(1)} MB) omitido: ${url}`);
        continue;
      }
      const pdf = await obtenerTextoPdf(url, MAX_PDF_BYTES, false, MUNI);
      if (pdf.escaneado) continue; // central (pdf.ts) ya intentó el OCR auto
      const anyo = anyoDelTexto(pdf.texto) || url.match(/(20\d{2})/)?.[1] || String(new Date().getFullYear());
      if (anyo !== String(new Date().getFullYear())) continue;
      const slug = (url.split('/').pop() || 'programa').toLowerCase().replace(/\.pdf.*$/, '').replace(/[^a-z0-9]+/g, '-').slice(0, 30);
      procesar(normalizarHoras(pdf.texto), { anyo, slug, url, etiqueta: `programa: ${slug.slice(0, 40)}` });
    } catch (e) {
      console.error('laguancha programa fallo', url, e);
    }
  }

  if (verbenas.length === 0) {
    avisar(MUNI, 'sin-eventos', LAGUANCHA_URL, 'sin verbenas vigentes (patronales en agosto)');
  }

  cache = { at: Date.now(), data: verbenas };
  return verbenas;
}
