import * as cheerio from 'cheerio';
import {
  clasificarDetalle,
  clasificarTitulo,
  esContenedor,
  extraerLugar,
  extraerSubEventos,
  mesANum,
  partirPorDias,
  RE_LUGAR_CODIGO,
  tipoDeEvento
} from './classifier.js';
import { fetchText, textoVisible } from './http.js';
import { rastrearProgramas } from './avisos.js';
import type { Verbena } from './types.js';

const BASE = 'https://www.adeje.es';
const LISTA = `${BASE}/agenda?pag=1&ViewStyle=GRID`;
export const ADEJE_URL = `${BASE}/agenda`;

let cache: { at: number; data: Verbena[] } | null = null;
const TTL = 1000 * 60 * 60;

function normFechaEstatica(cuerpo: string): { mes: string; anyo: string } {  // "Del 11 al 13 de septiembre de 2026" -> mes/anyo del rango
  const m = cuerpo.match(/del\s+\d{1,2}\s+al\s+\d{1,2}\s+de\s+([a-záéíóúñ]+)\s+de\s+(\d{4})/i)
    || cuerpo.match(/de\s+([a-záéíóúñ]+)\s+de\s+(\d{4})/i);
  if (!m) return { mes: '', anyo: '2026' };
  return { mes: mesANum(m[1]), anyo: m[2] };
}

/** "Lugar:" desde el HTML (<strong>Lugar:</strong><br>La Quinta, Adeje).
 *  Preciso: en texto plano el valor corre hasta el menú (sin puntos). */
function lugarEstructurado(html: string): string {
  const v = (html.match(/<strong>\s*Lugar:\s*<\/strong>\s*<br\s*\/?>\s*([^<]{2,80})/i)?.[1] || '')
    .replace(/\s+/g, ' ').trim();
  if (!v || RE_LUGAR_CODIGO.test(v)) return '';
  return v;
}

/** Adaptador Adeje: lista /agenda (links /evento/ID) + detalle con programa por días. */
export async function obtenerVerbenasAdeje(): Promise<Verbena[]> {
  if (cache && Date.now() - cache.at < TTL) return cache.data;

  const html = await fetchText(LISTA);
  rastrearProgramas('Adeje', html, BASE);
  const $ = cheerio.load(html);

  // Dos anchors por evento (imagen sin texto + título); nos quedamos con el título.
  const items: { titulo: string; url: string }[] = [];
  const seen = new Set<string>();
  $('a[href*="/evento/"]').each((_, a) => {
    const titulo = $(a).text().trim().replace(/\s+/g, ' ');
    const href = $(a).attr('href') || '';
    const url = href.startsWith('http') ? href : BASE + href;
    if (!titulo || titulo.length < 4 || seen.has(url)) return;
    seen.add(url);
    items.push({ titulo, url });
  });

  const verbenas: Verbena[] = [];

  for (const it of items.slice(0, 30)) {
    // Prefiltro barato: candidatos por título o posibles contenedores
    // ("Fiestas de La Quinta"). El resto (misa, basket, rutas...) ni se descarga.
    const pre = clasificarTitulo(it.titulo);
    if (!pre.esVerbena && !esContenedor(it.titulo)) continue;

    try {
      const d = await fetchText(it.url);
      const cuerpo = textoVisible(d);
      const lugar = lugarEstructurado(d) || extraerLugar(cuerpo, 'Adeje');
      const ctx = normFechaEstatica(cuerpo);

      // 1) Programa multi-día: partir por "Sábado 12 de septiembre" y buscar bailes
      const secciones = partirPorDias(cuerpo);
      if (secciones.length > 0) {
        for (const s of secciones) {
          const mes = mesANum(s.mes) || ctx.mes;
          const day = mes ? `${String(s.dia).padStart(2, '0')}-${mes}-${ctx.anyo}` : '';
          for (const sub of extraerSubEventos(s.texto)) {
            const cls = clasificarDetalle(sub.titulo, sub.titulo, sub.hora, sub.lugar || lugar);
            if (!cls.esVerbena) continue;
            verbenas.push({
              id: `adeje-${it.url.match(/evento\/(\d+)/)?.[1]}-${sub.hora.replace(':', '')}`.toLowerCase(),
              titulo: sub.titulo,
              day,
              hora: sub.hora,
              municipio: 'Adeje',
              lugar: sub.lugar || lugar,
              orquestas: sub.orquestas,
              tipo: tipoDeEvento(sub.titulo),
              url: it.url,
              score: cls.score,
              motivos: cls.motivos
            });
          }
        }
        continue;
      }

      // 2) Evento de un solo día que ya es verbena por sí mismo
      const hora = cuerpo.match(/(\d{1,2}:\d{2})\s*h/i)?.[1] || '';
      const cls = clasificarDetalle(it.titulo, cuerpo.slice(0, 4000), hora, lugar);
      if (!cls.esVerbena) continue;
      const f = cuerpo.match(/(\d{1,2})[^\d]{1,4}(septiembre|octubre|noviembre|diciembre|enero|febrero|marzo|abril|mayo|junio|julio|agosto)\s+de\s+(\d{4})/i);
      const day = f ? `${f[1].padStart(2, '0')}-${mesANum(f[2])}-${f[3]}` : '';
      const orq: string[] = [];
      const mo = cuerpo.match(/orquestas?\s*:?\s*([^.]{3,120})/i);
      if (mo) mo[1].split(/\s+y\s+|\s*,\s*/).slice(0, 4).forEach((s) => {
        const n = s.trim();
        if (n.length > 2 && n.length < 60) orq.push(n);
      });
      verbenas.push({
        // ID estable entre pasadas (antes Date.now(): fila nueva cada vez).
        id: `adeje-${it.url.match(/evento\/(\d+)/)?.[1] || `${day}-${it.titulo.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').slice(0, 30)}`}`,
        titulo: it.titulo,
        day,
        hora,
        municipio: 'Adeje',
        lugar,
        orquestas: orq,
        tipo: tipoDeEvento(it.titulo),
        url: it.url,
        score: cls.score,
        motivos: cls.motivos
      });
    } catch (e) {
      console.error('detalle fallo', it.url, e);
    }
  }

  cache = { at: Date.now(), data: verbenas };
  return verbenas;
}
