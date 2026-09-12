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
import { textoOcr } from './ocr.js';
import { anyoDelTexto, obtenerTextoPdf } from './pdf.js';
import type { Verbena } from './types.js';

// La Orotava: Drupal 10, sin REST (jsonapi 404), agenda en /es/agenda con
// teasers (fecha badge + título) y detalle con "Cuándo: Sáb, 29 Agosto 2026".
// Noticias en /es/noticias. Solo año vigente: los slugs llevan año en el
// título ("Fiestas...2026") y los PDF igual. Un programa nuevo entra solo.
const BASE = 'https://www.laorotava.es';
export const LAOROTAVA_URL = `${BASE}/es/agenda`;

const MUNI = 'La Orotava';
const NUCLEOS = ['La Orotava', 'La Luz', 'La Perdoma', 'Benijos', 'Pinolere', 'Aguamansa', 'El Rincón', 'San Antonio'];

let cache: { at: number; data: Verbena[] } | null = null;
const TTL = 1000 * 60 * 60;
const PAUSA_MS = 1200;
const MAX_DETALLES = 8;
const MAX_PDFS = 5;
const MAX_PDF_BYTES = 8 * 1024 * 1024;

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Candidato { titulo: string; url: string; anyo: string }

const RE_OROTAVA = /luz|corpus|romer[ií]a|alfombra|magos|carnaval|verbena|baile|orquesta|programa|fiesta|tapas|miel|cittaslow/i;

function anyoDeTitulo(titulo: string): string {
  const m = titulo.match(/(20\d{2})/);
  return m ? m[1] : '';
}

async function descubrir(): Promise<Candidato[]> {
  const out: Candidato[] = [];
  const seen = new Set<string>();
  const vigente = String(new Date().getFullYear());
  const mete = (titulo: string, url: string) => {
    const t = titulo.trim().replace(/\s+/g, ' ');
    if (!t || t.length < 10 || seen.has(url)) return;
    const anyo = anyoDeTitulo(t) || anyoDelTexto(t) || '';
    // Agenda lleva año en título; sin año se asume vigente pero debe pasar filtro
    if (anyo && anyo !== vigente) return;
    if (!clasificarTitulo(t).esVerbena && !esContenedor(t) && !RE_OROTAVA.test(t)) return;
    seen.add(url);
    out.push({ titulo: t, url, anyo: anyo || vigente });
  };

  const paginas = [`${BASE}/es/agenda`, `${BASE}/es/noticias`];
  for (const page of paginas) {
    try {
      const html = await fetchText(page);
      rastrearProgramas(MUNI, html, BASE);
      const $ = cheerio.load(html);
      $('a[href]').each((_, a) => {
        let href = $(a).attr('href') || '';
        if (!href) return;
        if (href.startsWith('/')) href = BASE + href;
        if (!href.startsWith(BASE + '/es/')) return;
        if (/\.(pdf|jpg|jpeg|png|webp)$/i.test(href.split('?')[0])) return;
        // Solo agenda y noticias
        if (!href.includes('/es/agenda/') && !href.includes('/es/noticias/')) return;
        if (href === `${BASE}/es/agenda` || href === `${BASE}/es/noticias`) return;
        mete($(a).text(), href);
      });
    } catch { /* sigue con la siguiente página */ }
    if (out.length >= MAX_DETALLES) break;
  }
  // Deduplica por slug
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
  const low = texto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  let mejor = '', mejorN = 0;
  for (const m of meses) {
    const n = (low.match(new RegExp(`\\b${m}\\b`, 'g')) || []).length;
    if (n > mejorN) { mejorN = n; mejor = m; }
  }
  // La Orotava: programa en imágenes con un solo encabezado "SEPTIEMBRE" (1 mención)
  // que fija el mes para 14 días sin mes. Con >=2 fallaba y se perdía todo.
  return mejorN >= 1 ? mesANum(mejor) : '';
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

export async function obtenerVerbenasLaOrotava(): Promise<Verbena[]> {
  if (cache && Date.now() - cache.at < TTL) return cache.data;
  const verbenas: Verbena[] = [];
  const push = (v: Verbena) => {
    if (!verbenas.some((x) => x.id === v.id)) verbenas.push(v);
  };

  const procesar = (cuerpo: string, opts: { anyo: string; slug: string; url: string; etiqueta: string }) => {
    let limpio = cuerpo.replace(/SÁBAD O/gi, 'SÁBADO').replace(/D OMINGO/gi, 'DOMINGO');
    // Programa en imágenes: mes como encabezado suelto "AGOSTO SÁBADO 29" o "SEPTIEMBRE MARTES 1".
    // Lo normalizamos a "SÁBADO 29 DE AGOSTO" para que partirPorDias lo capture.
    limpio = limpio.replace(/(ENERO|FEBRERO|MARZO|ABRIL|MAYO|JUNIO|JULIO|AGOSTO|SEPTIEMBRE|SETIEMBRE|OCTUBRE|NOVIEMBRE|DICIEMBRE)\s+(LUNES|MARTES|MIÉRCOLES|MIERCOLES|JUEVES|VIERNES|SÁBADO|SABADO|DOMINGO)\s+(\d{1,2})/gi, '$2 $3 DE $1');
    limpio = limpio.replace(/(ENERO|FEBRERO|MARZO|ABRIL|MAYO|JUNIO|JULIO|AGOSTO|SEPTIEMBRE|SETIEMBRE|OCTUBRE|NOVIEMBRE|DICIEMBRE)\s*\n\s*(LUNES|MARTES|MIÉRCOLES|MIERCOLES|JUEVES|VIERNES|SÁBADO|SABADO|DOMINGO)\s+(\d{1,2})/gi, '$2 $3 DE $1');
    const ctx = mesContexto(limpio);
    const mesDoc = ctx.mes || mesDominante(limpio);
    const ref = mesDoc && opts.anyo ? { mes: mesDoc, anyo: opts.anyo } : undefined;
    const lugarDoc = limpio.length < 3000
      ? lugarCercano(limpio.slice(0, 2000), opts.etiqueta) || nucleoDe(limpio) || MUNI
      : nucleoDe(limpio) || MUNI;
    let mesPrev = '', anyoPrev = '';
    const secciones = partirPorDias(juntarHoraLugar(limpio), ref);
    // Si no hay secciones pero el texto trae "Cuándo: 29 Agosto 2026", usa esa fecha
    const cuerpos = secciones.length ? secciones : [{ dia: 0, mes: '', anyo: '', texto: limpio } as any];
    for (const [i, sec] of cuerpos.entries()) {
      if ((sec as any).mes) mesPrev = (sec as any).mes;
      if ((sec as any).anyo) anyoPrev = (sec as any).anyo;
      const mes = mesANum((sec as any).mes) || mesANum(mesPrev) || mesDoc;
      if (!mes) {
        // Sin mes ni secciones con fecha: intenta extraer del texto plano
        const m = limpio.match(/(\d{1,2})\s+de\s+([a-záéíóúñ]+)(?:\s+de\s+(20\d{2}))?/i);
        if (!m) continue;
        const dia = parseInt(m[1], 10);
        const mm = mesANum(m[2]);
        if (!mm) continue;
        const day = `${String(dia).padStart(2, '0')}-${mm}-${m[3] || opts.anyo}`;
        // Procesa como sección única
        const lineas = [
          ...extraerSubEventos(limpio).map((s) => ({ titulo: s.titulo, hora: s.hora, orquestas: s.orquestas, extra: 0 })),
          ...extraerBailesSinHora(limpio).map((s) => ({
            titulo: s.titulo, hora: horaPreviaDoc(limpio, s.titulo), orquestas: s.orquestas, extra: s.explicita ? 2 : 0
          }))
        ];
        for (const l of lineas) {
          const lugarLinea = lugarCercano(limpio, l.titulo) || lugarDoc;
          const cls = clasificarDetalle(l.titulo, ventana(limpio, l.titulo, 400), l.hora, lugarLinea, l.extra);
          if (!cls.esVerbena) continue;
          push({
            id: `laorotava-${opts.slug.slice(0, 20)}-${l.hora.replace(':', '') || 'sh'}-${day}-${l.titulo.split(/\s+/).slice(0, 3).join(' ')}`.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9-]+/g, '-'),
            titulo: l.titulo, day, hora: l.hora, municipio: MUNI,
            lugar: lugarLinea, orquestas: l.orquestas,
            tipo: tipoDeEvento(l.titulo), url: opts.url,
            score: cls.score, motivos: [...cls.motivos, opts.etiqueta]
          });
        }
        continue;
      }
      const secTyped = sec as any;
      const day = `${String(secTyped.dia).padStart(2, '0')}-${mes}-${secTyped.anyo || anyoPrev || opts.anyo}`;
      const contextoHora = (cuerpos[i - 1] as any)?.texto?.slice(-600) || '' + secTyped.texto;
      const lugarSec = nucleoDe(secTyped.texto) || MUNI;
      const lineas = [
        ...extraerSubEventos(secTyped.texto).map((s) => ({ titulo: s.titulo, hora: s.hora, orquestas: s.orquestas, extra: 0 })),
        ...extraerBailesSinHora(secTyped.texto).map((s) => ({
          titulo: s.titulo, hora: horaPreviaDoc(contextoHora, s.titulo), orquestas: s.orquestas, extra: s.explicita ? 2 : 0
        }))
      ];
      for (const l of lineas) {
        const lugarLinea = lugarCercano(secTyped.texto, l.titulo) || lugarContinuacion(secTyped.texto, l.titulo) || (limpio.length < 3000 ? lugarDoc : lugarSec);
        const cls = clasificarDetalle(l.titulo, ventana(secTyped.texto, l.titulo, 400), l.hora, lugarLinea, l.extra);
        if (!cls.esVerbena) continue;
        push({
          id: `laorotava-${opts.slug.slice(0, 20)}-${l.hora.replace(':', '') || 'sh'}-${day}-${l.titulo.split(/\s+/).slice(0, 3).join(' ')}`.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9-]+/g, '-'),
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
    for (const p of [`${BASE}/es/agenda`, `${BASE}/es/noticias`]) {
      try { htmlCache.push(await fetchText(p)); } catch {}
    }
  } catch (e) {
    console.error('laorotava índice fallo', e);
  }

  for (const it of items) {
    try {
      await espera(PAUSA_MS);
      const d = await fetchText(it.url);
      htmlCache.push(d);
      const cuerpo = normalizarHoras(textoConSaltos(d));
      const slug = it.url.split('/').filter(Boolean).pop() || 'evento';
      procesar(cuerpo, { anyo: it.anyo, slug, url: it.url, etiqueta: `agenda: ${it.titulo.slice(0, 50)}` });
    } catch (e) {
      console.error('laorotava detalle fallo', it.url, e);
    }
  }

  // PDFs del año vigente enlazados desde agenda/noticias
  const rePdf = /href="([^"]+\.pdf[^"]*)"/gi;
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
      if (!/programa|fiesta|luz|corpus|romer/i.test(href)) continue;
      vigentes.add(href);
    }
  }
  for (const url of vigentes) {
    try {
      await espera(PAUSA_MS);
      const head = await fetch(url, { method: 'HEAD' });
      const tam = Number(head.headers.get('content-length') || 0);
      if (tam > MAX_PDF_BYTES) {
        console.warn(`laorotava pdf pesado (${(tam / 1048576).toFixed(1)} MB) omitido: ${url}`);
        continue;
      }
      const pdf = await obtenerTextoPdf(url, undefined, false, MUNI);
      if (pdf.escaneado) continue;
      const anyo = anyoDelTexto(pdf.texto) || url.match(/(20\d{2})/)?.[1] || String(new Date().getFullYear());
      if (anyo !== String(new Date().getFullYear())) continue;
      const slug = (url.split('/').pop() || 'programa').toLowerCase().replace(/\.pdf.*$/, '').replace(/[^a-z0-9]+/g, '-').slice(0, 30);
      procesar(normalizarHoras(pdf.texto), { anyo, slug, url, etiqueta: `programa: ${slug.slice(0, 40)}` });
    } catch (e) {
      console.error('laorotava programa fallo', url, e);
    }
  }

  // Programa publicado solo como imágenes (galería PNG en agenda):
  // el texto OCR vive en src/lib/data/ocr-programas.json (generado
  // manualmente para este finde; futuro se avisa vía monitor).
  const ocr = textoOcr('laorotava');
  if (ocr?.texto) {
    procesar(normalizarHoras(ocr.texto), {
      anyo: ocr.anyo || String(new Date().getFullYear()),
      slug: `ocr-${ocr.anyo || 'prog'}`,
      url: ocr.fuente,
      etiqueta: `programa OCR ${ocr.anyo}`
    });
  } else {
    // Detecta programa-imagen pendiente (7 PNGs en galería) para avisar
    const tieneGaleria = htmlCache.some((h) => (h.match(/\/sites\/default\/files\/2026-08\/\d+\.png/g) || []).length >= 4);
    if (tieneGaleria) {
      avisar(MUNI, 'programa-imagen', LAOROTAVA_URL, 'solo-imagen (galería PNG) sin OCR — este finde');
    }
  }

  if (verbenas.length === 0) {
    avisar(MUNI, 'sin-eventos', LAOROTAVA_URL, 'sin verbenas vigentes (revisa agenda/noticias)');
  }

  cache = { at: Date.now(), data: verbenas };
  return verbenas;
}
