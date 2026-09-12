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

// El Sauzal: WordPress (Bones), REST bloqueado (401). Todo en TEXTO web:
// /actividad/slug con ficha estructurada (DÍA/HORA/LUGAR/ACTUACIONES y
// "Este evento ha pasado") + noticia del programa. PDFs de fiestas
// escaneados (San Pedro 2026: 12 págs sin texto) -> aviso pdf-escaneado.
// Formato inline: "MIÉRCOLES 29 / A las 20.00 h, en la plaza X: Acto".
// Solo año vigente: slugs y titulares llevan año o fecha visible.
const BASE = 'https://www.elsauzal.es';
export const ELSAUZAL_URL = `${BASE}/actividades/`;

const MUNI = 'El Sauzal';
const NUCLEOS = ['El Sauzal', 'Ravelo', 'Los Ángeles', 'El Calvario', 'La Piedad',
  'La Santa Cruz', 'La Costa', 'El Puertito', 'San Pedro'];

let cache: { at: number; data: Verbena[] } | null = null;
const TTL = 1000 * 60 * 60;
const PAUSA_MS = 1200;
const MAX_DETALLES = 10;
const MAX_PDFS = 5;
const MAX_PDF_BYTES = 8 * 1024 * 1024;

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Candidato { titulo: string; url: string; anyo: string }

const RE_SAUZAL = /ravelo|san pedro|angeles|verbena|baile|orquesta|programa|fiesta|romer[ií]a|magos|carnaval|noche|tributo/i;

function anyoVisible(html: string, url: string): string {
  const vigente = String(new Date().getFullYear());
  const mSlug = url.match(/(20\d{2})/);
  if (mSlug) return mSlug[1];
  // "Posted 12 septiembre, 2026" o "12 septiembre, 2026" del detalle.
  const mDet = html.match(/(\d{1,2})\s+de\s+([a-záéíóúñ]+),?\s*(20\d{2})/i)
    || html.match(/(\d{1,2})\s+([a-záéíóúñ]+),?\s*(20\d{2})/i)
    || html.match(/(20\d{2})/);
  if (mDet) return mDet[mDet.length - 1];
  return vigente;
}

/** Ficha estructurada de /actividad/: DÍA/HORA/LUGAR/ACTUACIONES. */
function fichaActividad(cuerpo: string): { day: string; hora: string; lugar: string; titulo: string } | null {
  const dia = cuerpo.match(/D[IÍ]A:\s*([^\n]{3,80})/i)?.[1]?.trim() || '';
  const hora = cuerpo.match(/HORA:\s*([^\n]{3,40})/i)?.[1]?.trim() || '';
  const lugar = cuerpo.match(/LUGAR:\s*([^\n]{3,80})/i)?.[1]?.trim() || '';
  const acts = cuerpo.match(/ACTUACIONES:\s*([^\n]{3,160})/i)?.[1]?.trim() || '';
  if (!dia && !acts) return null;
  // "Sábado 23 de mayo de 2026." -> day
  const mDia = dia.match(/(\d{1,2})\s+de\s+([a-záéíóúñ]+)(?:\s+de\s+(20\d{2}))?/i);
  // "22.00 horas." -> hora
  const mHora = (hora || dia).match(/(\d{1,2})[.:](\d{2})/);
  return {
    day: mDia && mesANum(mDia[2]) ? `${mDia[1].padStart(2, '0')}-${mesANum(mDia[2])}-${mDia[3] || new Date().getFullYear()}` : '',
    hora: mHora ? `${mHora[1].padStart(2, '0')}:${mHora[2]}` : '',
    lugar,
    titulo: acts
  };
}

async function descubrir(): Promise<Candidato[]> {
  const out: Candidato[] = [];
  const seen = new Set<string>();
  const vigente = String(new Date().getFullYear());
  const mete = (titulo: string, url: string) => {
    const t = titulo.trim().replace(/\s+/g, ' ');
    if (!t || t.length < 10 || seen.has(url)) return;
    if (!url.startsWith(BASE + '/')) return;
    if (/\.(pdf|jpg|jpeg|png|webp)$/i.test(url.split('?')[0])) return;
    // Solo actividad y noticias del año vigente.
    const inAmbito = url.includes('/actividad/') || url.includes('/noticias/');
    if (!inAmbito) return;
    const anyo = url.match(/(20\d{2})/)?.[1] || '';
    if (anyo && anyo !== vigente) return;
    if (!anyo && !RE_SAUZAL.test(t) && !clasificarTitulo(t).esVerbena && !esContenedor(t)) return;
    if (anyo !== vigente && anyo !== '' && !RE_SAUZAL.test(t)) return;
    if (!clasificarTitulo(t).esVerbena && !esContenedor(t) && !RE_SAUZAL.test(t)) return;
    seen.add(url);
    out.push({ titulo: t, url, anyo: anyo || vigente });
  };

  const paginas = [`${BASE}/actividades/`, `${BASE}/./noticias/`, `${BASE}/?s=verbena`, `${BASE}/?s=fiestas`];
  for (const page of paginas) {
    try {
      const html = await fetchText(page);
      rastrearProgramas(MUNI, html, BASE);
      const $ = cheerio.load(html);
      $('a[href]').each((_, a) => {
        let href = $(a).attr('href') || '';
        if (href.startsWith('/')) href = BASE + href;
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

function nucleoDe(texto: string): string {
  const low = texto.toLowerCase();
  for (const n of NUCLEOS) if (low.includes(n.toLowerCase())) return n;
  return '';
}

function mesDominante(texto: string): string {
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
  const r = m[1].match(/(Plaza|Parque|Cancha|Recinto|Auditorio|Teatro|Pabell[oó]n|Polideportivo|Mercado|Iglesia|Ermita|Escenario|Campo|Calle|Casa|Bas[ií]lica)[ \t]+[^.\n,]{2,40}/i);
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

export async function obtenerVerbenasElSauzal(): Promise<Verbena[]> {
  if (cache && Date.now() - cache.at < TTL) return cache.data;
  const verbenas: Verbena[] = [];
  const push = (v: Verbena) => {
    if (!verbenas.some((x) => x.id === v.id)) verbenas.push(v);
  };

  const procesar = (cuerpo: string, opts: { anyo: string; slug: string; url: string; etiqueta: string }) => {
    // 1) Ficha estructurada DÍA/HORA/LUGAR/ACTUACIONES (lo más fiable).
    const ficha = fichaActividad(cuerpo);
    if (ficha?.titulo) {
      const titulo = `Verbena ${ficha.titulo}`.replace(/\s+/g, ' ').trim();
      const lugar = lugarCercano(cuerpo.slice(0, 1500), titulo) || ficha.lugar || nucleoDe(cuerpo) || MUNI;
      const cls = clasificarDetalle(titulo, ventana(cuerpo, ficha.titulo, 400), ficha.hora, lugar, 1);
      if (cls.esVerbena && ficha.day) {
        push({
          id: `elsauzal-${opts.slug.slice(0, 20)}-${ficha.hora.replace(':', '') || 'sh'}-${ficha.day}`.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9-]+/g, '-'),
          titulo, day: ficha.day, hora: ficha.hora, municipio: MUNI,
          lugar, orquestas: extraerSubEventos(titulo).flatMap((s) => s.orquestas),
          tipo: tipoDeEvento(titulo), url: opts.url,
          score: cls.score, motivos: [...cls.motivos, opts.etiqueta, 'ficha DÍA/HORA/LUGAR']
        });
        return;
      }
    }
    // 2) Programa inline por días ("MIÉRCOLES 29 / A las 20.00 h, en la plaza X: Acto").
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
        // Cabecera rota del PDF ("FIESTA CANARIA , PENSANDO EN..."): sin
        // desarrollo tras la keyword no es un acto.
        if (/^fiesta canaria\s*,\s*\S+\s+en\b/i.test(l.titulo)) continue;
        const lugarLinea = lugarCercano(sec.texto, l.titulo) || lugarContinuacion(sec.texto, l.titulo) || (limpio.length < 3000 ? lugarDoc : lugarSec);
        const cls = clasificarDetalle(l.titulo, ventana(sec.texto, l.titulo, 400), l.hora, lugarLinea, l.extra);
        if (!cls.esVerbena) continue;
        push({
          id: `elsauzal-${opts.slug.slice(0, 20)}-${l.hora.replace(':', '') || 'sh'}-${day}-${l.titulo.split(/\s+/).slice(0, 3).join(' ')}`.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9-]+/g, '-'),
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
    for (const p of [`${BASE}/actividades/`, `${BASE}/./noticias/`]) {
      try { htmlCache.push(await fetchText(p)); } catch {}
    }
  } catch (e) {
    console.error('elsauzal índice fallo', e);
  }

  for (const it of items) {
    try {
      await espera(PAUSA_MS);
      const d = await fetchText(it.url);
      htmlCache.push(d);
      const anyo = anyoVisible(d, it.url);
      if (anyo !== String(new Date().getFullYear())) {
        console.warn(`elsauzal post antiguo (${anyo}) descartado: ${it.url}`);
        continue;
      }
      const cuerpo = normalizarHoras(textoConSaltos(d));
      const slug = it.url.split('/').filter(Boolean).pop() || 'evento';
      procesar(cuerpo, { anyo, slug, url: it.url, etiqueta: `ficha: ${it.titulo.slice(0, 50)}` });
    } catch (e) {
      console.error('elsauzal detalle fallo', it.url, e);
    }
  }

  // PDFs del año vigente (los de fiestas son escaneados -> aviso).
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
      if (!/programa|fiesta|san-pedro|sauzal|verbena/i.test(href)) continue;
      vigentes.add(href);
    }
  }
  for (const url of vigentes) {
    try {
      await espera(PAUSA_MS);
      const head = await fetch(url, { method: 'HEAD' });
      const tam = Number(head.headers.get('content-length') || 0);
      if (tam > MAX_PDF_BYTES) {
        console.warn(`elsauzal pdf pesado (${(tam / 1048576).toFixed(1)} MB) omitido: ${url}`);
        continue;
      }
      const pdf = await obtenerTextoPdf(url, undefined, false, MUNI);
      if (pdf.escaneado) continue; // avisado en pdf.ts
      const anyo = anyoDelTexto(pdf.texto) || url.match(/(20\d{2})/)?.[1] || String(new Date().getFullYear());
      if (anyo !== String(new Date().getFullYear())) continue;
      const slug = (url.split('/').pop() || 'programa').toLowerCase().replace(/\.pdf.*$/, '').replace(/[^a-z0-9]+/g, '-').slice(0, 30);
      procesar(normalizarHoras(pdf.texto), { anyo, slug, url, etiqueta: `programa: ${slug.slice(0, 40)}` });
    } catch (e) {
      console.error('elsauzal programa fallo', url, e);
    }
  }

  if (verbenas.length === 0) {
    avisar(MUNI, 'sin-eventos', ELSAUZAL_URL, 'sin verbenas vigentes (revisa actividades/noticias)');
  }

  cache = { at: Date.now(), data: verbenas };
  return verbenas;
}
