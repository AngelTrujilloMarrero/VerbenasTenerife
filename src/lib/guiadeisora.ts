import * as cheerio from 'cheerio';
import {
  clasificarDetalle,
  clasificarTitulo,
  esContenedor,
  extraerSubEventos,
  mesANum,
  partirPorDias,
  tipoDeEvento
} from './classifier.js';
import { fetchText, textoVisible } from './http.js';
import { rastrearProgramas } from './avisos.js';
import type { Verbena } from './types.js';

const BASE = 'https://www.guiadeisora.org';
const AJAX = `${BASE}/corp/wp-admin/admin-ajax.php`;
export const GUIADEISORA_URL = `${BASE}/corp/calendario-de-eventos/`;

let cache: { at: number; data: Verbena[] } | null = null;
const TTL = 1000 * 60 * 60;
const UA = 'VerbenasTenerife/0.1 (piloto; contacto admin)';

interface EoEv { title?: string; start?: string; url?: string }

/**
 * Calendario Event Organiser vía su endpoint AJAX (la página "Cargando…"
 * no trae nada en el HTML). Rango hoy → +60 días.
 * Documentado para reutilizar en otros WordPress con Event Organiser.
 * NOTA: web obsoleta (vive de agregadores); ver plan de fuentes
 * alternativas en vilaflor.ts.
 */
async function eventosEO(): Promise<EoEv[]> {
  const f = (d: Date) => d.toISOString().slice(0, 10);
  const url = `${AJAX}?action=eventorganiser-fullcal&start=${f(new Date())}&end=${f(new Date(Date.now() + 60 * 864e5))}&event_category=&event_venue=`;
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(25000) });
  const j = await r.json().catch(() => []);
  return Array.isArray(j) ? j : [];
}

const aDMY = (iso: string): string => {
  const m = iso.match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
};
const horaDe = (iso: string): string => iso.match(/T(\d{2}:\d{2})/)?.[1] || '';

/** Rastrea el buscador WP (?s=) por si la verbena solo sale en noticias. */
async function noticiasCandidatas(): Promise<{ titulo: string; url: string }[]> {
  const out: { titulo: string; url: string }[] = [];
  const seen = new Set<string>();
  for (const q of ['verbena', 'orquesta']) {
    try {
      const html = await fetchText(`${BASE}/corp/?s=${q}`);
      rastrearProgramas('Guía de Isora', html, BASE);
      const $ = cheerio.load(html);
      $('a[href*="/corp/"]').each((_, a) => {
        const href = $(a).attr('href') || '';
        const titulo = $(a).text().trim().replace(/\s+/g, ' ');
        if (!titulo || titulo.length < 15 || seen.has(href)) return;
        if (!/\/corp\/[^/]+\/$/.test(href)) return; // solo posts/páginas finales
        if (!clasificarTitulo(titulo).esVerbena && !esContenedor(titulo)) return;
        seen.add(href);
        out.push({ titulo, url: href });
      });
    } catch { /* sigue con la otra query */ }
  }
  return out.slice(0, 3);
}

function diaDeNoticia(cuerpo: string): string {
  const m = cuerpo.match(/(\d{1,2})\s+de\s+([a-záéíóúñ]+)(?:\s*,?\s*(\d{4}))?/i);
  if (!m) return '';
  const mes = mesANum(m[2]);
  return mes ? `${m[1].padStart(2, '0')}-${mes}-${m[3] || '2026'}` : '';
}

export async function obtenerVerbenasGuiaDeIsora(): Promise<Verbena[]> {
  if (cache && Date.now() - cache.at < TTL) return cache.data;
  const verbenas: Verbena[] = [];

  // 1) Calendario oficial (hoy vacío, pero el monitor queda puesto)
  try {
    for (const ev of await eventosEO()) {
      const titulo = (ev.title || '').trim();
      if (!titulo) continue;
      const day = aDMY(ev.start || '');
      const hora = horaDe(ev.start || '');
      const cls = clasificarDetalle(titulo, titulo, hora, '');
      if (!cls.esVerbena) continue;
      verbenas.push({
        id: `guiaisora-eo-${day}-${hora}`.replace(/[^a-z0-9-]+/gi, '-').toLowerCase(),
        titulo, day, hora, municipio: 'Guía de Isora', lugar: 'Guía de Isora',
        orquestas: [], tipo: tipoDeEvento(titulo), url: ev.url || GUIADEISORA_URL,
        score: cls.score, motivos: cls.motivos
      });
    }
  } catch (e) {
    console.error('guiaisora EO fallo', e);
  }

  // 2) Noticias que hablen de verbenas/orquestas
  for (const n of await noticiasCandidatas()) {
    try {
      const d = await fetchText(n.url);
      const cuerpo = textoVisible(d);
      const day = diaDeNoticia(cuerpo);
      const secs = partirPorDias(cuerpo);
      if (secs.length) {
        for (const s of secs) {
          const mes = mesANum(s.mes);
          const dd = mes ? `${String(s.dia).padStart(2, '0')}-${mes}-${day.slice(-4) || '2026'}` : day;
          for (const sub of extraerSubEventos(s.texto)) {
            const cls = clasificarDetalle(sub.titulo, s.texto, sub.hora, '');
            if (!cls.esVerbena) continue;
            verbenas.push({
              id: `guiaisora-not-${dd}-${sub.hora}`.replace(/[^a-z0-9-]+/gi, '-').toLowerCase(),
              titulo: sub.titulo, day: dd, hora: sub.hora, municipio: 'Guía de Isora',
              lugar: 'Guía de Isora', orquestas: sub.orquestas, tipo: tipoDeEvento(sub.titulo),
              url: n.url, score: cls.score, motivos: cls.motivos
            });
          }
        }
      } else {
        const hora = cuerpo.match(/(\d{1,2}:\d{2})\s*h/i)?.[1] || '';
        const cls = clasificarDetalle(n.titulo, cuerpo.slice(0, 4000), hora, '');
        if (!cls.esVerbena) continue;
        verbenas.push({
          id: `guiaisora-not-${day || 'sfecha'}`.replace(/[^a-z0-9-]+/gi, '-').toLowerCase(),
          titulo: n.titulo, day, hora, municipio: 'Guía de Isora', lugar: 'Guía de Isora',
          orquestas: [], tipo: tipoDeEvento(n.titulo), url: n.url,
          score: cls.score, motivos: cls.motivos
        });
      }
    } catch { /* una noticia caída no tumba la fuente */ }
  }

  cache = { at: Date.now(), data: verbenas };
  return verbenas;
}
