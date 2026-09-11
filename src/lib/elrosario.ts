import * as cheerio from 'cheerio';
import {
  clasificarDetalle,
  clasificarTitulo,
  esContenedor,
  extraerSubEventos,
  lugarCercano,
  mesANum,
  partirPorDias,
  tipoDeEvento,
  ventana
} from './classifier.js';
import { fetchText, textoConSaltos } from './http.js';
import type { Verbena } from './types.js';

const BASE = 'https://www.ayuntamientoelrosario.org';
export const ELROSARIO_URL = `${BASE}/index.php/noticias/`;

const MUNI = 'El Rosario';
// Núcleos del municipio (para el campo lugar)
const NUCLEOS = ['La Esperanza', 'El Chorrillo', 'Llano del Moro', 'Tabaiba',
  'Machado', 'Radazul', 'Boca Cangrejo', 'Varadero', 'Llano Blanco'];

let cache: { at: number; data: Verbena[] } | null = null;
const TTL = 1000 * 60 * 60;
const PAUSA_MS = 1200;
const MAX_DETALLES = 8;

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Candidato { titulo: string; url: string; anyo: string }

/** Descubre posts vía buscador WP (?s=). URLs fechadas /YYYY/MM/DD/slug/. */
async function descubrir(): Promise<Candidato[]> {
  const out: Candidato[] = [];
  const seen = new Set<string>();
  const pat = /href="(https:\/\/www\.ayuntamientoelrosario\.org\/index\.php\/([0-9]{4})\/([0-9]{2})\/([0-9]{2})\/[^"/]+\/)"[^>]*>([^<]{5,120})</g;
  for (const q of ['verbena', 'baile', 'orquesta', 'fiestas']) {
    try {
      const html = await fetchText(`${BASE}/?s=${q}`);
      let m: RegExpExecArray | null;
      pat.lastIndex = 0;
      while ((m = pat.exec(html)) !== null) {
        const url = m[1];
        if (seen.has(url)) continue;
        const titulo = m[5].replace(/\s+/g, ' ').trim();
        if (!titulo) continue;
        if (!clasificarTitulo(titulo).esVerbena && !esContenedor(titulo)) continue;
        seen.add(url);
        out.push({ titulo, url, anyo: m[2] });
      }
    } catch { /* sigue con la otra query */ }
    if (out.length >= MAX_DETALLES) break;
  }
  return out.slice(0, MAX_DETALLES);
}

/** Cuerpo del artículo (h1.post-title ... "Compartir"), sin menús. */
function cuerpoArticulo(html: string): string {
  const i = html.search(/<h1[^>]*class="[^"]*post-title[^"]*"[^>]*>/i);
  const base = i >= 0 ? html.slice(i) : html;
  const fin = base.search(/Compartir|share-post|post-navigation|related|Relacionad/i);
  return textoConSaltos(fin > 0 ? base.slice(0, fin) : base);
}

function nucleoDe(texto: string): string {
  const low = texto.toLowerCase();
  for (const n of NUCLEOS) if (low.includes(n.toLowerCase())) return n;
  return '';
}

/** Fecha "9 de mayo" del título + año de la URL. */
function diaDeTitulo(titulo: string, anyo: string): string {
  const m = titulo.match(/(\d{1,2})\s+de\s+([a-záéíóúñ]+)/i);
  if (!m) return '';
  const mes = mesANum(m[2]);
  return mes ? `${m[1].padStart(2, '0')}-${mes}-${anyo}` : '';
}

export async function obtenerVerbenasElRosario(): Promise<Verbena[]> {
  if (cache && Date.now() - cache.at < TTL) return cache.data;
  const verbenas: Verbena[] = [];
  const push = (v: Verbena) => {
    if (!verbenas.some((x) => x.id === v.id)) verbenas.push(v);
  };

  let items: Candidato[] = [];
  try {
    items = await descubrir();
  } catch (e) {
    console.error('elrosario índice fallo', e);
  }

  for (const it of items) {
    try {
      await espera(PAUSA_MS);
      const d = await fetchText(it.url);
      const cuerpo = cuerpoArticulo(d);
      const lugar = lugarCercano(cuerpo.slice(0, 2000), it.titulo) || nucleoDe(cuerpo) || MUNI;
      const slug = it.url.split('/').filter(Boolean).pop() || 'noticia';
      const dayTitulo = diaDeTitulo(it.titulo, it.anyo);
      // 1) Secciones de día dentro del cuerpo ("el sábado 9 de mayo")
      let sacadas = 0;
      for (const sec of partirPorDias(cuerpo)) {
        const mes = mesANum(sec.mes) || mesANum(it.titulo.match(/de\s+([a-záéíóúñ]+)/i)?.[1] || '');
        if (!mes) continue;
        const day = `${String(sec.dia).padStart(2, '0')}-${mes}-${sec.anyo || it.anyo}`;
        for (const sub of extraerSubEventos(sec.texto)) {
          const cls = clasificarDetalle(sub.titulo, ventana(sec.texto, sub.titulo, 400), sub.hora, sub.lugar || lugar);
          if (!cls.esVerbena) continue;
          sacadas++;
          push({
            id: `elrosario-${slug.slice(0, 20)}-${sub.hora.replace(':', '') || 'sh'}-${day}-${sub.titulo.split(/\s+/).slice(0, 3).join(' ')}`.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9-]+/g, '-'),
            titulo: sub.titulo, day, hora: sub.hora, municipio: MUNI,
            lugar: sub.lugar || lugar, orquestas: sub.orquestas,
            tipo: tipoDeEvento(sub.titulo), url: it.url,
            score: cls.score, motivos: [...cls.motivos, `noticia: ${it.titulo.slice(0, 50)}`]
          });
        }
      }
      // 2) Sin secciones: el propio titular como evento (fecha en título/URL)
      if (!sacadas && dayTitulo) {
        const hora = cuerpo.match(/(\d{1,2}:\d{2})\s*h/i)?.[1] || '';
        const cls = clasificarDetalle(it.titulo, cuerpo.slice(0, 4000), hora, lugar);
        if (!cls.esVerbena) continue;
        push({
          id: `elrosario-${slug.slice(0, 25)}-${dayTitulo}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-'),
          titulo: it.titulo, day: dayTitulo, hora, municipio: MUNI, lugar,
          orquestas: [], tipo: tipoDeEvento(it.titulo), url: it.url,
          score: cls.score, motivos: cls.motivos
        });
      }
    } catch (e) {
      console.error('elrosario detalle fallo', it.url, e);
    }
  }

  cache = { at: Date.now(), data: verbenas };
  return verbenas;
}
