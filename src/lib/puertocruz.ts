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

// Puerto de la Cruz: WordPress con REST ABIERTA (posts + media). Noticias
// con fecha (/noticias/2026/09/10/slug). Agenda /eventos/ con tarjetas
// "TÍTULO 🌍Lugar 📅fecha ⌚hora". Programas en Google Drive (patrón
// Tacoronte: drive.google.com/file/d/ID -> uc?export=download). Páginas
// por fiesta (/grandes-fiestas-julio-2026/, /fiestaspatronales...).
// Solo año vigente (fecha REST o slug).
const BASE = 'https://www.puertodelacruz.es';
const REST = `${BASE}/wp-json/wp/v2`;
export const PUERTOCRUZ_URL = `${BASE}/eventos/`;

const MUNI = 'Puerto de la Cruz';
const NUCLEOS = ['Puerto de la Cruz', 'La Vera', 'Punta Brava', 'San Antonio', 'El Tope', 'Las Dehesas'];

let cache: { at: number; data: Verbena[] } | null = null;
const TTL = 1000 * 60 * 60;
const PAUSA_MS = 1200;
const MAX_DETALLES = 10;
const MAX_PDFS = 5;
const MAX_PDF_BYTES = 15 * 1024 * 1024;

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface PostRest {
  date?: string;
  link?: string;
  title?: { rendered?: string };
  content?: { rendered?: string };
}

interface Candidato { titulo: string; cuerpo: string; url: string; anyo: string }

const RE_PUERTO = /puerto|vera|brava|tope|carmen|san juan|san telmo|cruces|sardinada|verbena|baile|orquesta|programa|fiesta|tributo|carnaval|salsa|mueca|navidad|reyes/i;

function sinHtml(s: string): string {
  return (s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Descubre posts vía REST (categoría noticias + búsquedas). */
async function descubrir(): Promise<Candidato[]> {
  const out: Candidato[] = [];
  const seen = new Set<string>();
  const vigente = String(new Date().getFullYear());
  const mete = (p: PostRest) => {
    const titulo = sinHtml(p.title?.rendered);
    const url = p.link || '';
    if (!titulo || titulo.length < 10 || !url.startsWith(BASE + '/') || seen.has(url)) return;
    if (!p.date?.startsWith(vigente)) return;
    if (!clasificarTitulo(titulo).esVerbena && !esContenedor(titulo) && !RE_PUERTO.test(titulo)) return;
    seen.add(url);
    out.push({ titulo, cuerpo: p.content?.rendered || '', url, anyo: vigente });
  };
  const queries = ['verbena', 'orquesta', 'baile', 'fiestas', 'carnaval', 'tributo'];
  for (const q of queries) {
    try {
      const j = JSON.parse(await fetchText(
        `${REST}/posts?search=${encodeURIComponent(q)}&per_page=20&_fields=date,link,title,content`));
      if (Array.isArray(j)) j.forEach(mete);
    } catch { /* sigue con la siguiente query */ }
    if (out.length >= MAX_DETALLES) break;
  }
  if (out.length < MAX_DETALLES) {
    try {
      // Categoría noticias (id 35): repesca lo reciente.
      const j = JSON.parse(await fetchText(
        `${REST}/posts?categories=35&per_page=15&_fields=date,link,title,content`));
      if (Array.isArray(j)) j.forEach(mete);
    } catch { /* sin repesca */ }
  }
  return out.slice(0, MAX_DETALLES);
}

/** Programas en mediateca (año vigente). */
async function descubrirProgramas(): Promise<{ url: string; anyo: string }[]> {
  const vigente = String(new Date().getFullYear());
  const seen = new Set<string>();
  const out: { url: string; anyo: string }[] = [];
  for (const q of ['programa', 'fiestas']) {
    try {
      const j = JSON.parse(await fetchText(
        `${REST}/media?search=${encodeURIComponent(q)}&per_page=30&_fields=date,source_url,mime_type`));
      if (!Array.isArray(j)) continue;
      for (const m of j) {
        if (m?.mime_type !== 'application/pdf' || typeof m?.source_url !== 'string') continue;
        if (seen.has(m.source_url)) continue;
        const anyo = typeof m?.date === 'string' ? m.date.slice(0, 4) : '';
        const urlAnyo = m.source_url.match(/(20\d{2})/)?.[1] || '';
        if (anyo !== vigente && urlAnyo !== vigente) continue;
        seen.add(m.source_url);
        out.push({ url: m.source_url, anyo: vigente });
        if (out.length >= MAX_PDFS) break;
      }
    } catch { /* sigue */ }
    if (out.length >= MAX_PDFS) break;
  }
  return out;
}

/** Programa en PDF vía Google Drive (uc?export=download). */
async function pdfDrive(html: string): Promise<{ texto: string; url: string } | null> {
  const m = html.match(/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]+)/);
  if (!m) return null;
  const url = `https://drive.google.com/uc?export=download&id=${m[1]}`;
  const pdf = await obtenerTextoPdf(url, undefined, true, MUNI);
  if (pdf.escaneado) return null; // avisado en pdf.ts (monitor /api/estado.json)
  return { texto: pdf.texto, url };
}

function nucleoDe(texto: string): string {
  const low = texto.toLowerCase();
  for (const n of NUCLEOS) if (low.includes(n.toLowerCase())) return n;
  return '';
}

export async function obtenerVerbenasPuertoCruz(): Promise<Verbena[]> {
  if (cache && Date.now() - cache.at < TTL) return cache.data;
  const verbenas: Verbena[] = [];
  const push = (v: Verbena) => {
    // Evita duplicados del mismo acto entre noticia, agenda y programa.
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
          id: `puertocruz-${opts.slug.slice(0, 20)}-${l.hora.replace(':', '') || 'sh'}-${day}-${l.titulo.split(/\s+/).slice(0, 3).join(' ')}`.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9-]+/g, '-'),
          titulo: l.titulo, day, hora: l.hora, municipio: MUNI,
          lugar: lugarLinea, orquestas: l.orquestas,
          tipo: tipoDeEvento(l.titulo), url: opts.url,
          score: cls.score, motivos: [...cls.motivos, opts.etiqueta]
        });
      }
    }
  };

  /** Tarjeta de /eventos/ con fecha explícita ("TÍTULO 🌍Lugar 📅fecha ⌚hora"). */
  const procesarTarjeta = (titulo: string, lugar: string, fecha: string, hora: string) => {
    const vigente = String(new Date().getFullYear());
    const m = fecha.match(/(\d{1,2})\s+de\s+([a-záéíóúñ]+)/i);
    if (!m) return;
    const mes = mesANum(m[2]);
    if (!mes) return;
    const day = `${m[1].padStart(2, '0')}-${mes}-${vigente}`;
    const t = titulo.trim().replace(/\s+/g, ' ');
    const cls = clasificarDetalle(t, '', hora, lugar, 0);
    if (!cls.esVerbena) return;
    push({
      id: `puertocruz-tarjeta-${hora.replace(':', '') || 'sh'}-${day}-${t.split(/\s+/).slice(0, 3).join(' ')}`.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9-]+/g, '-'),
      titulo: t, day, hora, municipio: MUNI,
      lugar: lugar || MUNI, orquestas: extraerSubEventos(t).flatMap((s) => s.orquestas),
      tipo: tipoDeEvento(t), url: PUERTOCRUZ_URL,
      score: cls.score, motivos: [...cls.motivos, 'tarjeta /eventos/']
    });
  };

  let items: Candidato[] = [];
  try {
    items = await descubrir();
  } catch (e) {
    console.error('puertocruz índice fallo', e);
  }

  for (const it of items) {
    try {
      const cuerpo = normalizarHoras(textoConSaltos(it.cuerpo));
      const slug = it.url.split('/').filter(Boolean).pop() || 'noticia';
      procesar(`${it.titulo}\n${cuerpo}`, { anyo: it.anyo, slug, url: it.url, etiqueta: `noticia: ${it.titulo.slice(0, 50)}` });
    } catch (e) {
      console.error('puertocruz noticia fallo', it.url, e);
    }
  }

  // Tarjetas de la agenda /eventos/ con fecha explícita.
  try {
    const html = await fetchText(PUERTOCRUZ_URL);
    rastrearProgramas(MUNI, html, BASE);
    const texto = textoConSaltos(html);
    const re = /([^🌍📅⌚\n]{10,120}?)\s*🌍\s*([^📅\n]{2,80}?)\s*📅\s*([^⌚\n]{3,60}?)\s*(?:⌚\s*([^\n]{2,30}))?/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(texto)) !== null) {
      const hora = (m[4] || '').match(/(\d{1,2}:\d{2})/)?.[1] || '';
      procesarTarjeta(m[1], m[2].trim(), m[3].trim(), hora);
    }
  } catch (e) {
    console.error('puertocruz agenda fallo', e);
  }

  // Páginas por fiesta (programa en Drive o inline).
  for (const page of [`${BASE}/grandes-fiestas-julio-2026/`, `${BASE}/fiestaspatronales`,
    `${BASE}/sanjuan`, `${BASE}/carnaval-internacional/`]) {
    try {
      await espera(PAUSA_MS);
      const html = await fetchText(page);
      rastrearProgramas(MUNI, html, BASE);
      const slug = page.split('/').filter(Boolean).pop() || 'fiestas';
      const drive = await pdfDrive(html).catch(() => null);
      if (drive) {
        const anyo = anyoDelTexto(drive.texto) || String(new Date().getFullYear());
        procesar(normalizarHoras(drive.texto), { anyo, slug, url: page, etiqueta: `programa Drive: ${slug}` });
      } else {
        procesar(normalizarHoras(textoConSaltos(html)), {
          anyo: String(new Date().getFullYear()), slug, url: page, etiqueta: `página: ${slug}`
        });
      }
    } catch { /* página inexistente o fallo */ }
  }

  // PDFs de mediateca (año vigente).
  for (const p of await descubrirProgramas()) {
    try {
      await espera(PAUSA_MS);
      const head = await fetch(p.url, { method: 'HEAD' });
      const tam = Number(head.headers.get('content-length') || 0);
      if (tam > MAX_PDF_BYTES) {
        console.warn(`puertocruz pdf pesado (${(tam / 1048576).toFixed(1)} MB) omitido: ${p.url}`);
        continue;
      }
      const pdf = await obtenerTextoPdf(p.url, MAX_PDF_BYTES, false, MUNI);
      if (pdf.escaneado) continue; // central (pdf.ts) ya intentó el OCR auto
      const anyo = anyoDelTexto(pdf.texto) || p.anyo;
      if (anyo !== String(new Date().getFullYear())) continue;
      const slug = (p.url.split('/').pop() || 'programa').toLowerCase().replace(/\.pdf.*$/, '').replace(/[^a-z0-9]+/g, '-').slice(0, 30);
      procesar(normalizarHoras(pdf.texto), { anyo, slug, url: p.url, etiqueta: `programa: ${slug.slice(0, 40)}` });
    } catch (e) {
      console.error('puertocruz programa fallo', p.url, e);
    }
  }

  if (verbenas.length === 0) {
    avisar(MUNI, 'sin-eventos', PUERTOCRUZ_URL, 'sin verbenas vigentes (Grandes Fiestas de Julio pasadas)');
  }

  cache = { at: Date.now(), data: verbenas };
  return verbenas;
}
