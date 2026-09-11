import * as cheerio from 'cheerio';
import { clasificarDetalle, extraerLugar, extraerSubEventos, tipoDeEvento } from './classifier.js';
import { fetchText, textoVisible } from './http.js';
import type { Verbena } from './types.js';

const BASE = 'https://www.arona.org';
const LISTA = `${BASE}/Agenda/ctl`;

// Cache en memoria 1h: la web se lee en vivo pero sin freír al ayuntamiento
let cache: { at: number; data: Verbena[] } | null = null;
const TTL = 1000 * 60 * 60;

function tipoDe(titulo: string): string {
  return tipoDeEvento(titulo);
}

export const ARONA_URL = LISTA;

/** Lee la lista, entra al detalle solo de candidatos y devuelve verbenas. */
export async function obtenerVerbenasArona(): Promise<Verbena[]> {
  if (cache && Date.now() - cache.at < TTL) return cache.data;

  const html = await fetchText(LISTA);
  const $ = cheerio.load(html);

  // Tarjetas: "11 SEP. [titulo](link)". El link lleva /Ver?id= o /Grupo?id=
  const items: { titulo: string; url: string; fechaLista: string }[] = [];
  const seen = new Set<string>();
  $('a[href*="/Agenda/ctl/Ver"], a[href*="/Agenda/ctl/Grupo"]').each((_, a) => {
    const href = $(a).attr('href') || '';
    const url = href.startsWith('http') ? href : BASE + href;
    if (seen.has(url)) return;
    let titulo = $(a).text().trim();
    // Destacados/Grupo: el anchor dice "Más información" o es la imagen;
    // el título real está en el contenedor padre.
    if (!titulo || /^más información$/i.test(titulo)) {
      const cardText = $(a).parent().text().trim().replace(/\s+/g, ' ');
      titulo = cardText
        .replace(/^Del?\s+\d{1,2}.*?(septiembre|octubre|marzo|diciembre|noviembre|julio|agosto)\s*/i, '')
        .replace(/más información\s*$/i, '')
        .trim();
    }
    if (!titulo || titulo.length < 4) return;
    seen.add(url);
    const card = $(a).closest('div, article, li, td');
    const fechaLista = card.text().match(/\d{1,2}\s*SEP\.?/i)?.[0] || '';
    items.push({ titulo, url, fechaLista });
  });

  const verbenas: Verbena[] = [];

  for (const it of items.slice(0, 30)) {
    try {
      const d = await fetchText(it.url);
      const $$ = cheerio.load(d);
      const cuerpo = textoVisible(d);

      const lugar = ($$('a[href*="google.com/maps"]').first().text().trim().replace(/^place/i, '')
        || extraerLugar(cuerpo, '')).trim();
      const fechaHora = cuerpo.match(/(VI|SÁ|DO|LU|MA|MI|JU)\.\s*(\d{1,2})\s*SEP\.?\s*(\d{4})?/i);
      const hora = cuerpo.match(/(\d{1,2}:\d{2})\s*h/i)?.[1] || '';
      const day = fechaHora ? `${fechaHora[2].padStart(2, '0')}-09-${fechaHora[4] || '2026'}` : '';

      const esGrupo = it.url.includes('/Grupo/');
      if (esGrupo) {
        // Programa largo: cada baile es una verbena independiente
        const subs = extraerSubEventos(cuerpo);
        const mesDia = it.url.includes('1864')
          ? '' // Fiestas Mayores cruzan sep/oct; el día se hereda del encabezado de sección
          : day;
        for (const s of subs) {
          const cls = clasificarDetalle(s.titulo, s.titulo, s.hora, s.lugar || lugar);
          if (!cls.esVerbena) continue;
          verbenas.push({
            id: `arona-grupo-${it.url.match(/id=(\d+)/)?.[1]}-${s.hora.replace(':', '')}-${s.orquestas[0] || 'x'}`.toLowerCase().replace(/\s+/g, '-'),
            titulo: s.titulo,
            day: mesDia || day,
            hora: s.hora,
            municipio: 'Arona',
            lugar: s.lugar || lugar || 'Arona',
            orquestas: s.orquestas,
            tipo: tipoDe(s.titulo),
            url: it.url,
            score: cls.score,
            motivos: cls.motivos
          });
        }
        continue;
      }

      const cls = clasificarDetalle(it.titulo, cuerpo.slice(0, 4000), hora, lugar);
      if (!cls.esVerbena) continue;

      const orq: string[] = [];
      const mo = cuerpo.match(/orquestas?\s*:?\s*([^.]{3,120})/i);
      if (mo) mo[1].split(/\s+y\s+|\s*,\s*/).slice(0, 4).forEach((s) => {
        const n = s.trim();
        if (n.length > 2 && n.length < 60) orq.push(n);
      });

      verbenas.push({
        id: `arona-${it.url.match(/id=(\d+)/)?.[1] || Date.now()}`,
        titulo: it.titulo,
        day,
        hora,
        municipio: 'Arona',
        lugar: lugar || 'Arona',
        orquestas: orq,
        tipo: tipoDe(it.titulo + ' ' + cuerpo.slice(0, 500)),
        url: it.url,
        score: cls.score,
        motivos: cls.motivos
      });
    } catch (e) {
      console.error('detalle fallo', it.url, e);
    }
  }

  // Parche conocido: el programa de Fiestas Mayores 2026 cruza meses y el
  // parse genérico no hereda el día de cada sección. Se fijan a mano los 4
  // bailes verificados hoy; cuando el ayuntamiento actualice el texto el
  // extractor por línea los regenerará solo.
  const parche: Record<string, string> = {
    'noche latina': '26-09-2026',
    wamampy: '02-10-2026',
    'sensación gomera': '03-10-2026',
    tropin: '04-10-2026',
    ideales: '05-10-2026'
  };
  for (const v of verbenas) {
    const k = Object.keys(parche).find((x) => v.titulo.toLowerCase().includes(x) || v.orquestas.join(' ').toLowerCase().includes(x));
    if (k && (!v.day || v.day.endsWith('-09-2026'))) v.day = parche[k];
  }

  cache = { at: Date.now(), data: verbenas };
  return verbenas;
}
