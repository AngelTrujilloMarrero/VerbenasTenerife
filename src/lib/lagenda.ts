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
import { fetchText, fetchTextConSaltos } from './http.js';
import { resolverMunicipio } from './municipios.js';
import type { Verbena } from './types.js';

const BASE = 'https://lagenda.org';
const PLANFINDE = `${BASE}/programacion/planfinde`;
export const LAGENDA_URL = PLANFINDE;

let cache: { at: number; data: Verbena[] } | null = null;
const TTL = 1000 * 60 * 60;
// robots.txt pide Crawl-delay: 10; volumen pequeño (1 índice + pocos detalles
// por hora, con caché), pero espaciamos los detalles por cortesía.
const PAUSA_MS = 1200;
const MAX_DETALLES = 12;

/** "Sáb, 12/09/26" -> 20260912 para priorizar lo más próximo. */
function diaListaKey(diaLista: string): number {
  const m = diaLista.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (!m) return 99999999;
  const y = m[3].length === 2 ? '20' + m[3] : m[3];
  return Number(`${y}${m[2].padStart(2, '0')}${m[1].padStart(2, '0')}`);
}

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ItemFinde {
  titulo: string;
  url: string;
  categoria: string;
  diaLista: string; // "Sáb, 12/09/26"
  lugarTexto: string;
  lugarHref: string;
}

/** Índice del finde: bloques .small-post con título/categoría/fecha/lugar. */
async function indiceFinde(): Promise<ItemFinde[]> {
  const $ = cheerio.load(await fetchText(PLANFINDE));
  const out: ItemFinde[] = [];
  const seen = new Set<string>();
  $('.small-post').each((_, el) => {
    const a = $(el).find('h4.title a').first();
    const titulo = a.text().trim().replace(/\s+/g, ' ');
    const href = a.attr('href') || '';
    if (!titulo || !href.startsWith('/programacion/') || seen.has(href)) return;
    seen.add(href);
    out.push({
      titulo,
      url: BASE + href,
      categoria: $(el).find('.post-category a[href*="/categoria/"]').first().text().trim().toLowerCase(),
      diaLista: $(el).find('.post-date').first().text().trim(),
      lugarTexto: $(el).find('.post-category a[href*="/lugares/"]').first().text().trim(),
      lugarHref: $(el).find('.post-category a[href*="/lugares/"]').first().attr('href') || ''
    });
  });
  return out;
}

function municipioDe(item: ItemFinde, cuerpo: string): string {
  // 1) slug del lugar: /lugares/municipio-de-guia-de-isora o /lugares/adeje/fanabe
  const seg = (item.lugarHref.split('?')[0].split('/').filter(Boolean).slice(1).join(' ') || '');
  return resolverMunicipio(seg) || resolverMunicipio(item.lugarTexto) ||
    resolverMunicipio(cuerpo.slice(0, 2000)) || 'Tenerife';
}

/** Año desde los chips de fecha ("Sáb, 12/09/26"). OJO: coger el AÑO (26),
 *  no el mes (09): /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/. */
function anyoDe(texto: string, diaLista: string): string {
  const m = (diaLista + ' ' + texto).match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/) ||
    texto.match(/\b(20[2-9]\d)\b/);
  if (!m) return String(new Date().getFullYear());
  const y = m[3] || m[1];
  return y.length === 2 ? '20' + y : y;
}

export async function obtenerVerbenasLagenda(): Promise<Verbena[]> {
  if (cache && Date.now() - cache.at < TTL) return cache.data;
  const verbenas: Verbena[] = [];

  let items: ItemFinde[] = [];
  try {
    items = await indiceFinde();
  } catch (e) {
    console.error('lagenda índice fallo', e);
    cache = { at: Date.now(), data: verbenas };
    return verbenas;
  }

  const candidatos = items
    .filter(
      (it) => it.categoria === 'fiestas populares' || esContenedor(it.titulo) || clasificarTitulo(it.titulo).esVerbena
    )
    .sort((a, b) => diaListaKey(a.diaLista) - diaListaKey(b.diaLista))
    .slice(0, MAX_DETALLES);

  for (const it of candidatos) {
    try {
      await espera(PAUSA_MS);
      // Con saltos de línea: cada "HH:MM - acto" queda en su línea
      const cuerpo = await fetchTextConSaltos(it.url);
      const municipio = municipioDe(it, cuerpo);
      const anyo = anyoDe(cuerpo, it.diaLista);
      const slug = it.url.split('/').pop() || 'ev';
      for (const sec of partirPorDias(cuerpo)) {
        const mes = mesANum(sec.mes);
        if (!mes) continue;
        const day = `${String(sec.dia).padStart(2, '0')}-${mes}-${anyo}`;
        for (const sub of extraerSubEventos(sec.texto)) {
          const cls = clasificarDetalle(sub.titulo, ventana(sec.texto, sub.titulo, 400), sub.hora, '');
          if (!cls.esVerbena) continue;
          verbenas.push({
            id: `lagenda-${slug.slice(0, 30)}-${sub.hora.replace(':', '')}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-'),
            titulo: sub.titulo,
            day,
            hora: sub.hora,
            municipio,
            // Recinto del programa > núcleo del índice > municipio
            lugar: sub.lugar || lugarCercano(sec.texto, sub.titulo) || it.lugarTexto || municipio,
            orquestas: sub.orquestas,
            tipo: tipoDeEvento(sub.titulo),
            url: it.url,
            score: cls.score,
            motivos: [...cls.motivos, `vía lagenda: ${it.titulo.slice(0, 50)}`]
          });
        }
      }
    } catch (e) {
      console.error('lagenda detalle fallo', it.url, e);
    }
  }

  cache = { at: Date.now(), data: verbenas };
  return verbenas;
}
