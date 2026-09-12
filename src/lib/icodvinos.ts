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

// Icod de los Vinos: WordPress (Divi) con API REST ABIERTA (wp-json/wp/v2),
// la vía más limpia del proyecto: búsqueda server-side + content.rendered
// (evita raspar menús del HTML) y mediateca con los programas en PDF.
// Fiestas eje: Septiembre/Cristo del Calvario, San Marcos (abril),
// San Andrés/tablas (noviembre) y Carnaval/Murgas del Norte.
// X (@Icod_Vinos) es muro con login y sin API pública: no integrable sin
// claves; la web publica lo mismo (programas, carteles), no se pierde nada.
const BASE = 'https://icoddelosvinos.es';
const REST = `${BASE}/wp-json/wp/v2`;
export const ICODVINOS_URL = `${BASE}/category/eventos/`;

const MUNI = 'Icod de los Vinos';
// Núcleos/barrios (para el campo lugar). Sin "San Marcos": ambiguo
// (parroquia, casco, playa, cueva) y cazaba falsos núcleos.
const NUCLEOS = ['El Amparo', 'San Antonio', 'Buen Paso', 'Santa Bárbara', 'La Vega',
  'Las Abiertas', 'La Florida', 'La Mancha', 'Llanito Perera', 'Las Canales',
  'Cruz del Camino', 'Redondo', 'Las Granaderas', 'La Centinela',
  'San Felipe', 'El Miradero'];

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

// Títulos que, sin puntuar como verbena ni contenedor genérico, esconden
// bailes en Icod ("...gran fin de semana de las tradiciones" -> fiesta
// canaria con orquestas; "...San Andrés" -> programa inline). Entrar al
// detalle no crea eventos: el clasificador por línea filtra después.
// OJO "vino" a secas caza "Icod de los Vinos" en cada título: no vale.
const RE_ICOD = /tradicion|san andr[eé]s|san marcos|cristo|calvario|murgas?|carnaval|tablas?|preg[oó]n|gala drag|programaci[oó]n|programa de actos|cartel|vendimia|kioscos/i;

function sinHtml(s: string): string {
  return (s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Posts vía búsqueda REST (server-side) + categoría de eventos reciente.
 *  Solo año vigente: los slugs no llevan año y hay posts de 2023-25. */
async function descubrir(): Promise<Candidato[]> {
  const out: Candidato[] = [];
  const seen = new Set<string>();
  const vigente = String(new Date().getFullYear());
  const mete = (p: PostRest) => {
    const titulo = sinHtml(p.title?.rendered);
    const url = p.link || '';
    if (!titulo || titulo.length < 15 || !url.startsWith(BASE + '/') || seen.has(url)) return;
    if (!p.date?.startsWith(vigente)) return;
    if (!clasificarTitulo(titulo).esVerbena && !esContenedor(titulo) && !RE_ICOD.test(titulo)) return;
    seen.add(url);
    out.push({ titulo, cuerpo: p.content?.rendered || '', url, anyo: vigente });
  };
  const queries = ['orquesta', 'verbena', 'fiestas', 'baile', 'carnaval', 'programa'];
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
      // Eventos (id 38): repesca lo reciente que el buscador no indexó.
      const j = JSON.parse(await fetchText(
        `${REST}/posts?categories=38&per_page=15&_fields=date,link,title,content`));
      if (Array.isArray(j)) j.forEach(mete);
    } catch { /* sin repesca */ }
  }
  return out.slice(0, MAX_DETALLES);
}

/** Programas futuros en la mediateca (SOLO año en curso): en cuanto cuelguen
 *  el siguiente (San Marcos, Carnaval...), entra solo sin tocar código. */
async function descubrirProgramas(): Promise<{ url: string; anyo: string }[]> {
  try {
    const j = JSON.parse(await fetchText(
      `${REST}/media?search=programa&per_page=30&_fields=date,source_url,mime_type`));
    if (!Array.isArray(j)) return [];
    const vigente = String(new Date().getFullYear());
    const out: { url: string; anyo: string }[] = [];
    for (const m of j) {
      if (m?.mime_type !== 'application/pdf' || typeof m?.source_url !== 'string') continue;
      const anyo = typeof m?.date === 'string' ? m.date.slice(0, 4) : '';
      if (anyo !== vigente && !m.source_url.includes(vigente)) continue;
      if (!out.some((o) => o.url === m.source_url)) out.push({ url: m.source_url, anyo: vigente });
      if (out.length >= MAX_PDFS) break;
    }
    return out;
  } catch {
    return [];
  }
}

/** Programa de portada vía Google Drive: ES el programa del año en curso
 *  (Fiestas de Septiembre 2026: "Drago de Honor 2026"). Sin tope de MB:
 *  es un único fichero conocido (pdf.ts ya topa en 30 MB y 80 páginas). */
async function programaDrive(): Promise<{ texto: string; url: string } | null> {
  try {
    const html = await fetchText(BASE + '/');
    rastrearProgramas(MUNI, html, BASE);
    const m = html.match(/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]+)/);
    if (!m) return null;
    const url = `https://drive.google.com/uc?export=download&id=${m[1]}`;
    const pdf = await obtenerTextoPdf(url, undefined, false, MUNI);
    if (pdf.escaneado) return null; // avisado en pdf.ts (monitor /api/estado.json)
    return { texto: pdf.texto, url };
  } catch {
    return null;
  }
}

function nucleoDe(texto: string): string {
  const low = texto.toLowerCase();
  for (const n of NUCLEOS) if (low.includes(n.toLowerCase())) return n;
  return '';
}

/** Lugar declarado DESPUÉS del acto ("...kioscos. A continuación – Plaza X"):
 *  en el stream del PDF el recinto de la noche llega tras el título.
 *  Se valida como recinto (nombre propio, sin hora ni prosa pegada). */
function lugarContinuacion(seccion: string, titulo: string): string {
  const idx = seccion.indexOf(titulo.slice(0, 22));
  if (idx === -1) return '';
  const post = seccion.slice(idx + titulo.length, idx + titulo.length + 300);
  const m = post.match(/A continuaci[oó]n\s*[–-]\s*([^.\n]{3,80})/i);
  if (!m) return '';
  const r = m[1].match(/(Plaza|Parque|Cancha|Recinto|Auditorio|Teatro|Pabell[oó]n|Polideportivo|Mercado|Iglesia|Ermita)[ \t]+[^.\n,]{2,40}/i);
  if (!r) return '';
  return recortarProsa(r[0].trim().replace(/\s+\d{1,2}:\d{2}h?\b.*$/, '').trim());
}

/** Hora previa con la ÚLTIMA mención (no la primera: "Noche de kioscos" se
 *  repite cada día) y SIN fallback a hora posterior: en este programa la
 *  hora siempre precede al acto; la posterior es de otro acto (caso 10:00h
 *  de la misa tras los kioscos). Radio 600: el stream separa horas y actos. */
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

/** Mes más citado en el texto ("septiembre" ×19 en el programa 2026, con
 *  cabeceras sin mes tipo "MARTES 15"). Fallback genérico cuando ni la
 *  cabecera ni el contexto del documento traen mes. */
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

/** Layout Icod: "21:00 h – Plaza X" en una línea y el acto en la siguiente.
 *  Se juntan ("21:00 - Acto (Plaza X)") para que el extractor vea hora y
 *  título en la misma línea. Las cabeceras de día no se tocan (seguirían
 *  partiéndose igual, pero se excluyen por limpieza). */
function juntarHoraLugar(cuerpo: string): string {
  return cuerpo.replace(
    /^(\d{1,2}:\d{2})\s*h(?:oras?)?\.?\s*[–-]\s*([^.\n]{2,80})\n(?=(?!lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo\b)[A-ZÁÉÍÓÚÑ“"0-9])/gm,
    '$1 - $3 ($2)');
}

export async function obtenerVerbenasIcodVinos(): Promise<Verbena[]> {
  if (cache && Date.now() - cache.at < TTL) return cache.data;
  const verbenas: Verbena[] = [];
  const push = (v: Verbena) => {
    if (!verbenas.some((x) => x.id === v.id)) verbenas.push(v);
  };

  /** Parte un texto (post REST o programa PDF) por días y extrae verbenas. */
  const procesar = (cuerpo: string, opts: { anyo: string; slug: string; url: string; etiqueta: string }) => {
    // El PDF parte "SÁBADO"/"DOMINGO" en dos tokens ("SÁBAD O 19"): se
    // reponen para que partirPorDias no fusione el finde con el viernes.
    const limpio = cuerpo.replace(/SÁBAD O/gi, 'SÁBADO').replace(/D OMINGO/gi, 'DOMINGO');
    const ctx = mesContexto(limpio);
    const mesDoc = ctx.mes || mesDominante(limpio);
    const ref = mesDoc && opts.anyo ? { mes: mesDoc, anyo: opts.anyo } : undefined;
    // En programas largos (12 págs) el contexto de portada no vale como
    // lugar; en noticias cortas sí.
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
      // Cola de la sección anterior: la hora del "A continuación" puede
      // estar al cierre del día previo en el stream.
      const contextoHora = (secciones[i - 1]?.texto.slice(-600) || '') + sec.texto;
      const lugarSec = nucleoDe(sec.texto) || MUNI;
      const lineas = [
        ...extraerSubEventos(sec.texto).map((s) => ({ titulo: s.titulo, hora: s.hora, orquestas: s.orquestas, extra: 0 })),
        // Hora recalculada (última mención, sin fallback posterior).
        // "Noche de kioscos" + música es el formato propio de verbena del
        // programa (+1 mención explícita: también evita que la penalización
        // religiosa de actos vecinos la tumbe, como en Santa Cruz).
        ...extraerBailesSinHora(sec.texto).map((s) => {
          const kioscos = /noche de kioscos/i.test(s.titulo) &&
            /orquesta|grupo|banda|\bdj\b|parranda|tributo/i.test(s.titulo);
          return {
            titulo: s.titulo, hora: horaPreviaDoc(contextoHora, s.titulo),
            orquestas: s.orquestas, extra: (s.explicita ? 2 : 0) + (kioscos ? 1 : 0)
          };
        })
      ];
      for (const l of lineas) {
        const lugarLinea = lugarCercano(sec.texto, l.titulo) || lugarContinuacion(sec.texto, l.titulo) || (limpio.length < 3000 ? lugarDoc : lugarSec);
        const cls = clasificarDetalle(l.titulo, ventana(sec.texto, l.titulo, 400), l.hora, lugarLinea, l.extra);
        if (!cls.esVerbena) continue;
        push({
          id: `icodvinos-${opts.slug.slice(0, 20)}-${l.hora.replace(':', '') || 'sh'}-${day}-${l.titulo.split(/\s+/).slice(0, 3).join(' ')}`.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9-]+/g, '-'),
          titulo: l.titulo, day, hora: l.hora, municipio: MUNI,
          lugar: lugarLinea, orquestas: l.orquestas,
          tipo: tipoDeEvento(l.titulo), url: opts.url,
          score: cls.score, motivos: [...cls.motivos, opts.etiqueta]
        });
      }
    }
  };

  // 1) Programa del año en curso enlazado en portada (Drive): la fuente
  // principal. 2) Programas futuros en la mediateca (año vigente): entran
  // solos en cuanto los cuelguen. 3) Noticias del año vigente (programas
  // inline tipo San Andrés). Años anteriores: se ignoran.
  const drive = await programaDrive().catch(() => null);
  if (drive) {
    const anyo = anyoDelTexto(drive.texto) || String(new Date().getFullYear());
    procesar(normalizarHoras(drive.texto), { anyo, slug: 'programa-fiestas', url: drive.url, etiqueta: 'programa año en curso (Drive portada)' });
  }

  // Programas oficiales de la mediateca (con texto; los escaneados avisan).
  for (const p of await descubrirProgramas()) {
    try {
      await espera(PAUSA_MS);
      const head = await fetch(p.url, { method: 'HEAD' });
      const tam = Number(head.headers.get('content-length') || 0);
      if (tam > MAX_PDF_BYTES) {
        console.warn(`icodvinos pdf pesado (${(tam / 1048576).toFixed(1)} MB) omitido: ${p.url}`);
        continue;
      }
      const pdf = await obtenerTextoPdf(p.url, undefined, false, MUNI);
      if (pdf.escaneado) continue; // avisado en pdf.ts (monitor /api/estado.json)
      const anyo = anyoDelTexto(pdf.texto) || p.anyo;
      const slug = (p.url.split('/').pop() || 'programa').toLowerCase().replace(/\.pdf.*$/, '').replace(/[^a-z0-9]+/g, '-').slice(0, 30);
      procesar(normalizarHoras(pdf.texto), { anyo, slug, url: p.url, etiqueta: `programa: ${slug.slice(0, 40)}` });
    } catch (e) {
      console.error('icodvinos programa fallo', p.url, e);
    }
  }

  let items: Candidato[] = [];
  try {
    items = await descubrir();
  } catch (e) {
    console.error('icodvinos índice fallo', e);
  }

  for (const it of items) {
    try {
      const cuerpo = normalizarHoras(textoConSaltos(it.cuerpo));
      const slug = it.url.split('/').filter(Boolean).pop() || 'noticia';
      procesar(cuerpo, { anyo: it.anyo, slug, url: it.url, etiqueta: `noticia: ${it.titulo.slice(0, 50)}` });
    } catch (e) {
      console.error('icodvinos detalle fallo', it.url, e);
    }
  }

  if (!drive && verbenas.length === 0) {
    avisar(MUNI, 'sin-eventos', ICODVINOS_URL, 'sin programa en curso ni posts vigentes');
  }

  cache = { at: Date.now(), data: verbenas };
  return verbenas;
}
