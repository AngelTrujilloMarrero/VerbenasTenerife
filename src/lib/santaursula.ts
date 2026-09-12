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

// Santa Úrsula: WordPress, REST bloqueado (401). Noticias con fecha visible
// ("30 de septiembre de 2025" + datetime) y programa inline en texto
// ("el sábado 11, ... verbena ... orquestas X y Y"). Fiestas patronales en
// octubre (2025 verificado: verbena 11/oct Fórmula Latina + La Fórmula).
// Eventos /evento/ son viajes/cursos (sin verbenas). Solo año vigente:
// fecha visible del detalle; sin fecha válida se descarta.
const BASE = 'https://www.santaursula.es';
export const SANTAURSULA_URL = `${BASE}/areas/fiestas/fiestas-patronales/`;

const MUNI = 'Santa Úrsula';
const NUCLEOS = ['Santa Úrsula', 'La Corujera', 'El Calvario', 'Lomo Hilo', 'La Vera',
  'El Farrobillo', 'Tosca de Ana María', 'Las Toscas', 'La Cuesta', 'El Rincón'];

let cache: { at: number; data: Verbena[] } | null = null;
const TTL = 1000 * 60 * 60;
const PAUSA_MS = 1200;
const MAX_DETALLES = 10;

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Candidato { titulo: string; url: string }

const RE_SANTAURSULA = /ursula|patronal|corujera|calvario|vera|farrobillo|romer[ií]a|magos|piñata|carnaval|verbena|baile|orquesta|programa|fiesta|sardinada|ofrenda|tradicion/i;

/** Fecha visible del detalle ("30 de septiembre de 2025" o datetime). */
function anyoVisible(html: string): string | null {
  const m = html.match(/(\d{1,2})\s+de\s+([a-záéíóúñ]+)\s+de\s+(20\d{2})/i)
    || html.match(/datetime="(20\d{2})-\d{2}-\d{2}/)
    || html.match(/(\d{4})-\d{2}-\d{2}T\d{2}:\d{2}/);
  if (!m) return null;
  return m[m.length - 1].length === 4 ? m[m.length - 1] : m[1].slice(0, 4);
}

async function descubrir(): Promise<Candidato[]> {
  const out: Candidato[] = [];
  const seen = new Set<string>();
  const mete = (titulo: string, url: string) => {
    const t = titulo.trim().replace(/\s+/g, ' ');
    if (!t || t.length < 15 || seen.has(url)) return;
    if (!url.startsWith(BASE + '/')) return;
    if (url.includes('/evento/') || url.includes('/areas/') || url.includes('/author/')) return;
    if (/\.(pdf|jpg|jpeg|png|webp)$/i.test(url.split('?')[0])) return;
    if (!clasificarTitulo(t).esVerbena && !esContenedor(t) && !RE_SANTAURSULA.test(t)) return;
    seen.add(url);
    out.push({ titulo: t, url });
  };

  const paginas = [
    `${BASE}/?s=verbena`, `${BASE}/?s=fiestas`, `${BASE}/?s=orquesta`,
    `${BASE}/areas/fiestas/fiestas-patronales/`, `${BASE}/areas/fiestas/fiestas-de-los-barrios/`
  ];
  for (const page of paginas) {
    try {
      const html = await fetchText(page);
      rastrearProgramas(MUNI, html, BASE);
      const $ = cheerio.load(html);
      $('a[href]').each((_, a) => {
        let href = $(a).attr('href') || '';
        if (href.startsWith('/')) href = BASE + href;
        if (!href.startsWith(BASE + '/') || href === BASE + '/') return;
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

export async function obtenerVerbenasSantaUrsula(): Promise<Verbena[]> {
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
          id: `santaursula-${opts.slug.slice(0, 20)}-${l.hora.replace(':', '') || 'sh'}-${day}-${l.titulo.split(/\s+/).slice(0, 3).join(' ')}`.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9-]+/g, '-'),
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
  } catch (e) {
    console.error('santaursula índice fallo', e);
  }

  for (const it of items) {
    try {
      await espera(PAUSA_MS);
      const d = await fetchText(it.url);
      htmlCache.push(d);
      const anyo = anyoVisible(d);
      if (anyo !== String(new Date().getFullYear())) {
        console.warn(`santaursula post antiguo (${anyo}) descartado: ${it.url}`);
        continue;
      }
      const cuerpo = normalizarHoras(textoConSaltos(d));
      const slug = it.url.split('/').filter(Boolean).pop() || 'noticia';
      procesar(cuerpo, { anyo, slug, url: it.url, etiqueta: `noticia: ${it.titulo.slice(0, 50)}` });
    } catch (e) {
      console.error('santaursula detalle fallo', it.url, e);
    }
  }

  // PDFs del año vigente (si los hubiera enlazados).
  const rePdf = /(?:href|src)="([^"]+\.pdf[^"]*)"/gi;
  const vigentes = new Set<string>();
  for (const html of htmlCache) {
    let m: RegExpExecArray | null;
    rePdf.lastIndex = 0;
    while ((m = rePdf.exec(html)) !== null && vigentes.size < 5) {
      let href = m[1];
      if (!href.startsWith('http')) {
        if (!href.startsWith('/')) continue;
        href = BASE + href;
      }
      if (vigentes.has(href)) continue;
      const anyo = href.match(/(20\d{2})/)?.[1] || '';
      if (anyo && anyo !== String(new Date().getFullYear())) continue;
      if (!anyo && !href.includes(String(new Date().getFullYear()))) continue;
      if (!/programa|fiesta|ursula|verbena/i.test(href)) continue;
      vigentes.add(href);
    }
  }
  for (const url of vigentes) {
    try {
      await espera(PAUSA_MS);
      const head = await fetch(url, { method: 'HEAD' });
      const tam = Number(head.headers.get('content-length') || 0);
      if (tam > 8 * 1024 * 1024) {
        console.warn(`santaursula pdf pesado (${(tam / 1048576).toFixed(1)} MB) omitido: ${url}`);
        continue;
      }
      const pdf = await obtenerTextoPdf(url, undefined, false, MUNI);
      if (pdf.escaneado) continue;
      const anyo = anyoDelTexto(pdf.texto) || url.match(/(20\d{2})/)?.[1] || String(new Date().getFullYear());
      if (anyo !== String(new Date().getFullYear())) continue;
      const slug = (url.split('/').pop() || 'programa').toLowerCase().replace(/\.pdf.*$/, '').replace(/[^a-z0-9]+/g, '-').slice(0, 30);
      procesar(normalizarHoras(pdf.texto), { anyo, slug, url, etiqueta: `programa: ${slug.slice(0, 40)}` });
    } catch (e) {
      console.error('santaursula programa fallo', url, e);
    }
  }

  if (verbenas.length === 0) {
    avisar(MUNI, 'sin-eventos', SANTAURSULA_URL, 'sin verbenas vigentes (patronales en octubre)');
  }

  cache = { at: Date.now(), data: verbenas };
  return verbenas;
}
