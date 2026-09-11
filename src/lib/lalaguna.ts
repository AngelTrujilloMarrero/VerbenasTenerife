import * as cheerio from 'cheerio';
import {
  clasificarDetalle,
  lugarCercano,
  mesANum,
  partirPorDias,
  extraerSubEventos,
  tipoDeEvento
} from './classifier.js';
import { fetchText } from './http.js';
import { anyoDelTexto, obtenerTextoPdf } from './pdf.js';
import type { Verbena } from './types.js';

const BASE = 'https://www.aytolalaguna.es';
const FIESTAS = `${BASE}/servicios/fiestas/`;
export const LALAGUNA_URL = FIESTAS;

// El programa del Cristo pesa ~96 MB: límite ampliado solo aquí.
const MAX_BYTES_CRISTO = 120 * 1024 * 1024;

let cache: { at: number; data: Verbena[] } | null = null;
const TTL = 1000 * 60 * 60;

/**
 * Descubre programas vigentes: enlaces a PDF con "programa" en texto o URL,
 * descartando los de años pasados (San Benito 2021/2022/2024/2025...).
 * Un programa nuevo (p. ej. Navidad en diciembre) entra solo.
 */
function descubrirProgramas(html: string): { titulo: string; url: string }[] {
  const $ = cheerio.load(html);
  const out: { titulo: string; url: string }[] = [];
  const seen = new Set<string>();
  $('a[href$=".pdf"], a[href*=".pdf?"], a[href*=".pdf#"]').each((_, a) => {
    const href = $(a).attr('href') || '';
    const texto = ($(a).text().trim() + ' ' + href).toLowerCase();
    if (!/programa/.test(texto)) return;
    const url = href.startsWith('http') ? href : BASE + href;
    if (seen.has(url)) return;
    // Años mencionados: si hay alguno pasado y ninguno vigente, es histórico
    const anyos = (texto.match(/\b(20\d{2})\b/g) || []).map(Number)
      .concat((url.match(/(\d{2})(?=\.pdf)/) || []).map((n) => 2000 + Number(n)));
    const vigente = Number(new Date().getFullYear());
    if (anyos.length > 0 && Math.max(...anyos) < vigente) return;
    seen.add(url);
    out.push({ titulo: $(a).text().trim() || href.split('/').pop() || url, url });
  });
  return out.slice(0, 5);
}

/** Ventana de contexto alrededor de la línea: evita que puntúen orquestas
 *  de otros actos del mismo día (p. ej. la Filarmónica del show familiar). */
function ventana(sec: string, titulo: string, radio = 600): string {
  const idx = sec.indexOf(titulo.slice(0, 30));
  if (idx === -1) return sec.slice(0, 1200);
  return sec.slice(Math.max(0, idx - radio), idx + titulo.length + radio);
}
/** Lugar más cercano ANTES del título: helper compartido de classifier.ts
 *  (con filtros anti-rutas y anti-saltos de línea); si no hay recinto, La Laguna. */
const lugarLaLaguna = (sec: string, titulo: string): string =>
  lugarCercano(sec, titulo) || 'La Laguna';

export async function obtenerVerbenasLaLaguna(): Promise<Verbena[]> {
  if (cache && Date.now() - cache.at < TTL) return cache.data;

  const html = await fetchText(FIESTAS);
  const programas = descubrirProgramas(html);
  const verbenas: Verbena[] = [];

  for (const prog of programas) {
    let pdf;
    try {
      pdf = await obtenerTextoPdf(prog.url, MAX_BYTES_CRISTO);
    } catch (e) {
      console.error('pdf fallo', prog.url, e);
      continue;
    }
    if (pdf.escaneado) {
      console.warn(`pdf escaneado sin texto (Fase 2 IA): ${prog.url}`);
      continue;
    }
    const anyo = anyoDelTexto(pdf.texto);
    const slug = (prog.url.split('/').pop() || 'pdf').toLowerCase()
      .replace(/\.pdf.*$/, '').replace(/[^a-z0-9]+/g, '-').slice(0, 40);

    for (const sec of partirPorDias(pdf.texto)) {
      const mes = mesANum(sec.mes);
      if (!mes) continue;
      const day = `${String(sec.dia).padStart(2, '0')}-${mes}-${anyo}`;
      for (const sub of extraerSubEventos(sec.texto)) {
        const lugar = sub.lugar || lugarLaLaguna(sec.texto, sub.titulo);
        const cls = clasificarDetalle(sub.titulo, ventana(sec.texto, sub.titulo), sub.hora, lugar);
        if (!cls.esVerbena) continue;
        verbenas.push({
          id: `lalaguna-${slug}-${sub.hora.replace(':', '')}-${(sub.orquestas[0] || sub.titulo.slice(0, 12))}`
            .toLowerCase().replace(/\s+/g, '-'),
          titulo: sub.titulo,
          day,
          hora: sub.hora,
          municipio: 'La Laguna',
          lugar,
          orquestas: sub.orquestas,
          tipo: tipoDeEvento(sub.titulo),
          url: prog.url,
          score: cls.score,
          motivos: [...cls.motivos, `programa: ${prog.titulo.slice(0, 60)}`]
        });
      }
    }
  }

  cache = { at: Date.now(), data: verbenas };
  return verbenas;
}
