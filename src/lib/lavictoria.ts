import {
  clasificarDetalle,
  clasificarTitulo,
  esContenedor,
  extraerBailesSinHora,
  extraerSubEventos,
  horaPrevia,
  lugarCercano,
  lugarPosterior,
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

// La Victoria de Acentejo: WordPress con REST ABIERTA (como Los Realejos).
// Slugs planos sin año (/el-verbenazo-.../): la vigencia sale del campo
// `date` del REST, no de la URL. Categoría Fiestas = 52. Web de fiestas
// dedicada (fiestas.) con página /programa/ en HTML ("### 19 Miércoles" +
// "HH:MM lugar + acto") y PDF en mediateca (AAFF-Programa-2026.pdf, CON
// texto). El PDF festivo no trae cabeceras de día en texto (solo el
// quinario religioso): se procesa solo si la página /programa/ no dio
// eventos, para no duplicar con fechas erróneas. Fiestas de Agosto
// (2026 verificado: 21 ago–2 sep; Gran Verbena 2 sep 23:00).
const BASE = 'https://www.lavictoriadeacentejo.es';
const REST = `${BASE}/wp-json/wp/v2`;
const FIESTAS = 'https://fiestas.lavictoriadeacentejo.es';
const PROGRAMA_URL = `${FIESTAS}/programa/`;
export const LAVICTORIA_URL = PROGRAMA_URL;

const MUNI = 'La Victoria';
const NUCLEOS = ['La Victoria', 'San Juan', 'El Tagoro', 'Los Arroyos', 'La Munda',
  'Santo Domingo', 'Bubaque', 'El Pinar', 'Los Laureles', 'El Calvario'];

let cache: { at: number; data: Verbena[] } | null = null;
const TTL = 1000 * 60 * 60;
const PAUSA_MS = 1200;
const MAX_DETALLES = 10;
const MAX_PDFS = 5;
const MAX_PDF_BYTES = 12 * 1024 * 1024;

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface PostRest {
  date?: string;
  link?: string;
  title?: { rendered?: string };
  content?: { rendered?: string };
}

interface Candidato { titulo: string; cuerpo: string; url: string; anyo: string }

const RE_VICTORIA = /victoria|acentejo|encarnaci[oó]n|tagoro|pinar|terrero|atrevida|verbenazo|romer[ií]a|verbena|baile|orquesta|programa|fiesta|tributo|discoteca/i;

function sinHtml(s: string): string {
  return (s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Descubre posts vía REST (categoría Fiestas 52 + búsquedas). */
async function descubrir(): Promise<Candidato[]> {
  const out: Candidato[] = [];
  const seen = new Set<string>();
  const vigente = String(new Date().getFullYear());
  const mete = (p: PostRest) => {
    const titulo = sinHtml(p.title?.rendered);
    const url = p.link || '';
    if (!titulo || titulo.length < 10 || !url.startsWith(BASE + '/') || seen.has(url)) return;
    // Slugs sin año: la vigencia la da el campo date del REST.
    if (!p.date?.startsWith(vigente)) return;
    if (!clasificarTitulo(titulo).esVerbena && !esContenedor(titulo) && !RE_VICTORIA.test(titulo)) return;
    seen.add(url);
    out.push({ titulo, cuerpo: p.content?.rendered || '', url, anyo: vigente });
  };
  const queries = ['verbena', 'orquesta', 'baile', 'fiestas', 'tributo', 'romeria'];
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
      // Categoría Fiestas (id 52): repesca lo reciente.
      const j = JSON.parse(await fetchText(
        `${REST}/posts?categories=52&per_page=15&_fields=date,link,title,content`));
      if (Array.isArray(j)) j.forEach(mete);
    } catch { /* sin repesca */ }
  }
  return out.slice(0, MAX_DETALLES);
}

/** PDFs de programa en la mediateca de la web de fiestas (año vigente). */
async function descubrirProgramas(): Promise<{ url: string; anyo: string }[]> {
  const vigente = String(new Date().getFullYear());
  const seen = new Set<string>();
  const out: { url: string; anyo: string }[] = [];
  for (const q of ['programa', 'fiestas']) {
    try {
      const j = JSON.parse(await fetchText(
        `${FIESTAS}/wp-json/wp/v2/media?search=${encodeURIComponent(q)}&per_page=30&_fields=date,source_url,mime_type`));
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

function nucleoDe(texto: string): string {
  const low = texto.toLowerCase();
  for (const n of NUCLEOS) if (low.includes(n.toLowerCase())) return n;
  return '';
}

/** "Explanada anexa al Terrero Municipal de Luchas" no es recinto para el
 *  clasificador (lugarCercano): se aliasa a Recinto para no perder el lugar
 *  de todas las verbenas (incluida la errata "Terreno" de la web y el
 *  artículo "la" -> "el" para no romper la gramática). */
function aliasLugares(cuerpo: string): string {
  return cuerpo
    .replace(/la Explanada anexa al (Terreno|Terrero) Municipal de Luchas/gi, 'el Recinto Terrero Municipal de Luchas')
    .replace(/Explanada anexa al (Terreno|Terrero) Municipal de Luchas/gi, 'Recinto Terrero Municipal de Luchas')
    .replace(/la Explanada anexa al TM de Luchas/gi, 'el Recinto TM de Luchas')
    .replace(/Explanada anexa al TM de Luchas/gi, 'Recinto TM de Luchas');
}

/** Fiestas de Agosto: 19–31 ago + 1–2 sep (2026 verificado). Sin mes
 *  explícito en la sección, el día manda (>=15 -> agosto, si no sept). */
function mesFiestas(dia: number): string {
  return dia >= 15 ? '08' : '09';
}

export async function obtenerVerbenasLaVictoria(): Promise<Verbena[]> {
  if (cache && Date.now() - cache.at < TTL) return cache.data;
  const verbenas: Verbena[] = [];
  const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const push = (v: Verbena) => {
    // Evita duplicados del mismo acto entre noticia, programa y PDF: mismo
    // id, mismo día+hora+lineup, o mismo día+hora con un título contenido en
    // el otro ("Gran Verbena" vs "Gran Verbena, que se celebrará en...").
    // Gana la primera fuente (programa web, con hora/lugar exactos).
    const dup = verbenas.some((x) => {
      if (x.id === v.id) return true;
      if (x.day !== v.day || x.hora !== v.hora) return false;
      if (x.orquestas.length > 0 && v.orquestas.length > 0) {
        return x.orquestas.some((o) => v.orquestas.includes(o));
      }
      const a = norm(x.titulo), b = norm(v.titulo);
      const corto = a.length <= b.length ? a : b, largo = a.length <= b.length ? b : a;
      return corto.length > 8 && largo.includes(corto);
    });
    if (!dup) verbenas.push(v);
  };

  /** Parte un texto (noticia, programa web o PDF) por días y extrae verbenas. */
  const procesar = (cuerpo: string, opts: { anyo: string; slug: string; url: string; etiqueta: string; reglaMes?: (dia: number) => string }) => {
    const limpio = aliasLugares(cuerpo);
    const ctx = mesContexto(limpio);
    const ref = ctx.mes && opts.anyo ? { mes: ctx.mes, anyo: opts.anyo } : undefined;
    const lugar = lugarCercano(limpio.slice(0, 2000), opts.etiqueta) || nucleoDe(limpio) || MUNI;
    let mesPrev = '', anyoPrev = '';
    const secciones = partirPorDias(limpio, ref);
    for (const [i, sec] of secciones.entries()) {
      if (sec.mes) mesPrev = sec.mes;
      if (sec.anyo) anyoPrev = sec.anyo;
      // La prosa nombra el mes en otra sección ("...21 de agosto... sábado
      // 5 se celebrará..."): se hereda del encabezado anterior o posterior.
      let mes = mesANum(sec.mes) || mesANum(mesPrev) || ctx.mes;
      if (!mes) {
        for (let j = i - 1; j >= 0 && !mes; j--) {
          if (secciones[j].mes && /de\s+[a-záéíóúñ]+/i.test(secciones[j].texto.slice(0, 60))) mes = mesANum(secciones[j].mes);
        }
        for (let j = i + 1; j < secciones.length && !mes; j++) {
          if (secciones[j].mes && /de\s+[a-záéíóúñ]+/i.test(secciones[j].texto.slice(0, 60))) mes = mesANum(secciones[j].mes);
        }
      }
      if (!mes && opts.reglaMes) mes = opts.reglaMes(sec.dia);
      if (!mes) continue;
      const day = `${String(sec.dia).padStart(2, '0')}-${mes}-${sec.anyo || anyoPrev || opts.anyo}`;
      const lineas = [
        ...extraerSubEventos(sec.texto).map((s) => ({ titulo: s.titulo, hora: s.hora, orquestas: s.orquestas, extra: 0 })),
        ...extraerBailesSinHora(sec.texto).map((s) => ({ titulo: s.titulo, hora: s.hora || horaPrevia(sec.texto, s.titulo), orquestas: s.orquestas, extra: s.explicita ? 2 : 0 }))
      ];
      for (const l of lineas) {
        const lugarLinea = lugarCercano(sec.texto, l.titulo) || lugarPosterior(sec.texto, l.titulo) || lugar;
        const cls = clasificarDetalle(l.titulo, ventana(sec.texto, l.titulo, 400), l.hora, lugarLinea, l.extra);
        if (!cls.esVerbena) continue;
        push({
          id: `lavictoria-${opts.slug.slice(0, 20)}-${l.hora.replace(':', '') || 'sh'}-${day}-${l.titulo.split(/\s+/).slice(0, 3).join(' ')}`.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9-]+/g, '-'),
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
    console.error('lavictoria índice fallo', e);
  }

  // Página del programa (web de fiestas) PRIMERO: trae fechas ("19
  // Miércoles") y horas exactas; al fusionar, su hora prevalece sobre la
  // de las noticias (horaPrevia aproximada).
  try {
    await espera(PAUSA_MS);
    const html = await fetchText(PROGRAMA_URL);
    rastrearProgramas(MUNI, html, FIESTAS);
    const cuerpo = normalizarHoras(textoConSaltos(html));
    const anyo = anyoDelTexto(cuerpo) || String(new Date().getFullYear());
    if (anyo === String(new Date().getFullYear())) {
      procesar(cuerpo, { anyo, slug: 'programa-web', url: PROGRAMA_URL, etiqueta: 'programa web fiestas', reglaMes: mesFiestas });
    }
  } catch (e) {
    console.error('lavictoria programa web fallo', e);
  }

  for (const it of items) {
    try {
      const cuerpo = normalizarHoras(textoConSaltos(it.cuerpo));
      const slug = it.url.split('/').filter(Boolean).pop() || 'noticia';
      procesar(`${it.titulo}\n${cuerpo}`, { anyo: it.anyo, slug, url: it.url, etiqueta: `noticia: ${it.titulo.slice(0, 50)}` });
    } catch (e) {
      console.error('lavictoria noticia fallo', it.url, e);
    }
  }

  // PDF de mediateca: solo si la web no dio eventos (su parte festiva no
  // trae cabeceras de día en texto y fecharía mal duplicando la web).
  if (verbenas.length === 0) {
    for (const p of await descubrirProgramas()) {
      try {
        await espera(PAUSA_MS);
        const head = await fetch(p.url, { method: 'HEAD' });
        const tam = Number(head.headers.get('content-length') || 0);
        if (tam > MAX_PDF_BYTES) {
          console.warn(`lavictoria pdf pesado (${(tam / 1048576).toFixed(1)} MB) omitido: ${p.url}`);
          continue;
        }
        const pdf = await obtenerTextoPdf(p.url, MAX_PDF_BYTES, true, MUNI);
        if (pdf.escaneado) continue; // central (pdf.ts) ya intentó el OCR auto
        const anyo = anyoDelTexto(pdf.texto) || p.anyo;
        if (anyo !== String(new Date().getFullYear())) continue;
        const slug = (p.url.split('/').pop() || 'programa').toLowerCase().replace(/\.pdf.*$/, '').replace(/[^a-z0-9]+/g, '-').slice(0, 30);
        procesar(normalizarHoras(pdf.texto), { anyo, slug, url: p.url, etiqueta: `programa: ${slug.slice(0, 40)}`, reglaMes: mesFiestas });
      } catch (e) {
        console.error('lavictoria programa fallo', p.url, e);
      }
    }
  }

  if (verbenas.length === 0) {
    avisar(MUNI, 'sin-eventos', LAVICTORIA_URL, 'sin verbenas vigentes (Fiestas de Agosto 21 ago-2 sep)');
  }

  cache = { at: Date.now(), data: verbenas };
  return verbenas;
}
