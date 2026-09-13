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
import { lanzarOcrAutoImagenes, leerOcrAuto } from './ocr-auto.js';
import { anyoDelTexto, obtenerTextoPdf } from './pdf.js';
import type { Verbena } from './types.js';

// Arafo: WebSite X5 estática (sin JS no hay menú; REST inexistente).
// Sin posts de programa ni PDF de fiestas 2026 (solo póster de romería
// ilegible para OCR y galerías). Adaptador VIGILANTE (patrón Santa Úrsula
// / Los Silos): descubre por sitemap.xml + galerías + PDFs enlazados;
// hoy 0 eventos, los futuros entran solos. Patronales: San Juan Degollado,
// San Agustín y San Bernardo (agosto).
const BASE = 'https://www.arafo.es';
export const ARAFO_URL = `${BASE}/home.html`;

const MUNI = 'Arafo';
const NUCLEOS = ['Arafo', 'El Carmen', 'La Hidalga'];

let cache: { at: number; data: Verbena[] } | null = null;
const TTL = 1000 * 60 * 60;
const PAUSA_MS = 1200;
const MAX_DETALLES = 10;
const MAX_PDFS = 5;
const MAX_PDF_BYTES = 12 * 1024 * 1024;

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Candidato { titulo: string; url: string }

const RE_ARAFO = /arafo|degollado|agust[ií]n|bernardo|alpispa|romer[ií]a|verbena|baile|orquesta|programa|fiesta|tributo|carnaval|papada|corpus|magos|gala|reina/i;

/** Descubre páginas vía sitemap.xml (X5 no tiene buscador ni fechas). */
async function descubrir(): Promise<Candidato[]> {
  const out: Candidato[] = [];
  const seen = new Set<string>();
  const vigente = String(new Date().getFullYear());
  const mete = (titulo: string, url: string) => {
    const t = titulo.trim().replace(/\s+/g, ' ');
    if (!t || t.length < 12 || seen.has(url)) return;
    if (!url.startsWith(BASE + '/')) return;
    if (/\.(pdf|jpg|jpeg|png|webp)$/i.test(url.split('?')[0])) return;
    // Sin fechas en la web: solo slugs con año vigente (evita 2017-2025).
    const anyo = url.match(/(20\d{2})/)?.[1] || '';
    if (anyo && anyo !== vigente) return;
    if (!anyo) return;
    if (!clasificarTitulo(t).esVerbena && !esContenedor(t) && !RE_ARAFO.test(t)) return;
    seen.add(url);
    out.push({ titulo: t, url });
  };
  // 1) sitemap.xml: inventario completo con slugs fechados.
  try {
    const xml = await fetchText(`${BASE}/sitemap.xml`);
    const re = /<loc>([^<]+)<\/loc>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null && out.length < MAX_DETALLES) {
      const url = m[1].trim();
      const slug = url.split('/').filter(Boolean).pop() || '';
      mete(slug.replace(/[-_]+/g, ' '), url);
    }
  } catch { /* sin sitemap */ }
  // 2) Portada, noticias y patrón fiestas-YYYY (hubs de galería del año).
  for (const page of [`${BASE}/home.html`, `${BASE}/noticias.html`,
    `${BASE}/fiestas-${vigente}.html`, `${BASE}/fiestas-${vigente}-2.html`]) {
    try {
      const html = await fetchText(page);
      rastrearProgramas(MUNI, html, BASE);
      const $ = cheerio.load(html);
      // La propia página del patrón fiestas-YYYY también se procesa.
      if (/fiestas-\d{4}/.test(page)) {
        const title = ($('title').text() || '').trim().replace(/\s+/g, ' ');
        if (title) mete(title, page);
      }
      $('a[href]').each((_, a) => {
        let href = $(a).attr('href') || '';
        if (!href.startsWith(BASE + '/') && !href.startsWith('http')) {
          if (href.startsWith('/')) href = BASE + href;
          else if (/^[a-z0-9-]+\.html/i.test(href)) href = `${BASE}/${href}`;
          else return;
        }
        if (!href.startsWith(BASE + '/')) return;
        mete($(a).text(), href);
      });
    } catch { /* sigue con la siguiente página */ }
    if (out.length >= MAX_DETALLES) break;
  }
  return out.slice(0, MAX_DETALLES);
}

function nucleoDe(texto: string): string {
  const low = texto.toLowerCase();
  for (const n of NUCLEOS) if (low.includes(n.toLowerCase())) return n;
  return '';
}

export async function obtenerVerbenasArafo(): Promise<Verbena[]> {
  if (cache && Date.now() - cache.at < TTL) return cache.data;
  const verbenas: Verbena[] = [];
  const push = (v: Verbena) => {
    if (!verbenas.some((x) => x.id === v.id)) verbenas.push(v);
  };

  /** Parte un texto por días y extrae verbenas (año del slug). */
  const procesar = (cuerpo: string, opts: { anyo: string; slug: string; url: string; etiqueta: string }) => {
    const ctx = mesContexto(cuerpo);
    const ref = ctx.mes && opts.anyo ? { mes: ctx.mes, anyo: opts.anyo } : undefined;
    const lugar = lugarCercano(cuerpo.slice(0, 2000), opts.etiqueta) || nucleoDe(cuerpo) || MUNI;
    let mesPrev = '', anyoPrev = '';
    const secciones = partirPorDias(cuerpo, ref);
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
      const day = `${String(sec.dia).padStart(2, '0')}-${mes}-${sec.anyo || anyoPrev || opts.anyo}`;
      const lineas = [
        ...extraerSubEventos(sec.texto).map((s) => ({ titulo: s.titulo, hora: s.hora, orquestas: s.orquestas, extra: 0 })),
        ...extraerBailesSinHora(sec.texto).map((s) => ({ titulo: s.titulo, hora: s.hora || horaPrevia(sec.texto, s.titulo), orquestas: s.orquestas, extra: s.explicita ? 2 : 0 }))
      ];
      for (const l of lineas) {
        const lugarLinea = lugarCercano(sec.texto, l.titulo) || lugar;
        const cls = clasificarDetalle(l.titulo, ventana(sec.texto, l.titulo, 400), l.hora, lugarLinea, l.extra);
        if (!cls.esVerbena) continue;
        push({
          id: `arafo-${opts.slug.slice(0, 20)}-${l.hora.replace(':', '') || 'sh'}-${day}-${l.titulo.split(/\s+/).slice(0, 3).join(' ')}`.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9-]+/g, '-'),
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
    console.error('arafo índice fallo', e);
  }

  const htmlCache: { url: string; html: string }[] = [];
  for (const it of items) {
    try {
      await espera(PAUSA_MS);
      const d = await fetchText(it.url);
      htmlCache.push({ url: it.url, html: d });
      const anyo = it.url.match(/(20\d{2})/)?.[1] || String(new Date().getFullYear());
      const cuerpo = normalizarHoras(textoConSaltos(d));
      const slug = it.url.split('/').filter(Boolean).pop() || 'pagina';
      procesar(cuerpo, { anyo, slug, url: it.url, etiqueta: `página: ${it.titulo.slice(0, 50)}` });
    } catch (e) {
      console.error('arafo detalle fallo', it.url, e);
    }
  }

  // PDFs del año vigente enlazados (programas).
  const rePdf = /(?:href|src)="([^"]+\.pdf[^"]*)"/gi;
  const vigentes = new Set<string>();
  for (const { html } of htmlCache) {
    let m: RegExpExecArray | null;
    rePdf.lastIndex = 0;
    while ((m = rePdf.exec(html)) !== null && vigentes.size < MAX_PDFS) {
      let href = m[1];
      if (href.startsWith('/')) href = BASE + href;
      else if (!href.startsWith('http') && /^[a-z0-9_-]+\.pdf/i.test(href)) href = `${BASE}/files/${href}`;
      else if (!href.startsWith('http')) {
        if (/^files\//i.test(href)) href = `${BASE}/${href}`;
        else continue;
      }
      if (vigentes.has(href)) continue;
      const anyo = href.match(/(20\d{2})/)?.[1] || '';
      if (anyo && anyo !== String(new Date().getFullYear())) continue;
      if (!anyo && !href.includes(String(new Date().getFullYear()))) continue;
      if (!/programa|fiesta|arafo|romer|verbena/i.test(href)) continue;
      vigentes.add(href);
    }
  }
  for (const url of vigentes) {
    try {
      await espera(PAUSA_MS);
      const head = await fetch(url, { method: 'HEAD' });
      const tam = Number(head.headers.get('content-length') || 0);
      if (tam > MAX_PDF_BYTES) {
        console.warn(`arafo pdf pesado (${(tam / 1048576).toFixed(1)} MB) omitido: ${url}`);
        continue;
      }
      const pdf = await obtenerTextoPdf(url, MAX_PDF_BYTES, false, MUNI);
      if (pdf.escaneado) continue; // central (pdf.ts) ya intentó el OCR auto
      const anyo = anyoDelTexto(pdf.texto) || url.match(/(20\d{2})/)?.[1] || String(new Date().getFullYear());
      if (anyo !== String(new Date().getFullYear())) continue;
      const slug = (url.split('/').pop() || 'programa').toLowerCase().replace(/\.pdf.*$/, '').replace(/[^a-z0-9]+/g, '-').slice(0, 30);
      procesar(normalizarHoras(pdf.texto), { anyo, slug, url, etiqueta: `programa: ${slug.slice(0, 40)}` });
    } catch (e) {
      console.error('arafo programa fallo', url, e);
    }
  }

  // Galerías del patrón fiestas-YYYY: imágenes con año a OCR auto; si es
  // un póster suelto sin texto útil, aviso programa-imagen (manual).
  const vigente = String(new Date().getFullYear());
  const reImg = new RegExp(`(?:src|href)="([^"]*${vigente}[^"]*\\.(?:png|jpe?g|webp)[^"]*)"`, 'gi');
  for (const { url: pageUrl, html } of htmlCache) {
    const imgs: string[] = [];
    let m: RegExpExecArray | null;
    reImg.lastIndex = 0;
    while ((m = reImg.exec(html)) !== null) {
      const src = m[1];
      if (/logo|escudo|icono|boton|mapa|patrocin|ens-|flecha|ayuda|qr/i.test(src)) continue;
      if (!/cartel|programa|fiesta|romer|verbena|baner/i.test(src)) continue;
      const abs = src.startsWith('http') ? src : src.startsWith('/') ? BASE + src : `${BASE}/${src}`;
      if (!imgs.includes(abs)) imgs.push(abs);
    }
    if (imgs.length < 2) {
      if (imgs.length === 1) {
        avisar(MUNI, 'programa-imagen', imgs[0], 'póster sin texto (OCR manual si trae programa)');
      }
      continue;
    }
    const auto = leerOcrAuto(pageUrl);
    if (auto?.texto) {
      procesar(normalizarHoras(auto.texto), {
        anyo: pageUrl.match(/(20\d{2})/)?.[1] || vigente,
        slug: 'ocr-auto', url: pageUrl, etiqueta: 'programa OCR auto'
      });
    } else {
      lanzarOcrAutoImagenes(pageUrl, imgs, MUNI);
      avisar(MUNI, 'programa-imagen', pageUrl, `galería (${imgs.length} imgs) a OCR auto`);
    }
  }

  if (verbenas.length === 0) {
    avisar(MUNI, 'sin-eventos', ARAFO_URL, 'sin verbenas vigentes (patronales en agosto)');
  }

  cache = { at: Date.now(), data: verbenas };
  return verbenas;
}
