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
  partirPorDias,
  tipoDeEvento,
  ventana
} from './classifier.js';
import { fetchText, textoConSaltos } from './http.js';
import { rastrearProgramas } from './avisos.js';
import type { Verbena } from './types.js';

const BASE = 'https://www.fasnia.com';
export const FASNIA_URL = `${BASE}/fiestas/`;

const MUNI = 'Fasnia';
const NUCLEOS = ['Fasnia', 'Las Eras', 'Sabina Alta', 'La Zarza', 'Las Palmas'];

let cache: { at: number; data: Verbena[] } | null = null;
const TTL = 1000 * 60 * 60;
const PAUSA_MS = 1200;
const MAX_DETALLES = 8;

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Candidato { titulo: string; url: string }

/** Descubre posts en portada, página de fiestas y buscador WP (?s=). */
async function descubrir(): Promise<Candidato[]> {
  const out: Candidato[] = [];
  const seen = new Set<string>();
  const mete = (titulo: string, url: string) => {
    const t = titulo.trim().replace(/\s+/g, ' ');
    if (!t || t.length < 15 || seen.has(url)) return;
    if (!clasificarTitulo(t).esVerbena && !esContenedor(t)) return;
    seen.add(url);
    out.push({ titulo: t, url });
  };
  const paginas = [`${BASE}/`, `${BASE}/fiestas/`, `${BASE}/?s=verbena`, `${BASE}/?s=fiestas`];
  for (const page of paginas) {
    try {
      const html = await fetchText(page);
      rastrearProgramas(MUNI, html, BASE);
      const $ = cheerio.load(html);
      $('a[href]').each((_, a) => {
        let href = $(a).attr('href') || '';
        if (!href.startsWith(BASE + '/') && href.startsWith('/')) href = BASE + href;
        if (!href.startsWith(BASE + '/') || href === BASE + '/') return;
        if (/\.(pdf|jpg|jpeg|png|webp)$/i.test(href.split('?')[0])) return;
        mete($(a).text(), href);
      });
    } catch { /* sigue con la siguiente página */ }
    if (out.length >= MAX_DETALLES) break;
  }
  return out.slice(0, MAX_DETALLES);
}

/** Año del slug (…-2026), si no del <time>, si no actual. */
function anyoDe(html: string, url: string): string {
  const mSlug = url.match(/(20\d{2})/);
  if (mSlug) return mSlug[1];
  const mTime = html.match(/datetime="(20\d{2})-\d{2}-\d{2}/);
  if (mTime) return mTime[1];
  return String(new Date().getFullYear());
}

function nucleoDe(texto: string): string {
  const low = texto.toLowerCase();
  for (const n of NUCLEOS) if (low.includes(n.toLowerCase())) return n;
  return '';
}

export async function obtenerVerbenasFasnia(): Promise<Verbena[]> {
  if (cache && Date.now() - cache.at < TTL) return cache.data;
  const verbenas: Verbena[] = [];
  const push = (v: Verbena) => {
    if (!verbenas.some((x) => x.id === v.id)) verbenas.push(v);
  };

  let items: Candidato[] = [];
  try {
    items = await descubrir();
  } catch (e) {
    console.error('fasnia índice fallo', e);
  }

  for (const it of items) {
    try {
      await espera(PAUSA_MS);
      const d = await fetchText(it.url);
      const cuerpo = textoConSaltos(d);
      const anyo = anyoDe(d, it.url);
      const lugar = lugarCercano(cuerpo.slice(0, 2000), it.titulo) || nucleoDe(cuerpo) || MUNI;
      const slug = it.url.split('/').filter(Boolean).pop() || 'noticia';
      for (const sec of partirPorDias(cuerpo)) {
        const mes = mesANum(sec.mes);
        if (!mes) continue;
        const day = `${String(sec.dia).padStart(2, '0')}-${mes}-${sec.anyo || anyo}`;
        const lineas = [
          ...extraerSubEventos(sec.texto).map((s) => ({ titulo: s.titulo, hora: s.hora, orquestas: s.orquestas })),
          ...extraerBailesSinHora(sec.texto).map((s) => ({ titulo: s.titulo, hora: s.hora || horaPrevia(sec.texto, s.titulo), orquestas: s.orquestas }))
        ];
        for (const l of lineas) {
          const lugarLinea = lugarCercano(sec.texto, l.titulo) || lugar;
          const cls = clasificarDetalle(l.titulo, ventana(sec.texto, l.titulo, 400), l.hora, lugarLinea);
          if (!cls.esVerbena) continue;
          push({
            id: `fasnia-${slug.slice(0, 25)}-${l.hora.replace(':', '') || 's-hora'}-${day}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-'),
            titulo: l.titulo, day, hora: l.hora, municipio: MUNI,
            lugar: lugarLinea, orquestas: l.orquestas,
            tipo: tipoDeEvento(l.titulo), url: it.url,
            score: cls.score, motivos: [...cls.motivos, `noticia: ${it.titulo.slice(0, 50)}`]
          });
        }
      }
    } catch (e) {
      console.error('fasnia detalle fallo', it.url, e);
    }
  }

  cache = { at: Date.now(), data: verbenas };
  return verbenas;
}
