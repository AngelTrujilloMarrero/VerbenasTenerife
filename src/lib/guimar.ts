import * as cheerio from 'cheerio';
import {
  clasificarDetalle,
  clasificarTitulo,
  esContenedor,
  extraerBailesSinHora,
  extraerSubEventos,
  lugarCercano,
  mesANum,
  mesContexto,
  normalizarHoras,
  partirPorDias,
  recortarProsa,
  tipoDeEvento,
  ventana
} from './classifier.js';
import { fetchText, textoConSaltos } from './http.js';
import { avisar, rastrearProgramas } from './avisos.js';
import { anyoDelTexto, obtenerTextoPdf } from './pdf.js';
import type { Verbena } from './types.js';

// Güímar: Drupal 9, sin REST. Noticias en /noticias (?page=N) con fecha
// visible ("28 Aug") y detalle con programa inline; PDFs de fiestas en
// /sites/default/files/YYYY-MM/*.pdf enlazados como "Descargar PDF:".
// Fiestas eje: El Socorro (sept), San Carlos, Carnaval. Formato programa:
// día "Sábado 5 septiembre" + líneas "HH:MM Lugar. Acto". Solo año vigente.
const BASE = 'https://www.guimar.es';
export const GUIMAR_URL = `${BASE}/noticias`;

const MUNI = 'Güímar';
const NUCLEOS = ['Güímar', 'El Socorro', 'San Juan', 'La Hoya', 'Guaza', 'Chacona',
  'La Puente', 'El Puertito', 'San Pedro', 'La Asomada', 'El Calvario'];

let cache: { at: number; data: Verbena[] } | null = null;
const TTL = 1000 * 60 * 60;
const PAUSA_MS = 1200;
const MAX_DETALLES = 8;
const MAX_PDFS = 5;
const MAX_PDF_BYTES = 8 * 1024 * 1024;

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Candidato { titulo: string; url: string; anyo: string }

const RE_GUIMAR = /socorro|carlos|carnaval|verbena|baile|orquesta|programa|fiesta|romer[ií]a|salsa|magos/i;

// Fecha visible del teaser ("28 Aug") o del detalle ("August 28, 2026").
const MESES_EN: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12'
};

function anyoVisible(html: string, url: string): string {
  const vigente = String(new Date().getFullYear());
  const mSlug = url.match(/(20\d{2})/);
  if (mSlug) return mSlug[1];
  // "August 28, 2026" del detalle o "2026-08" de los adjuntos.
  const mDet = html.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s*(20\d{2})/i)
    || html.match(/\/sites\/default\/files\/(20\d{2})-\d{2}\//);
  if (mDet) return mDet[2] || mDet[1];
  return vigente;
}

async function descubrir(): Promise<Candidato[]> {
  const out: Candidato[] = [];
  const seen = new Set<string>();
  const vigente = String(new Date().getFullYear());
  const mete = (titulo: string, url: string, fechaTxt: string) => {
    const t = titulo.trim().replace(/\s+/g, ' ');
    if (!t || t.length < 10 || seen.has(url)) return;
    if (!url.startsWith(BASE + '/') || url === BASE + '/') return;
    if (/\.(pdf|jpg|jpeg|png|webp)$/i.test(url.split('?')[0])) return;
    // Año del slug; si no, de la fecha visible del teaser ("28 Aug" = vigente
    // solo si está en la primera página; las paginadas traen años viejos).
    let anyo = url.match(/(20\d{2})/)?.[1] || '';
    if (!anyo) {
      const m = fechaTxt.match(/(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i);
      // Sin año explícito solo vale si la noticia es reciente (pág 1).
      if (!m) return;
      anyo = vigente;
    }
    if (anyo !== vigente) return;
    if (!clasificarTitulo(t).esVerbena && !esContenedor(t) && !RE_GUIMAR.test(t)) return;
    seen.add(url);
    out.push({ titulo: t, url, anyo });
  };

  const paginas = [`${BASE}/noticias`, `${BASE}/noticias?page=1`, `${BASE}/taxonomy/term/19`];
  for (const page of paginas) {
    try {
      const html = await fetchText(page);
      rastrearProgramas(MUNI, html, BASE);
      const $ = cheerio.load(html);
      // Teasers: título + fecha visible cercana.
      $('a[href]').each((_, a) => {
        let href = $(a).attr('href') || '';
        if (href.startsWith('/')) href = BASE + href;
        if (!href.startsWith(BASE + '/')) return;
        if (href === BASE + '/' || href.endsWith('/noticias') || href.includes('/taxonomy/')) return;
        const titulo = $(a).text().trim().replace(/\s+/g, ' ');
        if (!titulo || titulo.length < 10) return;
        // Fecha del teaser: texto del artículo padre ("28 Aug").
        const padre = $(a).closest('article, li, div.views-row, div.node').text();
        const fm = (padre || '').match(/(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i);
        mete(titulo, href, fm ? fm[0] : '');
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

function nucleoDe(texto: string): string {
  const low = texto.toLowerCase();
  for (const n of NUCLEOS) if (low.includes(n.toLowerCase())) return n;
  return '';
}

function mesDominante(texto: string): string {
  // Socorro: el tríptico es secuencial (agosto y luego septiembre); el mes
  // de cada sección lo pone su cabecera ("Sábado 19 de septiembre"). El
  // dominante de respaldo cuenta "X de mes" para no confundir "agosto"
  // suelto con "30 de agosto".
  const meses = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'setiembre', 'octubre', 'noviembre', 'diciembre'];
  const low = ' ' + texto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '') + ' ';
  let mejor = '', mejorN = 0;
  for (const m of meses) {
    const n = (low.match(new RegExp(`\\d{1,2} de ${m}\\b`, 'g')) || []).length;
    if (n > mejorN) { mejorN = n; mejor = m; }
  }
  return mejorN >= 1 ? mesANum(mejor) : '';
}

function lugarContinuacion(seccion: string, titulo: string): string {
  const idx = seccion.indexOf(titulo.slice(0, 22));
  if (idx === -1) return '';
  const post = seccion.slice(idx + titulo.length, idx + titulo.length + 300);
  const m = post.match(/A continuaci[oó]n\s*[–-]\s*([^.\n]{3,80})/i);
  if (!m) return '';
  const r = m[1].match(/(Plaza|Parque|Cancha|Recinto|Auditorio|Teatro|Pabell[oó]n|Polideportivo|Mercado|Iglesia|Ermita|Escenario|Campo|Calle|Casa|Caser[ií]o|Atrio|Ermita)[ \t]+[^.\n,]{2,40}/i);
  if (!r) return '';
  return recortarProsa(r[0].trim().replace(/\s+\d{1,2}:\d{2}h?\b.*$/, '').trim());
}

function horaPreviaDoc(base: string, titulo: string, radio = 600): string {
  const enTitulo = titulo.match(/(\d{1,2}:\d{2})/);
  if (enTitulo) return enTitulo[1];
  const idx = base.lastIndexOf(titulo.slice(0, 30));
  if (idx === -1) return '';
  const prev = base.slice(Math.max(0, idx - radio), idx);
  const rangos = [...prev.matchAll(/(\d{1,2}:\d{2})\s*a(?:\s*las)?\s*\d{1,2}:\d{2}/gi)].map((x) => x[1]);
  if (rangos.length) return rangos[rangos.length - 1];
  const sueltas = [...prev.matchAll(/(\d{1,2}:\d{2})/g)].map((x) => x[1]);
  return sueltas.length ? sueltas[sueltas.length - 1] : '';
}

function juntarHoraLugar(cuerpo: string): string {
  return cuerpo.replace(
    /^(\d{1,2}:\d{2})\s*h(?:oras?)?\.?\s*[–-]\s*([^.\n]{2,80})\n(?=(?!lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo\b)[A-ZÁÉÍÓÚÑ“"0-9])/gm,
    '$1 - $3 ($2)');
}

export async function obtenerVerbenasGuimar(): Promise<Verbena[]> {
  if (cache && Date.now() - cache.at < TTL) return cache.data;
  const verbenas: Verbena[] = [];
  const push = (v: Verbena) => {
    if (!verbenas.some((x) => x.id === v.id)) verbenas.push(v);
  };

  const procesar = (cuerpo: string, opts: { anyo: string; slug: string; url: string; etiqueta: string }) => {
    const limpio = cuerpo.replace(/SÁBAD O/gi, 'SÁBADO').replace(/D OMINGO/gi, 'DOMINGO');
    const ctx = mesContexto(limpio);
    const mesDoc = ctx.mes || mesDominante(limpio);
    const ref = mesDoc && opts.anyo ? { mes: mesDoc, anyo: opts.anyo } : undefined;
    const lugarDoc = limpio.length < 3000
      ? lugarCercano(limpio.slice(0, 2000), opts.etiqueta) || nucleoDe(limpio) || MUNI
      : nucleoDe(limpio) || MUNI;
    let mesPrev = '', anyoPrev = '';
    const secciones = partirPorDias(juntarHoraLugar(limpio), ref);
    for (const [i, sec] of secciones.entries()) {
      if (sec.mes) mesPrev = sec.mes;
      if (sec.anyo) anyoPrev = sec.anyo;
      // Sin mes propio, el mes lo decide la cabecera más cercana con "día de
      // mes" ("Sábado 29 y [Domingo 30 de agosto]", "Jueves 3 [septiembre]"):
      // hacia atrás si es "de MES", si no hacia adelante; nunca el dominante.
      let mes = mesANum(sec.mes);
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
      const contextoHora = (secciones[i - 1]?.texto.slice(-600) || '') + sec.texto;
      const lugarSec = nucleoDe(sec.texto) || MUNI;
      const lineas = [
        ...extraerSubEventos(sec.texto).map((s) => ({ titulo: s.titulo, hora: s.hora, orquestas: s.orquestas, extra: 0 })),
        ...extraerBailesSinHora(sec.texto).map((s) => ({
          titulo: s.titulo, hora: horaPreviaDoc(contextoHora, s.titulo), orquestas: s.orquestas, extra: s.explicita ? 2 : 0
        }))
      ];
      for (const l of lineas) {
        const lugarLinea = lugarCercano(sec.texto, l.titulo) || lugarContinuacion(sec.texto, l.titulo) || (limpio.length < 3000 ? lugarDoc : lugarSec);
        const cls = clasificarDetalle(l.titulo, ventana(sec.texto, l.titulo, 400), l.hora, lugarLinea, l.extra);
        if (!cls.esVerbena) continue;
        push({
          id: `guimar-${opts.slug.slice(0, 20)}-${l.hora.replace(':', '') || 'sh'}-${day}-${l.titulo.split(/\s+/).slice(0, 3).join(' ')}`.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9-]+/g, '-'),
          titulo: l.titulo, day, hora: l.hora, municipio: MUNI,
          lugar: lugarLinea, orquestas: l.orquestas,
          tipo: tipoDeEvento(l.titulo), url: opts.url,
          score: cls.score, motivos: [...cls.motivos, opts.etiqueta]
        });
      }
    }
  };

  let items: Candidato[] = [];
  const htmlCache: string[] = [];
  try {
    items = await descubrir();
    for (const p of [`${BASE}/noticias`, `${BASE}/taxonomy/term/19`]) {
      try { htmlCache.push(await fetchText(p)); } catch {}
    }
  } catch (e) {
    console.error('guimar índice fallo', e);
  }

  for (const it of items) {
    try {
      await espera(PAUSA_MS);
      const d = await fetchText(it.url);
      htmlCache.push(d);
      const cuerpo = normalizarHoras(textoConSaltos(d));
      const anyo = anyoVisible(d, it.url);
      if (anyo !== String(new Date().getFullYear())) {
        console.warn(`guimar post antiguo (${anyo}) descartado: ${it.url}`);
        continue;
      }
      const slug = it.url.split('/').filter(Boolean).pop() || 'noticia';
      procesar(cuerpo, { anyo, slug, url: it.url, etiqueta: `noticia: ${it.titulo.slice(0, 50)}` });
    } catch (e) {
      console.error('guimar detalle fallo', it.url, e);
    }
  }

  // PDFs del año vigente enlazados como "Descargar PDF:" en las noticias.
  const rePdf = /(?:href|src)="([^"]+\.pdf[^"]*)"/gi;
  const vigentes = new Set<string>();
  for (const html of htmlCache) {
    let m: RegExpExecArray | null;
    rePdf.lastIndex = 0;
    while ((m = rePdf.exec(html)) !== null && vigentes.size < MAX_PDFS) {
      let href = m[1];
      if (!href.startsWith('http')) {
        if (!href.startsWith('/')) continue;
        href = BASE + href;
      }
      if (vigentes.has(href)) continue;
      const anyo = href.match(/(20\d{2})/)?.[1] || '';
      if (anyo && anyo !== String(new Date().getFullYear())) continue;
      if (!anyo && !href.includes(String(new Date().getFullYear()))) continue;
      if (!/programa|fiesta|socorro|carmen|verbena|romer/i.test(href)) continue;
      vigentes.add(href);
    }
  }
  for (const url of vigentes) {
    try {
      await espera(PAUSA_MS);
      const head = await fetch(url, { method: 'HEAD' });
      const tam = Number(head.headers.get('content-length') || 0);
      if (tam > MAX_PDF_BYTES) {
        console.warn(`guimar pdf pesado (${(tam / 1048576).toFixed(1)} MB) omitido: ${url}`);
        continue;
      }
      const pdf = await obtenerTextoPdf(url, undefined, false, MUNI);
      if (pdf.escaneado) continue;
      const anyo = anyoDelTexto(pdf.texto) || url.match(/(20\d{2})/)?.[1] || String(new Date().getFullYear());
      if (anyo !== String(new Date().getFullYear())) continue;
      const slug = (url.split('/').pop() || 'programa').toLowerCase().replace(/\.pdf.*$/, '').replace(/[^a-z0-9]+/g, '-').slice(0, 30);
      procesar(normalizarHoras(pdf.texto), { anyo, slug, url, etiqueta: `programa: ${slug.slice(0, 40)}` });
    } catch (e) {
      console.error('guimar programa fallo', url, e);
    }
  }

  if (verbenas.length === 0) {
    avisar(MUNI, 'sin-eventos', GUIMAR_URL, 'sin verbenas vigentes (revisa noticias/fiestas)');
  }

  cache = { at: Date.now(), data: verbenas };
  return verbenas;
}
