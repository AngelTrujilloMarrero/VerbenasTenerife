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

// Santiago del Teide: WordPress Divi con REST bloqueada (401). Slugs
// planos sin año y fecha visible mes-primero ("Sep 11, 2026",
// "julio 17, 2024"): la vigencia sale del detalle, nunca del slug.
// Agenda /eventos con fichas /evento/slug ("septiembre 11 @ 9:00 am" +
// "Este evento ha pasado"). Títulos con negrita unicode (𝐅𝐑𝐈𝐃𝐀𝐘)
// que exige NFKD antes de clasificar. Núcleos con fiestas propias
// (Tamaimo Santa Ana, Arguayo San Isidro, Los Gigantes Carnaval).
const BASE = 'https://www.santiagodelteide.es';
export const SANTIAGO_URL = `${BASE}/eventos`;

const MUNI = 'Santiago del Teide';
const NUCLEOS = ['Tamaimo', 'Los Gigantes', 'Puerto de Santiago', 'Arguayo',
  'El Molledo', 'El Retamar', 'Santiago del Teide'];

let cache: { at: number; data: Verbena[] } | null = null;
const TTL = 1000 * 60 * 60;
const PAUSA_MS = 1200;
const MAX_DETALLES = 12;
const MAX_PDFS = 5;
const MAX_PDF_BYTES = 12 * 1024 * 1024;

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Candidato { titulo: string; url: string }

/** La web usa negrita unicode (𝐅𝐑𝐈𝐃𝐀𝐘) que rompe los regex: NFKD la
 *  devuelve a ASCII y se tiran los diacríticos combinantes (si no, "sábado"
 *  deja de casar). Se aplica a títulos y cuerpos antes de clasificar. */
const nfkd = (s: string): string =>
  s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');

const RE_SANTIAGO = /santiago|tamaimo|gigantes|arguayo|molledo|retamar|buganvilla|romer[ií]a|verbena|baile|orquesta|programa|fiesta|tributo|carnaval|mascara|reina|gala/i;

/** Descubre eventos y noticias en portada, calendario y buscador (?s=). */
async function descubrir(): Promise<Candidato[]> {
  const out: Candidato[] = [];
  const seen = new Set<string>();
  const mete = (titulo: string, url: string) => {
    const t = nfkd(titulo).trim().replace(/\s+/g, ' ');
    if (!t || t.length < 12 || seen.has(url)) return;
    if (!url.startsWith(BASE + '/') || url === BASE + '/') return;
    if (/\.(pdf|jpg|jpeg|png|webp)$/i.test(url.split('?')[0])) return;
    if (!clasificarTitulo(t).esVerbena && !esContenedor(t) && !RE_SANTIAGO.test(t)) return;
    seen.add(url);
    out.push({ titulo: t, url });
  };
  const paginas = [`${BASE}/`, `${BASE}/noticias`, SANTIAGO_URL,
    `${BASE}/?s=verbena`, `${BASE}/?s=fiestas`, `${BASE}/?s=orquesta`, `${BASE}/?s=baile`, `${BASE}/?s=carnaval`];
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
    const slug = decodeURIComponent(c.url).split('/').filter(Boolean).pop() || c.url;
    if (!porSlug.has(slug)) porSlug.set(slug, c);
  }
  return [...porSlug.values()].slice(0, MAX_DETALLES);
}

/** Año de la fecha visible ("Sep 11, 2026" / "julio 17, 2024"); los slugs
 *  van sin año. Sin fecha válida se devuelve el actual. */
function anyoDe(html: string): string {
  const m = html.match(/([a-záéíóúñ]+)\s+(\d{1,2}),?\s*(20\d{2})/i);
  if (m && mesANum(m[1])) return m[3];
  return String(new Date().getFullYear());
}

function nucleoDe(texto: string): string {
  const low = texto.toLowerCase();
  for (const n of NUCLEOS) if (low.includes(n.toLowerCase())) return n;
  return '';
}

/** Ficha de /evento/: "septiembre 11 @ 9:00 am - 11:30 pm" (mes-primero).
 *  Sin año visible se asume el vigente (van a celebradas si ya pasó). */
function fichaEvento(cuerpo: string): { day: string; hora: string } | null {
  const m = cuerpo.match(/([a-záéíóúñ]+)\s+(\d{1,2})\s*@\s*(\d{1,2}):(\d{2})\s*(am|pm)?/i);
  if (!m) return null;
  const mes = mesANum(m[1]);
  if (!mes) return null;
  let h = parseInt(m[3], 10);
  if (/pm/i.test(m[5] || '') && h < 12) h += 12;
  if (/am/i.test(m[5] || '') && h === 12) h = 0;
  return {
    day: `${m[2].padStart(2, '0')}-${mes}-${new Date().getFullYear()}`,
    hora: `${String(h).padStart(2, '0')}:${m[4]}`
  };
}

export async function obtenerVerbenasSantiago(): Promise<Verbena[]> {
  if (cache && Date.now() - cache.at < TTL) return cache.data;
  const verbenas: Verbena[] = [];
  const push = (v: Verbena) => {
    // Evita duplicados del mismo acto entre evento y noticia.
    const dup = verbenas.some((x) =>
      x.id === v.id ||
      (x.day === v.day && x.hora === v.hora &&
        x.orquestas.length > 0 && v.orquestas.length > 0 &&
        x.orquestas.some((o) => v.orquestas.includes(o))));
    if (!dup) verbenas.push(v);
  };

  /** Parte un texto por días y extrae verbenas (día fijo en fichas). */
  const procesar = (cuerpo: string, opts: { anyo: string; slug: string; url: string; etiqueta: string; diaFijo?: string; horaFicha?: string }) => {
    const limpio = nfkd(cuerpo).replace(/del tamaimero/gi, 'de Tamaimo');
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
          id: `santiago-${opts.slug.slice(0, 20)}-${l.hora.replace(':', '') || 'sh'}-${sec.day}-${l.titulo.split(/\s+/).slice(0, 3).join(' ')}`.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9-]+/g, '-'),
          titulo: l.titulo, day: sec.day, hora: l.hora, municipio: MUNI,
          lugar: lugarLinea, orquestas: l.orquestas,
          tipo: tipoDeEvento(l.titulo), url: opts.url,
          score: cls.score, motivos: [...cls.motivos, opts.etiqueta]
        });
      }
    }
  };

  /** Secciones de noticia con fecha resuelta (herencia ambos sentidos). */
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
    console.error('santiago índice fallo', e);
  }

  const htmlCache: string[] = [];
  for (const it of items) {
    try {
      await espera(PAUSA_MS);
      const d = await fetchText(it.url);
      htmlCache.push(d);
      const anyo = anyoDe(d);
      if (anyo !== String(new Date().getFullYear())) {
        console.warn(`santiago post antiguo (${anyo}) descartado: ${it.url}`);
        continue;
      }
      const cuerpo = normalizarHoras(textoConSaltos(nfkd(d)));
      const slug = decodeURIComponent(it.url).split('/').filter(Boolean).pop() || 'noticia';
      // Ficha /evento/ con día explícito: manda sobre las cabeceras.
      const ficha = it.url.includes('/evento/') ? fichaEvento(cuerpo) : null;
      procesar(cuerpo, ficha
        ? { anyo, slug, url: it.url, etiqueta: `ficha: ${it.titulo.slice(0, 50)}`, diaFijo: ficha.day, horaFicha: ficha.hora }
        : { anyo, slug, url: it.url, etiqueta: `noticia: ${it.titulo.slice(0, 50)}` });
    } catch (e) {
      console.error('santiago detalle fallo', it.url, e);
    }
  }

  // PDFs del año vigente enlazados (programas).
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
      if (!/programa|fiesta|santiago|tamaimo|verbena|carnaval/i.test(href)) continue;
      vigentes.add(href);
    }
  }
  for (const url of vigentes) {
    try {
      await espera(PAUSA_MS);
      const head = await fetch(url, { method: 'HEAD' });
      const tam = Number(head.headers.get('content-length') || 0);
      if (tam > MAX_PDF_BYTES) {
        console.warn(`santiago pdf pesado (${(tam / 1048576).toFixed(1)} MB) omitido: ${url}`);
        continue;
      }
      const pdf = await obtenerTextoPdf(url, MAX_PDF_BYTES, false, MUNI);
      if (pdf.escaneado) continue; // central (pdf.ts) ya intentó el OCR auto
      const anyo = anyoDelTexto(pdf.texto) || url.match(/(20\d{2})/)?.[1] || String(new Date().getFullYear());
      if (anyo !== String(new Date().getFullYear())) continue;
      const slug = (url.split('/').pop() || 'programa').toLowerCase().replace(/\.pdf.*$/, '').replace(/[^a-z0-9]+/g, '-').slice(0, 30);
      procesar(normalizarHoras(pdf.texto), { anyo, slug, url, etiqueta: `programa: ${slug.slice(0, 40)}` });
    } catch (e) {
      console.error('santiago programa fallo', url, e);
    }
  }

  if (verbenas.length === 0) {
    avisar(MUNI, 'sin-eventos', SANTIAGO_URL, 'sin verbenas vigentes (Tamaimo Santa Ana, Arguayo San Isidro)');
  }

  cache = { at: Date.now(), data: verbenas };
  return verbenas;
}
