import * as cheerio from 'cheerio';
import {
  clasificarDetalle,
  extraerBailesSinHora,
  extraerSubEventos,
  mesANum,
  partirPorDias,
  tipoDeEvento,
  ventana
} from './classifier.js';
import { fetchText, textoConSaltos } from './http.js';
import type { Verbena } from './types.js';

const BASE = 'https://www.granadilladeabona.org';
const TEC = `${BASE}/wp-json/tribe/events/v1/events`;
const TAG = `${BASE}/tag/cultura-y-fiestas/`;
export const GRANADILLA_URL = `${BASE}/events/mes/`;

const MUNI = 'Granadilla de Abona';
const NUCLEOS = ['El Médano', 'San Isidro', 'Los Abrigos', 'Chimiche', 'Charco del Pino', 'El Salto', 'Granadilla'];

let cache: { at: number; data: Verbena[] } | null = null;
const TTL = 1000 * 60 * 60;
const UA = 'VerbenasTenerife/0.1 (piloto; contacto admin)';

interface TecEv {
  title?: string;
  url?: string;
  start_date?: string;
  end_date?: string;
  venue?: { venue?: string; address?: string };
  description?: string;
}

/** The Events Calendar REST: eventos estructurados hoy → +90 días.
 *  Patrón reutilizable para cualquier WordPress con este plugin. */
async function eventosTEC(): Promise<TecEv[]> {
  const f = (d: Date) => d.toISOString().slice(0, 10);
  const url = `${TEC}?start_date=${f(new Date())}&end_date=${f(new Date(Date.now() + 90 * 864e5))}&per_page=50&status=publish`;
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error(`TEC HTTP ${r.status}`);
  const j = await r.json().catch(() => ({}));
  return Array.isArray(j?.events) ? j.events : [];
}

const aDMY = (iso: string): string => {
  const m = (iso || '').match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
};
const horaDe = (iso: string): string => (iso || '').match(/T(\d{2}:\d{2})/)?.[1] || '';
const sinHTML = (html: string): string =>
  html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ').replace(/[\s\u00A0]+/g, ' ').trim();

function nucleoDe(texto: string): string {
  const low = texto.toLowerCase();
  for (const n of NUCLEOS) if (low.includes(n.toLowerCase())) return n;
  return MUNI;
}

/** Noticias recientes de fiestas (tag cultura-y-fiestas): de aquí sale el programa. */
async function noticiasFiestas(): Promise<{ titulo: string; url: string }[]> {
  const html = await fetchText(TAG);
  const $ = cheerio.load(html);
  const out: { titulo: string; url: string }[] = [];
  const seen = new Set<string>();
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href') || '';
    if (!href.startsWith(BASE + '/') && !href.startsWith('/')) return;
    if (/\/category\/|\/author\/|\/tag\/|wp-content|\/page\/|\/events?\//.test(href)) return;
    const titulo = $(a).text().trim().replace(/\s+/g, ' ');
    if (titulo.length < 20 || seen.has(href)) return;
    if (!/fiesta|verbena|programa|romer[ií]a/i.test(titulo)) return;
    seen.add(href);
    out.push({ titulo, url: href.startsWith('http') ? href : BASE + href });
  });
  return out.slice(0, 4);
}

/** Mes/año de contexto ("9 septiembre, 2026" de la publicación). */
function contextoFecha(cuerpo: string): { mes: string; anyo: string } {
  const m = cuerpo.match(/(\d{1,2})\s+de\s+([a-záéíóúñ]+),?\s*(20\d{2})?/i)
    || cuerpo.match(/([a-záéíóúñ]+)\s*,?\s*(20\d{2})/i);
  if (!m) return { mes: '', anyo: String(new Date().getFullYear()) };
  const meses = m[2] && !/^\d+$/.test(m[2]) ? m[2] : m[1];
  return { mes: mesANum(meses), anyo: m[3] || String(new Date().getFullYear()) };
}

export async function obtenerVerbenasGranadilla(): Promise<Verbena[]> {
  if (cache && Date.now() - cache.at < TTL) return cache.data;
  const verbenas: Verbena[] = [];
  const push = (v: Verbena) => {
    if (!verbenas.some((x) => x.id === v.id)) verbenas.push(v);
  };

  // 1) TEC REST
  try {
    for (const ev of await eventosTEC()) {
      const titulo = (ev.title || '').trim();
      if (!titulo) continue;
      const day = aDMY(ev.start_date || '');
      const hora = horaDe(ev.start_date || '');
      const desc = sinHTML(ev.description || '').slice(0, 2000);
      const lugar = (ev.venue?.venue || ev.venue?.address || '').trim() || MUNI;
      const cls = clasificarDetalle(titulo, `${titulo}. ${desc}`, hora, lugar);
      if (!cls.esVerbena) continue;
      push({
        id: `granadilla-tec-${ev.id || day + hora}`.toLowerCase(),
        titulo, day, hora, municipio: MUNI, lugar,
        orquestas: [], tipo: tipoDeEvento(titulo), url: ev.url || GRANADILLA_URL,
        score: cls.score, motivos: [...cls.motivos, 'vía TEC REST']
      });
    }
  } catch (e) {
    console.error('granadilla TEC fallo', e);
  }

  // 2) Noticias de fiestas con programa
  let noticias: { titulo: string; url: string }[] = [];
  try {
    noticias = await noticiasFiestas();
  } catch (e) {
    console.error('granadilla tag fallo', e);
  }
  for (const n of noticias) {
    try {
      const cuerpo = textoConSaltos(await fetchText(n.url));
      const ctx = contextoFecha(cuerpo);
      const lugar = nucleoDe(n.titulo + ' ' + cuerpo.slice(0, 1500));
      const slug = n.url.split('/').filter(Boolean).pop() || 'noticia';
      for (const sec of partirPorDias(cuerpo)) {
        const mes = mesANum(sec.mes) || ctx.mes;
        if (!mes) continue;
        const day = `${String(sec.dia).padStart(2, '0')}-${mes}-${ctx.anyo}`;
        const lineas = [
          ...extraerSubEventos(sec.texto).map((s) => ({ titulo: s.titulo, hora: s.hora, orquestas: s.orquestas })),
          ...extraerBailesSinHora(sec.texto).map((s) => ({ titulo: s.titulo, hora: '', orquestas: s.orquestas }))
        ];
        for (const l of lineas) {
          const cls = clasificarDetalle(l.titulo, ventana(sec.texto, l.titulo, 400), l.hora, lugar);
          if (!cls.esVerbena) continue;
          push({
            id: `granadilla-${slug.slice(0, 20)}-${l.hora.replace(':', '') || 's-hora'}-${day}-${l.titulo.split(/\s+/).slice(0, 3).join(' ')}`.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9-]+/g, '-'),
            titulo: l.titulo, day, hora: l.hora, municipio: MUNI, lugar,
            orquestas: l.orquestas, tipo: tipoDeEvento(l.titulo), url: n.url,
            score: cls.score, motivos: [...cls.motivos, `noticia: ${n.titulo.slice(0, 50)}`]
          });
        }
      }
    } catch (e) {
      console.error('granadilla noticia fallo', n.url, e);
    }
  }

  cache = { at: Date.now(), data: verbenas };
  return verbenas;
}
