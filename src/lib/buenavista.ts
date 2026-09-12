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

// Buenavista del Norte: WordPress (Divi) con REST bloqueado (401), noticias
// actualizadas en /noticias/YYYY/slug y agenda vacía (/eventos/ "No hay eventos").
// Programas en PDF enlazados desde la noticia (p. ej. Programa-LOS-REMEDIOS-2025.pdf).
// Solo año vigente: los slugs llevan año en la ruta y los PDF en el nombre;
// un programa nuevo (Remedios 2026) entra solo en cuanto lo cuelguen.
const BASE = 'https://www.buenavistadelnorte.es';
export const BUENAVISTA_URL = `${BASE}/noticias/`;

const MUNI = 'Buenavista del Norte';
const NUCLEOS = ['Buenavista', 'El Palmar', 'Las Portelas', 'Teno Alto', 'Los Carrizales',
  'Masca', 'La Tierra del Trigo', 'Los Silos', 'Santiago del Teide'];

let cache: { at: number; data: Verbena[] } | null = null;
const TTL = 1000 * 60 * 60;
const PAUSA_MS = 1200;
const MAX_DETALLES = 8;
const MAX_PDFS = 5;
const MAX_PDF_BYTES = 8 * 1024 * 1024;

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Candidato { titulo: string; url: string; anyo: string }

const RE_BVN = /remedios|bartolom[eé]|santa cruz|san antonio|magos|romer[ií]a|carnaval|verbena|baile|orquesta|programa|fiesta|boreal|libreas/i;

function anyoDeUrl(url: string): string {
  const m = url.match(/\/noticias\/(20\d{2})\//) || url.match(/(20\d{2})/);
  return m ? m[1] : '';
}

async function descubrir(): Promise<Candidato[]> {
  const out: Candidato[] = [];
  const seen = new Set<string>();
  const vigente = String(new Date().getFullYear());
  const mete = (titulo: string, url: string) => {
    const t = titulo.trim().replace(/\s+/g, ' ');
    if (!t || t.length < 15 || seen.has(url)) return;
    if (!url.startsWith(BASE + '/noticias/')) return;
    const anyo = anyoDeUrl(url);
    if (anyo !== vigente) return;
    if (!clasificarTitulo(t).esVerbena && !esContenedor(t) && !RE_BVN.test(t)) return;
    seen.add(url);
    out.push({ titulo: t, url, anyo });
  };

  // Noticias paginadas + buscador
  const paginas = [`${BASE}/noticias/`, `${BASE}/noticias/page/2/`, `${BASE}/?s=fiestas`, `${BASE}/?s=verbena`, `${BASE}/?s=verbena&post_type=post`];
  for (const page of paginas) {
    try {
      const html = await fetchText(page);
      rastrearProgramas(MUNI, html, BASE);
      const $ = cheerio.load(html);
      $('a[href]').each((_, a) => {
        let href = $(a).attr('href') || '';
        if (!href.startsWith(BASE + '/noticias/') && href.startsWith('/noticias/')) href = BASE + href;
        if (!href.startsWith(BASE + '/noticias/')) return;
        // Evita enlaces de paginación y de medios
        if (/\.(pdf|jpg|jpeg|png|webp)$/i.test(href.split('?')[0])) return;
        if (/\/page\/\d+\/?$/.test(href)) return;
        mete($(a).text(), href);
      });
    } catch { /* sigue con la siguiente página */ }
    if (out.length >= MAX_DETALLES) break;
  }
  // Deduplica por slug (el listado repite cada noticia 2-3 veces)
  const porSlug = new Map<string, Candidato>();
  for (const c of out) {
    const slug = c.url.split('/').filter(Boolean).pop() || c.url;
    if (!porSlug.has(slug)) porSlug.set(slug, c);
  }
  return [...porSlug.values()].slice(0, MAX_DETALLES);
}

async function descubrirProgramas(htmlCache: string[]): Promise<string[]> {
  const vigente = String(new Date().getFullYear());
  const seen = new Set<string>();
  const out: string[] = [];
  const re = /href="([^"]+\.pdf[^"]*)"/gi;
  for (const html of htmlCache) {
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(html)) !== null && out.length < MAX_PDFS) {
      let href = m[1];
      if (!href.startsWith('http')) {
        if (!href.startsWith('/')) continue;
        href = BASE + href;
      }
      if (seen.has(href)) continue;
      seen.add(href);
      // Solo programas de fiestas del año vigente
      const texto = (m[0] || '').toLowerCase();
      if (!/programa|fiesta|remedios|bartolome|cartel|verbena/i.test(href + ' ' + texto)) continue;
      const anyo = href.match(/(20\d{2})/)?.[1] || '';
      if (anyo && anyo !== vigente) continue;
      if (!anyo && !href.includes(vigente)) continue;
      out.push(href);
    }
  }
  return out;
}

function nucleoDe(texto: string): string {
  const low = texto.toLowerCase();
  for (const n of NUCLEOS) if (low.includes(n.toLowerCase())) return n;
  return '';
}

function mesDominante(texto: string): string {
  const meses = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
    'agosto', 'septiembre', 'setiembre', 'octubre', 'noviembre', 'diciembre'];
  const low = texto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  let mejor = '', mejorN = 0;
  for (const m of meses) {
    const n = low.split(m).length - 1;
    if (n > mejorN) { mejorN = n; mejor = m; }
  }
  return mejorN >= 2 ? mesANum(mejor) : '';
}

function lugarContinuacion(seccion: string, titulo: string): string {
  const idx = seccion.indexOf(titulo.slice(0, 22));
  if (idx === -1) return '';
  const post = seccion.slice(idx + titulo.length, idx + titulo.length + 300);
  const m = post.match(/A continuaci[oó]n\s*[–-]\s*([^.\n]{3,80})/i);
  if (!m) return '';
  const r = m[1].match(/(Plaza|Parque|Cancha|Recinto|Auditorio|Teatro|Pabell[oó]n|Polideportivo|Mercado|Iglesia|Ermita|Escenario|Campo|Calle|Casa)[ \t]+[^.\n,]{2,40}/i);
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

export async function obtenerVerbenasBuenavista(): Promise<Verbena[]> {
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
      const mes = mesANum(sec.mes) || mesANum(mesPrev) || mesDoc;
      if (!mes) continue;
      const day = `${String(sec.dia).padStart(2, '0')}-${mes}-${sec.anyo || anyoPrev || opts.anyo}`;
      const contextoHora = (secciones[i - 1]?.texto.slice(-600) || '') + sec.texto;
      const lugarSec = nucleoDe(sec.texto) || MUNI;
      const lineas = [
        ...extraerSubEventos(sec.texto).map((s) => ({ titulo: s.titulo, hora: s.hora, orquestas: s.orquestas, extra: 0 })),
        ...extraerBailesSinHora(sec.texto).map((s) => {
          const esNoche = /verbena|noche de/i.test(s.titulo) && /orquesta|grupo|banda|\bdj\b|parranda|tributo/i.test(s.titulo);
          return {
            titulo: s.titulo, hora: horaPreviaDoc(contextoHora, s.titulo),
            orquestas: s.orquestas, extra: (s.explicita ? 2 : 0) + (esNoche ? 1 : 0)
          };
        })
      ];
      for (const l of lineas) {
        const lugarLinea = lugarCercano(sec.texto, l.titulo) || lugarContinuacion(sec.texto, l.titulo) || (limpio.length < 3000 ? lugarDoc : lugarSec);
        const cls = clasificarDetalle(l.titulo, ventana(sec.texto, l.titulo, 400), l.hora, lugarLinea, l.extra);
        if (!cls.esVerbena) continue;
        push({
          id: `buenavista-${opts.slug.slice(0, 20)}-${l.hora.replace(':', '') || 'sh'}-${day}-${l.titulo.split(/\s+/).slice(0, 3).join(' ')}`.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9-]+/g, '-'),
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
    // Guarda HTML de índice para rastrear PDFs del año vigente
    for (const p of [`${BASE}/noticias/`, `${BASE}/noticias/page/2/`]) {
      try { htmlCache.push(await fetchText(p)); } catch {}
    }
  } catch (e) {
    console.error('buenavista índice fallo', e);
  }

  for (const it of items) {
    try {
      await espera(PAUSA_MS);
      const d = await fetchText(it.url);
      htmlCache.push(d);
      const cuerpo = normalizarHoras(textoConSaltos(d));
      const slug = it.url.split('/').filter(Boolean).pop() || 'noticia';
      procesar(cuerpo, { anyo: it.anyo, slug, url: it.url, etiqueta: `noticia: ${it.titulo.slice(0, 50)}` });
    } catch (e) {
      console.error('buenavista detalle fallo', it.url, e);
    }
  }

  // Programas del año en curso enlazados desde las noticias/portada
  for (const url of await descubrirProgramas(htmlCache)) {
    try {
      await espera(PAUSA_MS);
      const head = await fetch(url, { method: 'HEAD' });
      const tam = Number(head.headers.get('content-length') || 0);
      if (tam > MAX_PDF_BYTES) {
        console.warn(`buenavista pdf pesado (${(tam / 1048576).toFixed(1)} MB) omitido: ${url}`);
        continue;
      }
      const pdf = await obtenerTextoPdf(url, undefined, false, MUNI);
      if (pdf.escaneado) continue;
      const anyo = anyoDelTexto(pdf.texto) || url.match(/(20\d{2})/)?.[1] || String(new Date().getFullYear());
      if (anyo !== String(new Date().getFullYear())) continue;
      const slug = (url.split('/').pop() || 'programa').toLowerCase().replace(/\.pdf.*$/, '').replace(/[^a-z0-9]+/g, '-').slice(0, 30);
      procesar(normalizarHoras(pdf.texto), { anyo, slug, url, etiqueta: `programa: ${slug.slice(0, 40)}` });
    } catch (e) {
      console.error('buenavista programa fallo', url, e);
    }
  }

  if (verbenas.length === 0) {
    avisar(MUNI, 'sin-eventos', BUENAVISTA_URL, 'sin verbenas vigentes (revisa portada/noticias)');
  }

  cache = { at: Date.now(), data: verbenas };
  return verbenas;
}
