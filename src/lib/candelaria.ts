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
import { lanzarOcrAutoImagenes, leerOcrAuto, textoSimilar } from './ocr-auto.js';
import { anyoDelTexto, obtenerTextoPdf } from './pdf.js';
import type { Verbena } from './types.js';

// Candelaria: WordPress con REST ABIERTA (posts cat 41 Fiestas + media).
// Tres vías de programa, solo año vigente:
// 1) PDFs en mediateca (Agosto-2026, Programa-Agosto-a-2-paginas).
// 2) Noticias con programa inline ("baile con la orquesta Nueva Línea").
// 3) FOTOS de programas por pueblo (Igueste/Araya/Barranco Hondo/Malpaís...):
//    carteles con año en el nombre (2026) pero OCR pendiente -> aviso
//    programa-imagen en /api/estado.json (patrón Arico/La Orotava).
// Eventos tribe vacíos ("No hay eventos próximos"). Años viejos se ignoran.
const BASE = 'https://www.candelaria.es';
const REST = `${BASE}/wp-json/wp/v2`;
export const CANDELARIA_URL = `${BASE}/areas/fiestas/`;

const MUNI = 'Candelaria';
const NUCLEOS = ['Candelaria', 'Igueste', 'Araya', 'Barranco Hondo', 'Las Cuevecitas',
  'Malpaís', 'Las Caletillas', 'Playa de La Viuda', 'Santa Ana', 'El Carmen'];

const PUEBLOS = [
  `${BASE}/fiestas-de-barranco-hondo/`,
  `${BASE}/fiestas-de-igueste/`,
  `${BASE}/fiestas-de-araya/`,
  `${BASE}/fiestas-de-santa-ana-y-virgen-del-carmen/`,
  `${BASE}/fiestas-de-las-cuevecitas/`,
  `${BASE}/fiestas-de-malpais/`,
  `${BASE}/fiestas-de-las-caletillas/`,
  `${BASE}/fiestas-de-playa-la-viuda/`,
  `${BASE}/festividad-de-la-virgen-de-candelaria-febrero/`,
  `${BASE}/fiestas-en-honor-a-la-virgen-de-candelaria-agosto/`,
  `${BASE}/carnaval/`,
  `${BASE}/navidad/`
];

let cache: { at: number; data: Verbena[] } | null = null;
const TTL = 1000 * 60 * 60;
const PAUSA_MS = 1200;
const MAX_DETALLES = 10;
const MAX_PDFS = 5;
// Programas de fiestas con fotos (Agosto-2026: 12-21 MB). Tope alto porque
// son LA fuente del municipio; pdf.ts ya topa en 30 MB y 80 páginas.
const MAX_PDF_BYTES = 25 * 1024 * 1024;

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface PostRest {
  date?: string;
  link?: string;
  title?: { rendered?: string };
  content?: { rendered?: string };
}

interface Candidato { titulo: string; cuerpo: string; url: string; anyo: string }

const RE_CANDELARIA = /candelaria|virgen|patrona|morenita|socorro|carmen|santa ana|romer[ií]a|magos|carnaval|verbena|baile|orquesta|programa|fiesta|sardinada|ofrenda|marea/i;

function sinHtml(s: string): string {
  return (s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Posts vía búsqueda REST + categoría Fiestas (41). Solo año vigente. */
async function descubrir(): Promise<Candidato[]> {
  const out: Candidato[] = [];
  const seen = new Set<string>();
  const vigente = String(new Date().getFullYear());
  const mete = (p: PostRest) => {
    const titulo = sinHtml(p.title?.rendered);
    const url = p.link || '';
    if (!titulo || titulo.length < 10 || !url.startsWith(BASE + '/') || seen.has(url)) return;
    if (!p.date?.startsWith(vigente)) return;
    if (!clasificarTitulo(titulo).esVerbena && !esContenedor(titulo) && !RE_CANDELARIA.test(titulo)) return;
    seen.add(url);
    out.push({ titulo, cuerpo: p.content?.rendered || '', url, anyo: vigente });
  };
  const queries = ['orquesta', 'verbena', 'fiestas', 'baile', 'romeria', 'programa'];
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
      const j = JSON.parse(await fetchText(
        `${REST}/posts?categories=41&per_page=15&_fields=date,link,title,content`));
      if (Array.isArray(j)) j.forEach(mete);
    } catch { /* sin repesca */ }
  }
  return out.slice(0, MAX_DETALLES);
}

/** PDFs en mediateca (SOLO año vigente): Agosto-2026, Programa-Agosto... */
async function descubrirProgramas(): Promise<{ url: string; anyo: string }[]> {
  const vigente = String(new Date().getFullYear());
  const seen = new Set<string>();
  const out: { url: string; anyo: string }[] = [];
  for (const q of ['programa', 'agosto', 'fiestas']) {
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
        // Solo programas de fiestas (no deportivos ni administrativos).
        if (!/programa|fiesta|agosto|verbena|romer|carmen|candelaria/i.test(m.source_url)) continue;
        if (/deportiv|turismo-social|medio-urbano|plaza-programa/i.test(m.source_url)) continue;
        seen.add(m.source_url);
        out.push({ url: m.source_url, anyo: vigente });
        if (out.length >= MAX_PDFS) break;
      }
    } catch { /* sigue */ }
    if (out.length >= MAX_PDFS) break;
  }
  return out;
}

/** Fotos de programas por pueblo con año vigente en el nombre
 *  ("Fiestas-de-San-Jose-Barranco-Hondo-2026", "Programa-Igueste.jpg"...).
 *  Sin OCR en runtime: se avisan como programa-imagen (patrón Arico). */
async function fotosProgramasVigentes(): Promise<{ pueblo: string; imgs: string[] }[]> {
  const vigente = String(new Date().getFullYear());
  const out: { pueblo: string; imgs: string[] }[] = [];
  for (const pueblo of PUEBLOS) {
    try {
      await espera(PAUSA_MS);
      const html = await fetchText(pueblo);
      rastrearProgramas(MUNI, html, BASE);
      const $ = cheerio.load(html);
      const imgs: string[] = [];
      $('img[src]').each((_, img) => {
        let src = $(img).attr('src') || '';
        if (!src) return;
        if (src.startsWith('/')) src = BASE + src;
        if (!/\.(jpe?g|png|webp)$/i.test(src.split('?')[0])) return;
        if (/icon|logo|escudo|marca-agua/i.test(src)) return;
        if (!src.includes(vigente)) return;
        if (!/programa|fiesta|cartel|verbena|romer/i.test(src)) return;
        if (!imgs.includes(src)) imgs.push(src);
      });
      if (imgs.length) out.push({ pueblo, imgs });
    } catch { /* sigue con el siguiente pueblo */ }
  }
  return out;
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

export async function obtenerVerbenasCandelaria(): Promise<Verbena[]> {
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
          id: `candelaria-${opts.slug.slice(0, 20)}-${l.hora.replace(':', '') || 'sh'}-${day}-${l.titulo.split(/\s+/).slice(0, 3).join(' ')}`.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9-]+/g, '-'),
          titulo: l.titulo, day, hora: l.hora, municipio: MUNI,
          lugar: lugarLinea, orquestas: l.orquestas,
          tipo: tipoDeEvento(l.titulo), url: opts.url,
          score: cls.score, motivos: [...cls.motivos, opts.etiqueta]
        });
      }
    }
  };

  // 1) PDFs en mediateca del año en curso.
  // Agosto-2026 y Programa-Agosto-a-2-paginas son el mismo contenido:
  // se procesa el primero que descargue y se salta el duplicado.
  const vistos = new Set<number>();
  for (const p of await descubrirProgramas()) {
    try {
      await espera(PAUSA_MS);
      const head = await fetch(p.url, { method: 'HEAD' });
      const tam = Number(head.headers.get('content-length') || 0);
      if (tam > MAX_PDF_BYTES) {
        console.warn(`candelaria pdf pesado (${(tam / 1048576).toFixed(1)} MB) omitido: ${p.url}`);
        continue;
      }
      const pdf = await obtenerTextoPdf(p.url, undefined, false, MUNI);
      if (pdf.escaneado) continue;
      // Dedup por longitud: mismo programa con distinto nombre no se reprocesa.
      if (vistos.has(pdf.texto.length)) {
        console.log(`candelaria pdf duplicado (mismo contenido) omitido: ${p.url}`);
        continue;
      }
      vistos.add(pdf.texto.length);
      const anyo = anyoDelTexto(pdf.texto) || p.anyo;
      if (anyo !== String(new Date().getFullYear())) continue;
      const slug = (p.url.split('/').pop() || 'programa').toLowerCase().replace(/\.pdf.*$/, '').replace(/[^a-z0-9]+/g, '-').slice(0, 30);
      procesar(normalizarHoras(pdf.texto), { anyo, slug, url: p.url, etiqueta: `programa: ${slug.slice(0, 40)}` });
    } catch (e) {
      console.error('candelaria programa fallo', p.url, e);
    }
  }

  // 2) Noticias del año en curso (programas inline).
  let items: Candidato[] = [];
  try {
    try { rastrearProgramas(MUNI, await fetchText(CANDELARIA_URL), BASE); } catch {}
    items = await descubrir();
  } catch (e) {
    console.error('candelaria índice fallo', e);
  }
  for (const it of items) {
    try {
      const cuerpo = normalizarHoras(textoConSaltos(it.cuerpo));
      const slug = it.url.split('/').filter(Boolean).pop() || 'noticia';
      procesar(cuerpo, { anyo: it.anyo, slug, url: it.url, etiqueta: `noticia: ${it.titulo.slice(0, 50)}` });
    } catch (e) {
      console.error('candelaria detalle fallo', it.url, e);
    }
  }

  // 3) Programas publicados solo como imágenes (OCR manual versionado o
  // automático en caché, ver scripts/ocr-programas.mjs y ocr-auto.ts).
  const ocr = textoOcr('candelaria');
  if (ocr?.texto) {
    procesar(normalizarHoras(ocr.texto), {
      anyo: ocr.anyo || String(new Date().getFullYear()),
      slug: `ocr-${ocr.anyo || 'prog'}`,
      url: ocr.fuente,
      etiqueta: `programa OCR ${ocr.anyo}`
    });
  }
  // Fotos de programas del año en pueblos -> OCR auto o aviso.
  for (const f of await fotosProgramasVigentes()) {
    const auto = leerOcrAuto(f.pueblo);
    if (auto?.texto) {
      if (ocr?.texto && textoSimilar(auto.texto, ocr.texto)) continue; // ya cubierto
      procesar(normalizarHoras(auto.texto), {
        anyo: String(new Date().getFullYear()),
        slug: 'ocr-auto',
        url: f.pueblo,
        etiqueta: 'programa OCR auto'
      });
    } else {
      lanzarOcrAutoImagenes(f.pueblo, f.imgs, MUNI);
      avisar(MUNI, 'programa-imagen', f.pueblo, `solo-imagen (${f.imgs.length} fotos ${new Date().getFullYear()}) sin OCR: ${f.imgs[0].split('/').pop()}`);
    }
  }

  if (verbenas.length === 0) {
    const tieneOCR = !!textoOcr('candelaria');
    if (!tieneOCR) avisar(MUNI, 'sin-eventos', CANDELARIA_URL, 'sin programa vigente con texto (revisa fotos pueblos)');
  }

  cache = { at: Date.now(), data: verbenas };
  return verbenas;
}
