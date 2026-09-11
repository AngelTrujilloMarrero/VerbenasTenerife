import * as cheerio from 'cheerio';
import {
  clasificarDetalle,
  extraerBailesSinHora,
  extraerSubEventos,
  mesANum,
  partirPorDias,
  posEn,
  tipoDeEvento,
  ventana
} from './classifier.js';
import { fetchText, textoConSaltos } from './http.js';
import type { Verbena } from './types.js';

const BASE = 'https://fiestasdesantacruz.com';
const NOTICIAS = `${BASE}/noticias/`;
export const SANTACRUZ_URL = NOTICIAS;

const MUNI = 'Santa Cruz de Tenerife';
const PAUSA_MS = 1200;
const MAX_DETALLES = 6;

let cache: { at: number; data: Verbena[] } | null = null;
const TTL = 1000 * 60 * 60;

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Lugar más cercano ANTES del título: gana la ÚLTIMA mención válida de la
 *  ventana. Se saltan candidatos con verbos ("iglesia y contará con..."). */
const LUGAR_RE = /(Barrio\s+(?:de\s+)?[^.\n,]{2,40}|Plaza\s+(?:de\s+|del\s+)?[^.\n,]{2,40}|Puente\s+[^.\n,]{2,40}|Recinto\s+[^.\n,]{2,40}|Auditorio\s+[^.\n,]{2,40}|Teatro\s+[^.\n,]{2,40}|Parque\s+[^.\n,]{2,40}|Alameda\s+[^.\n,]{2,40}|Iglesia\s+[^.\n,]{2,40})/gi;
const LUGAR_MALO = /contar[áa]|habr[áa]|ser[áa]|tienen|pueden|celebra|cuenta|actuaci|tendr[áa]|podr[áa]|dar[áa]/i;
function lugarSC(seccion: string, titulo: string): string {
  const idx = posEn(seccion, titulo);
  const prev = idx === -1 ? seccion.slice(0, 600) : seccion.slice(Math.max(0, idx - 400), idx);
  let m: RegExpExecArray | null;
  let ultimo = '';
  LUGAR_RE.lastIndex = 0;
  while ((m = LUGAR_RE.exec(prev)) !== null) {
    const cand = m[1].trim();
    if (!LUGAR_MALO.test(cand)) ultimo = cand;
  }
  return ultimo || MUNI;
}

/** Descubre posts recientes de fiestas + páginas fijas de programas. */
async function descubrir(): Promise<{ titulo: string; url: string }[]> {
  const out: { titulo: string; url: string }[] = [];
  const seen = new Set<string>();
  const mete = (titulo: string, url: string) => {
    const t = titulo.trim().replace(/\s+/g, ' ');
    if (!t || t.length < 15 || seen.has(url)) return;
    seen.add(url);
    out.push({ titulo: t, url });
  };

  const html = await fetchText(NOTICIAS);
  const $ = cheerio.load(html);
  $('a[href*="/blog/"]').each((_, a) => {
    const href = $(a).attr('href') || '';
    if (!/\/blog\/[^/]+\/$/.test(href)) return;
    const titulo = $(a).text().trim();
    if (!titulo) return;
    if (!/fiesta|verbena|programa|fin de semana|orquesta|baile|carnaval/i.test(titulo)) return;
    mete(titulo, href.startsWith('http') ? href : BASE + href);
  });

  // Programas fijos del menú "Ver Programas" (largo recorrido: Mayo, Navidad...)
  for (const slug of ['programa-fiestas-de-mayo-2026', 'programa-navidad-2025', 'programa-dia-de-canarias-2026']) {
    mete(slug.replace(/-/g, ' '), `${BASE}/${slug}/`);
  }
  return out.slice(0, MAX_DETALLES);
}

export async function obtenerVerbenasSantaCruz(): Promise<Verbena[]> {
  if (cache && Date.now() - cache.at < TTL) return cache.data;
  const verbenas: Verbena[] = [];
  const push = (v: Verbena) => {
    if (!verbenas.some((x) => x.id === v.id)) verbenas.push(v);
  };

  let items: { titulo: string; url: string }[] = [];
  try {
    items = await descubrir();
  } catch (e) {
    console.error('santacruz índice fallo', e);
  }

  for (const it of items) {
    try {
      await espera(PAUSA_MS);
      const cuerpo = textoConSaltos(await fetchText(it.url));
      // Año del propio encabezado ("...de 2026"); si no, año actual.
      // NUNCA del texto global (los menús mencionan Carnaval 2027).
      const anyoDefecto = String(new Date().getFullYear());
      const slug = it.url.split('/').filter(Boolean).pop() || 'post';
      for (const sec of partirPorDias(cuerpo)) {
        const mes = mesANum(sec.mes);
        if (!mes) continue;
        const day = `${String(sec.dia).padStart(2, '0')}-${mes}-${sec.anyo || anyoDefecto}`;
        const candidatos = [
          ...extraerSubEventos(sec.texto).map((s) => ({ titulo: s.titulo, hora: s.hora, orquestas: s.orquestas, extra: 0 })),
          ...extraerBailesSinHora(sec.texto).map((s) => ({ titulo: s.titulo, hora: s.hora, orquestas: s.orquestas, extra: s.explicita ? 2 : 0 }))
        ];
        for (const l of candidatos) {
          const lugar = lugarSC(sec.texto, l.titulo);
          const cls = clasificarDetalle(l.titulo, ventana(sec.texto, l.titulo, 400), l.hora, lugar, l.extra);
          if (!cls.esVerbena) continue;
          // ID único por contenido (misma página+hora puede traer 2 verbenas)
          const semilla = (l.orquestas[0] || l.titulo.split(/\s+/).slice(0, 3).join(' '))
            .toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').slice(0, 24);
          push({
            id: `santacruz-${slug.slice(0, 20)}-${l.hora.replace(':', '') || 'sh'}-${semilla}-${day}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-'),
            titulo: l.titulo, day, hora: l.hora, municipio: MUNI, lugar,
            orquestas: l.orquestas, tipo: tipoDeEvento(l.titulo), url: it.url,
            score: cls.score, motivos: [...cls.motivos, `vía fiestasdesantacruz: ${it.titulo.slice(0, 50)}`]
          });
        }
      }
    } catch (e) {
      console.error('santacruz detalle fallo', it.url, e);
    }
  }

  cache = { at: Date.now(), data: verbenas };
  return verbenas;
}
