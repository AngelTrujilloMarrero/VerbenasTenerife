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
import { fetchText } from './http.js';
import { rastrearProgramas } from './avisos.js';
import { anyoDelTexto, obtenerTextoPdf } from './pdf.js';
import type { Verbena } from './types.js';

const BASE = 'https://www.tacoronte.es';
const LISTA = `${BASE}/eventos/`;
export const TACORONTE_URL = LISTA;

const MUNI = 'Tacoronte';

let cache: { at: number; data: Verbena[] } | null = null;
const TTL = 1000 * 60 * 60;
const PAUSA_MS = 1200;
const MAX_DETALLES = 6;

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Candidato { titulo: string; url: string }

/** Descubre eventos en /eventos/ (fichas con meta Fecha/Lugar + programa en Drive). */
async function descubrir(): Promise<Candidato[]> {
  const out: Candidato[] = [];
  const seen = new Set<string>();
  const html = await fetchText(LISTA);
  rastrearProgramas(MUNI, html, BASE);
  const $ = cheerio.load(html);
  $('a[href*="/eventos/"]').each((_, a) => {
    const href = $(a).attr('href') || '';
    if (!href.startsWith(`${BASE}/eventos/`) || href.replace(/\/$/, '') === `${BASE}/eventos`) return;
    const titulo = $(a).text().trim().replace(/\s+/g, ' ');
    if (!titulo || titulo.length < 10 || seen.has(href)) return;
    if (!clasificarTitulo(titulo).esVerbena && !esContenedor(titulo)) return;
    seen.add(href);
    out.push({ titulo, url: href });
  });
  return out.slice(0, MAX_DETALLES);
}

/** Programa en PDF vía Google Drive (uc?export=download). */
async function pdfPrograma(html: string): Promise<string | null> {
  const m = html.match(/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]+)/);
  if (!m) return null;
  const pdf = await obtenerTextoPdf(`https://drive.google.com/uc?export=download&id=${m[1]}`, undefined, true, MUNI);
  if (pdf.escaneado) return null; // avisado en pdf.ts (monitor /api/estado.json)
  return pdf.texto;
}

export async function obtenerVerbenasTacoronte(): Promise<Verbena[]> {
  if (cache && Date.now() - cache.at < TTL) return cache.data;
  const verbenas: Verbena[] = [];
  const push = (v: Verbena) => {
    if (!verbenas.some((x) => x.id === v.id)) verbenas.push(v);
  };

  let items: Candidato[] = [];
  try {
    items = await descubrir();
  } catch (e) {
    console.error('tacoronte índice fallo', e);
  }

  for (const it of items) {
    try {
      await espera(PAUSA_MS);
      const d = await fetchText(it.url);
      const pdfTexto = await pdfPrograma(d).catch(() => null);
      const lugarFicha = (() => {
        const m = d.match(/Plaza del Cristo(?: de Tacoronte)?/i);
        return m ? m[0].trim() : '';
      })();
      const slug = it.url.split('/').filter(Boolean).pop() || 'evento';
      // El programa manda; si no hay PDF, el texto de la ficha
      const fuentes = pdfTexto ? [pdfTexto] : [it.titulo];
      for (const fuente of fuentes) {
        const cuerpo = normalizarHoras(fuente);
        const ctx = mesContexto(cuerpo);
        const anyo = ctx.anyo || anyoDelTexto(cuerpo);
        // ref valida día-semana en cabeceras día-primero y tumba restos
        // de paginación ("24 25 Jueves", "13 14 Domingo")
        const ref = ctx.mes && anyo ? { mes: ctx.mes, anyo } : undefined;
        for (const sec of partirPorDias(cuerpo, ref)) {
          const mes = mesANum(sec.mes) || ctx.mes;
          if (!mes) continue;
          const day = `${String(sec.dia).padStart(2, '0')}-${mes}-${anyo}`;
          const lineas = [
            ...extraerSubEventos(sec.texto).map((s) => ({ titulo: s.titulo, hora: s.hora, orquestas: s.orquestas, extra: 0 })),
            ...extraerBailesSinHora(sec.texto).map((s) => ({ titulo: s.titulo, hora: s.hora || horaPrevia(sec.texto, s.titulo), orquestas: s.orquestas, extra: s.explicita ? 2 : 0 }))
          ];
          for (const l of lineas) {
            const lugar = lugarCercano(sec.texto, l.titulo) || lugarFicha || MUNI;
            const cls = clasificarDetalle(l.titulo, ventana(sec.texto, l.titulo, 400), l.hora, lugar, l.extra);
            if (!cls.esVerbena) continue;
            push({
              id: `tacoronte-${slug.slice(0, 20)}-${l.hora.replace(':', '') || 'sh'}-${day}-${l.titulo.split(/\s+/).slice(0, 3).join(' ')}`.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9-]+/g, '-'),
              titulo: l.titulo, day, hora: l.hora, municipio: MUNI,
              lugar, orquestas: l.orquestas,
              tipo: tipoDeEvento(l.titulo), url: it.url,
              score: cls.score, motivos: [...cls.motivos, `ficha: ${it.titulo.slice(0, 50)}`]
            });
          }
        }
      }
    } catch (e) {
      console.error('tacoronte detalle fallo', it.url, e);
    }
  }

  cache = { at: Date.now(), data: verbenas };
  return verbenas;
}
