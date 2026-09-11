import * as cheerio from 'cheerio';
import {
  clasificarDetalle,
  mesANum,
  partirPorDias,
  extraerSubEventos,
  tipoDeEvento
} from './classifier.js';
import { fetchText } from './http.js';
import { anyoDelTexto, obtenerTextoPdf } from './pdf.js';
import type { Verbena } from './types.js';

const BASE = 'https://www.tegueste.es';
const FIESTAS = `${BASE}/fiestas/`;
export const TEGUESTE_URL = FIESTAS;

let cache: { at: number; data: Verbena[] } | null = null;
const TTL = 1000 * 60 * 60;

/**
 * DESCUBRIMIENTO (la pregunta del millón): no hay ninguna URL de PDF fija.
 * En cada ejecución se lee /fiestas/ y se recogen los PDFs cuyo enlace o
 * texto mencionen programa + fiestas. Si en diciembre cuelgan
 * "Programa-Fiestas-Navidad-2026.pdf", entra solo en el siguiente ciclo.
 * Límite: PDFs escaneados (solo imagen) se avisan y quedan para Fase 2 (IA visión).
 */
function descubrirProgramas(html: string): { titulo: string; url: string }[] {
  const $ = cheerio.load(html);
  const out: { titulo: string; url: string }[] = [];
  const seen = new Set<string>();
  $('a[href$=".pdf"], a[href*=".pdf?"]').each((_, a) => {
    const href = $(a).attr('href') || '';
    const texto = ($(a).text().trim() + ' ' + href).toLowerCase();
    if (!/programa/.test(texto) || !/fiesta/.test(texto)) return;
    const url = href.startsWith('http') ? href : BASE + href;
    if (seen.has(url)) return;
    seen.add(url);
    out.push({ titulo: $(a).text().trim() || href.split('/').pop() || url, url });
  });
  return out.slice(0, 5);
}

/** Parte una sección de día por viñetas de lugar "• Plaza de San Marcos." */
function partirPorLugar(texto: string): { lugar: string; texto: string }[] {
  const out: { lugar: string; texto: string }[] = [];
  const re = /•\s*([^.\n]{3,80}?)\.\s*/g;
  const marcas: { lugar: string; index: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(texto)) !== null) marcas.push({ lugar: m[1].trim(), index: m.index });
  if (marcas.length === 0) return [{ lugar: '', texto }];
  marcas.forEach((mk, i) => {
    const fin = i + 1 < marcas.length ? marcas[i + 1].index : texto.length;
    out.push({ lugar: mk.lugar, texto: texto.slice(mk.index, fin) });
  });
  return out;
}

export async function obtenerVerbenasTegueste(): Promise<Verbena[]> {
  if (cache && Date.now() - cache.at < TTL) return cache.data;

  const html = await fetchText(FIESTAS);
  const programas = descubrirProgramas(html);
  const verbenas: Verbena[] = [];

  for (const prog of programas) {
    let pdf;
    try {
      pdf = await obtenerTextoPdf(prog.url);
    } catch (e) {
      console.error('pdf fallo', prog.url, e);
      continue;
    }
    if (pdf.escaneado) {
      console.warn(`pdf escaneado sin texto (Fase 2 IA): ${prog.url}`);
      continue;
    }
    const anyo = anyoDelTexto(pdf.texto);
    // Slug estable por PDF para IDs únicos entre programas
    const slug = (prog.url.split('/').pop() || 'pdf').toLowerCase()
      .replace(/\.pdf.*$/, '').replace(/[^a-z0-9]+/g, '-').slice(0, 40);

    for (const sec of partirPorDias(pdf.texto)) {
      const mes = mesANum(sec.mes);
      if (!mes) continue;
      const day = `${String(sec.dia).padStart(2, '0')}-${mes}-${anyo}`;
      for (const bloque of partirPorLugar(sec.texto)) {
        const lugar = bloque.lugar || 'Tegueste';
        for (const sub of extraerSubEventos(bloque.texto)) {
          const cls = clasificarDetalle(sub.titulo, bloque.texto, sub.hora, lugar);
          if (!cls.esVerbena) continue;
          verbenas.push({
            id: `tegueste-${slug}-${sub.hora.replace(':', '')}-${(sub.orquestas[0] || 'x')}`
              .toLowerCase().replace(/\s+/g, '-'),
            titulo: sub.titulo,
            day,
            hora: sub.hora,
            municipio: 'Tegueste',
            lugar: sub.lugar || lugar,
            orquestas: sub.orquestas,
            tipo: tipoDeEvento(sub.titulo),
            url: prog.url,
            score: cls.score,
            motivos: [...cls.motivos, `programa: ${prog.titulo.slice(0, 60)}`]
          });
        }
      }
    }
  }

  cache = { at: Date.now(), data: verbenas };
  return verbenas;
}
