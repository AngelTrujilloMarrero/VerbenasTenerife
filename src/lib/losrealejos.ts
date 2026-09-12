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

// Los Realejos: WordPress con REST ABIERTA (posts + media). Noticias con
// fecha visible ("septiembre 9, 2026") y programas en PDF en mediateca
// (PROGRAMA-FIESTAS-DEL-CARMEN-2026-WEB.pdf, MAYO 2026). Formato programa:
// día "Viernes 24" + líneas "» 21:00 horas – Plaza X" + "ACTO". Solo año
// vigente: posts y PDFs se filtran por fecha. Futuros entran solos.
const BASE = 'https://losrealejos.es';
const REST = `${BASE}/wp-json/wp/v2`;
export const LOSREALEJOS_URL = `${BASE}/noticias/`;

const MUNI = 'Los Realejos';
const NUCLEOS = ['Realejo Alto', 'Realejo Bajo', 'San Agustín', 'La Cruz Santa', 'Toscal Longuera',
  'Icod el Alto', 'La Carrera', 'La Cartaya', 'Tigaiga', 'San Vicente', 'La Montañeta',
  'Palo Blanco', 'El Socorro', 'La Zamora'];

let cache: { at: number; data: Verbena[] } | null = null;
const TTL = 1000 * 60 * 60;
const PAUSA_MS = 1200;
const MAX_DETALLES = 8;
const MAX_PDFS = 5;
const MAX_PDF_BYTES = 8 * 1024 * 1024;

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface PostRest {
  date?: string;
  link?: string;
  title?: { rendered?: string };
  content?: { rendered?: string };
}

interface Candidato { titulo: string; cuerpo: string; url: string; anyo: string }

const RE_REALEJOS = /carmen|mayo|romer[ií]a|magos|carnaval|verbena|baile|orquesta|programa|fiesta|tapas|miel|vino|salsa/i;

function sinHtml(s: string): string {
  return (s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

async function descubrir(): Promise<Candidato[]> {
  const out: Candidato[] = [];
  const seen = new Set<string>();
  const vigente = String(new Date().getFullYear());
  const mete = (p: PostRest) => {
    const titulo = sinHtml(p.title?.rendered);
    const url = p.link || '';
    if (!titulo || titulo.length < 10 || !url.startsWith(BASE + '/') || seen.has(url)) return;
    if (!p.date?.startsWith(vigente)) return;
    if (!clasificarTitulo(titulo).esVerbena && !esContenedor(titulo) && !RE_REALEJOS.test(titulo)) return;
    seen.add(url);
    out.push({ titulo, cuerpo: p.content?.rendered || '', url, anyo: vigente });
  };
  const queries = ['orquesta', 'verbena', 'fiestas', 'baile', 'romeria', 'carmen'];
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
      // Categoría Fiestas (id 24): repesca lo reciente.
      const j = JSON.parse(await fetchText(
        `${REST}/posts?categories=24&per_page=15&_fields=date,link,title,content`));
      if (Array.isArray(j)) j.forEach(mete);
    } catch { /* sin repesca */ }
  }
  return out.slice(0, MAX_DETALLES);
}

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

export async function obtenerVerbenasLosRealejos(): Promise<Verbena[]> {
  if (cache && Date.now() - cache.at < TTL) return cache.data;
  const verbenas: Verbena[] = [];
  const push = (v: Verbena) => {
    if (!verbenas.some((x) => x.id === v.id)) verbenas.push(v);
  };

  const procesar = (cuerpo: string, opts: { anyo: string; slug: string; url: string; etiqueta: string }) => {
    let limpio = cuerpo.replace(/SÁBAD O/gi, 'SÁBADO').replace(/D OMINGO/gi, 'DOMINGO');
    // Programa Carmen: "11 JUl 22:00 H" y cabeceras "Viernes 24" sin mes.
    // Se normaliza "JUl" a mes y se deja el mes al contexto/mesDominante.
    limpio = limpio.replace(/\bJUl\b/gi, 'julio').replace(/\b(\d{1,2}):(\d{2})\s*H\b/gi, '$1:$2');
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
        ...extraerBailesSinHora(sec.texto).map((s) => ({
          titulo: s.titulo, hora: horaPreviaDoc(contextoHora, s.titulo), orquestas: s.orquestas, extra: s.explicita ? 2 : 0
        }))
      ];
      for (const l of lineas) {
        const lugarLinea = lugarCercano(sec.texto, l.titulo) || lugarContinuacion(sec.texto, l.titulo) || (limpio.length < 3000 ? lugarDoc : lugarSec);
        const cls = clasificarDetalle(l.titulo, ventana(sec.texto, l.titulo, 400), l.hora, lugarLinea, l.extra);
        if (!cls.esVerbena) continue;
        push({
          id: `losrealejos-${opts.slug.slice(0, 20)}-${l.hora.replace(':', '') || 'sh'}-${day}-${l.titulo.split(/\s+/).slice(0, 3).join(' ')}`.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9-]+/g, '-'),
          titulo: l.titulo, day, hora: l.hora, municipio: MUNI,
          lugar: lugarLinea, orquestas: l.orquestas,
          tipo: tipoDeEvento(l.titulo), url: opts.url,
          score: cls.score, motivos: [...cls.motivos, opts.etiqueta]
        });
      }
    }
  };

  // 1) Programas en mediateca del año en curso (Carmen, Mayo...).
  for (const p of await descubrirProgramas()) {
    try {
      await espera(PAUSA_MS);
      const head = await fetch(p.url, { method: 'HEAD' });
      const tam = Number(head.headers.get('content-length') || 0);
      if (tam > MAX_PDF_BYTES) {
        console.warn(`losrealejos pdf pesado (${(tam / 1048576).toFixed(1)} MB) omitido: ${p.url}`);
        continue;
      }
      const pdf = await obtenerTextoPdf(p.url, undefined, false, MUNI);
      if (pdf.escaneado) continue;
      const anyo = anyoDelTexto(pdf.texto) || p.anyo;
      if (anyo !== String(new Date().getFullYear())) continue;
      const slug = (p.url.split('/').pop() || 'programa').toLowerCase().replace(/\.pdf.*$/, '').replace(/[^a-z0-9]+/g, '-').slice(0, 30);
      procesar(normalizarHoras(pdf.texto), { anyo, slug, url: p.url, etiqueta: `programa: ${slug.slice(0, 40)}` });
    } catch (e) {
      console.error('losrealejos programa fallo', p.url, e);
    }
  }

  // 2) Noticias del año en curso (programas inline tipo Fiesta de Vinos).
  let items: Candidato[] = [];
  try {
    try { rastrearProgramas(MUNI, await fetchText(BASE + '/noticias/'), BASE); } catch {}
    items = await descubrir();
  } catch (e) {
    console.error('losrealejos índice fallo', e);
  }
  for (const it of items) {
    try {
      const cuerpo = normalizarHoras(textoConSaltos(it.cuerpo));
      const slug = it.url.split('/').filter(Boolean).pop() || 'noticia';
      procesar(cuerpo, { anyo: it.anyo, slug, url: it.url, etiqueta: `noticia: ${it.titulo.slice(0, 50)}` });
    } catch (e) {
      console.error('losrealejos detalle fallo', it.url, e);
    }
  }

  if (verbenas.length === 0) {
    avisar(MUNI, 'sin-eventos', LOSREALEJOS_URL, 'sin programa vigente ni posts del año en curso');
  }

  cache = { at: Date.now(), data: verbenas };
  return verbenas;
}
