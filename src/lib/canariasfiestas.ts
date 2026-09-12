import * as cheerio from 'cheerio';
import {
  clasificarDetalle,
  extraerBailesSinHora,
  extraerSubEventos,
  lugarCercano,
  mesANum,
  mesContexto,
  normalizarHoras,
  partirPorDias,
  recortarProsa,
  tipoDeEvento,
  ventana
} from './classifier.js';
import { fetchText, textoConSaltos } from './http.js';
import { avisar, rastrearProgramas } from './avisos.js';
import { resolverMunicipio } from './municipios.js';
import type { Verbena } from './types.js';

// CanariasFiestas: blog de programas de TODA Canarias. Interesa solo
// Tenerife: archivo mensual (/2026/09/ + /page/2/) filtrado por municipio
// en el título ("Benijos, La Orotava, ..." = barrio, municipio, fiesta).
// Programas inline con día+hora ("Sábado 12 ... 21:00 Verbena a cargo de").
// Agregador como lagenda: va ÚLTIMO y sus duplicados se fusionan (gana la
// fuente oficial). Solo año vigente; resto de islas se descarta.
const BASE = 'https://www.canariasfiestas.es';
export const CANARIASFIESTAS_URL = `${BASE}/tenerife-programas-activos`;

const PAUSA_MS = 1200;
const MAX_DETALLES = 8;

let cache: { at: number; data: Verbena[] } | null = null;
const TTL = 1000 * 60 * 60;

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Candidato { titulo: string; url: string; municipio: string; anyo: string }

// Isla/municipio NO tinerfeño: se descarta aunque resuelva por token
// ("Guía, Las Marías" es Gáldar, no Guía de Isora).
const NO_TENERIFE = /\b(gran canaria|grancanaria|g[aá]ldar|ag[uü]imes|telde|moya|artenara|alojera|vallehermoso|oliva|tirajana|tunte|tinajo|betancuria|yaiza|tijarafe|mancha blanca|puerto del rosario|hondura|garaf[ií]a|p[aá]jara|lanzarote|fuerteventura|el hierro|la gomera|la palma|gomera|hierro)\b/i;

/** Municipio por las DOS primeras partes ("Benijos, La Orotava, ..." ->
 *  La Orotava). La advocación (3ª+) miente: "Costa Norte" no es Buenavista,
 *  "Exaltación de la Cruz" no es Puerto de la Cruz ni "San Miguel Arcángel"
 *  es San Miguel de Abona. Sin municipio ahí, se descarta.
 *  "Guía" a secas es Gáldar: exige Isora/Tenerife en contexto. */
function municipioDePartes(titulo: string, cuerpo: string): string | null {
  if (NO_TENERIFE.test(titulo)) return null;
  const partes = titulo.split(',').slice(0, 2);
  for (const p of partes) {
    const t = p.trim();
    if (!t) continue;
    if (/^santa\s+cruz$/i.test(t)) return 'Santa Cruz de Tenerife';
    if (/^gu[ií]a$/i.test(t)) {
      if (!/isora|tenerife/i.test(titulo + ' ' + cuerpo.slice(0, 1500))) continue;
      return 'Guía de Isora';
    }
    const m = resolverMunicipio(t);
    if (m) return m;
  }
  return null;
}

/** Barrio del titular ("Benijos, La Orotava, ..." -> "Benijos"). */
function barrioDe(titulo: string): string {
  return (titulo.split(',')[0] || '').trim();
}

function tituloLimpio(t: string): string {
  // "Benijos, La Orotava, San Isidro Labrador y Santa María de la Cabeza 2026"
  return t.replace(/\s+20\d{2}\s*$/, '').trim();
}

/** Enlaces de programas del archivo mensual (todas sus páginas). */
async function archivoMes(y: number, m: number): Promise<{ titulo: string; url: string }[]> {
  const out: { titulo: string; url: string }[] = [];
  const seen = new Set<string>();
  for (let pag = 1; pag <= 6; pag++) {
    const url = pag === 1
      ? `${BASE}/${y}/${String(m).padStart(2, '0')}/`
      : `${BASE}/${y}/${String(m).padStart(2, '0')}/page/${pag}/`;
    let html = '';
    try {
      html = await fetchText(url);
    } catch {
      break; // mes o página inexistente (octubre aún vacío)
    }
    if (pag === 1) rastrearProgramas('CanariasFiestas', html, BASE);
    const $ = cheerio.load(html);
    let nuevos = 0;
    $('a[href]').each((_, a) => {
      const href = $(a).attr('href') || '';
      if (!href.startsWith(`${BASE}/${y}/`) || !href.endsWith('.html') || seen.has(href)) return;
      // El thumbnail repite el enlace con texto vacío: solo vale el
      // ancla con título (si no, la URL quedaría consumida sin título).
      const t = tituloLimpio($(a).text().replace(/\s+/g, ' ').trim());
      if (t.length < 15) return;
      seen.add(href);
      nuevos++;
      out.push({ titulo: t, url: href });
    });
    if (!nuevos) break;
    if (out.length >= 40) break;
  }
  return out;
}

function mesDominante(texto: string): string {
  const meses = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'setiembre', 'octubre', 'noviembre', 'diciembre'];
  const low = ' ' + texto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '') + ' ';
  let mejor = '', mejorN = 0;
  for (const m of meses) {
    const n = (low.match(new RegExp(`\\d{1,2} de ${m}\\b`, 'g')) || []).length;
    if (n > mejorN) { mejorN = n; mejor = m; }
  }
  return mejorN >= 1 ? mesANum(mejor) : '';
}

function lugarContinuacion(seccion: string, titulo: string): string {
  const idx = seccion.indexOf(titulo.slice(0, 22));
  if (idx === -1) return '';
  const post = seccion.slice(idx + titulo.length, idx + titulo.length + 300);
  const m = post.match(/A continuaci[oó]n\s*[–-]\s*([^.\n]{3,80})/i);
  if (!m) return '';
  const r = m[1].match(/(Plaza|Parque|Cancha|Recinto|Auditorio|Teatro|Pabell[oó]n|Polideportivo|Mercado|Iglesia|Ermita|Escenario|Campo|Calle|Casa|Bas[ií]lica)[ \t]+[^.\n,]{2,40}/i);
  if (!r) return '';
  return recortarProsa(r[0].trim().replace(/\s+\d{1,2}:\d{2}h?\b.*$/, '').trim());
}

function horaPreviaDoc(base: string, titulo: string, radio = 600): string {
  const enTitulo = titulo.match(/(\d{1,2}:\d{2})/);
  if (enTitulo) return enTitulo[1];
  const idx = base.lastIndexOf(titulo.slice(0, 30));
  if (idx === -1) return '';
  const prev = base.slice(Math.max(0, idx - radio), idx);
  const rangos = [...prev.matchAll(/(\d{1,2}:\d{2})\s*a(?:\s*las)?\s*\d{1,2}:\d{2}/gi)].map((x) => x[1]);
  if (rangos.length) return rangos[rangos.length - 1];
  const sueltas = [...prev.matchAll(/(\d{1,2}:\d{2})/g)].map((x) => x[1]);
  return sueltas.length ? sueltas[sueltas.length - 1] : '';
}

function juntarHoraLugar(cuerpo: string): string {
  return cuerpo.replace(
    /^(\d{1,2}:\d{2})\s*h(?:oras?)?\.?\s*[–-]\s*([^.\n]{2,80})\n(?=(?!lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo\b)[A-ZÁÉÍÓÚÑ“"0-9])/gm,
    '$1 - $3 ($2)');
}

export async function obtenerVerbenasCanariasFiestas(): Promise<Verbena[]> {
  if (cache && Date.now() - cache.at < TTL) return cache.data;
  const verbenas: Verbena[] = [];
  const push = (v: Verbena) => {
    if (!verbenas.some((x) => x.id === v.id)) verbenas.push(v);
  };

  // Mes en curso y siguiente (los programas salen por adelantado).
  const ahora = new Date();
  const meses: [number, number][] = [];
  for (let k = 0; k < 2; k++) {
    const d = new Date(ahora.getFullYear(), ahora.getMonth() + k, 1);
    meses.push([d.getFullYear(), d.getMonth() + 1]);
  }
  const vigente = String(ahora.getFullYear());

  const candidatos: Candidato[] = [];
  const seen = new Set<string>();
  for (const [y, m] of meses) {
    for (const c of await archivoMes(y, m)) {
      if (seen.has(c.url)) continue;
      // Año del slug; el archivo mensual ya acota, pero el slug manda.
      const anyo = c.url.match(/(20\d{2})/)?.[1] || String(y);
      if (anyo !== vigente && !c.url.includes(vigente)) continue;
      // El archivo mensual solo trae programas: con municipio tinerfeño
      // en las dos primeras partes ya es candidato (el detalle confirma).
      const muni = municipioDePartes(c.titulo, '');
      if (!muni) continue;
      seen.add(c.url);
      candidatos.push({ titulo: c.titulo, url: c.url, municipio: muni, anyo });
      if (candidatos.length >= MAX_DETALLES) break;
    }
    if (candidatos.length >= MAX_DETALLES) break;
  }

  for (const it of candidatos) {
    try {
      await espera(PAUSA_MS);
      const html = await fetchText(it.url);
      const cuerpo = normalizarHoras(textoConSaltos(html));
      // Revalida municipio con el cuerpo (el titular corto engaña).
      const muni = municipioDePartes(it.titulo, cuerpo) || it.municipio;
      const anyo = it.url.match(/(20\d{2})/)?.[1] || it.anyo;
      const slug = it.url.split('/').filter(Boolean).pop()?.replace(/\.html.*$/, '') || 'programa';
      const barrio = barrioDe(it.titulo);
      const ctx = mesContexto(cuerpo);
      const mesDoc = ctx.mes || mesDominante(cuerpo);
      const ref = mesDoc && anyo ? { mes: mesDoc, anyo } : undefined;
      let mesPrev = '', anyoPrev = '';
      const secciones = partirPorDias(juntarHoraLugar(cuerpo), ref);
      for (const [i, sec] of secciones.entries()) {
        if (sec.mes) mesPrev = sec.mes;
        if (sec.anyo) anyoPrev = sec.anyo;
        let mes = mesANum(sec.mes);
        if (!mes) {
          for (let j = i - 1; j >= 0 && !mes; j--) {
            if (secciones[j].mes && /de\s+[a-záéíóúñ]+/i.test(secciones[j].texto.slice(0, 60))) mes = mesANum(secciones[j].mes);
          }
          for (let j = i + 1; j < secciones.length && !mes; j++) {
            if (secciones[j].mes && /de\s+[a-záéíóúñ]+/i.test(secciones[j].texto.slice(0, 60))) mes = mesANum(secciones[j].mes);
          }
        }
        if (!mes) continue;
        const day = `${String(sec.dia).padStart(2, '0')}-${mes}-${sec.anyo || anyoPrev || anyo}`;
        const contextoHora = (secciones[i - 1]?.texto.slice(-600) || '') + sec.texto;
        const lineas = [
          ...extraerSubEventos(sec.texto).map((s) => ({ titulo: s.titulo, hora: s.hora, orquestas: s.orquestas, extra: 0 })),
          ...extraerBailesSinHora(sec.texto).map((s) => ({
            titulo: s.titulo, hora: horaPreviaDoc(contextoHora, s.titulo), orquestas: s.orquestas, extra: s.explicita ? 2 : 0
          }))
        ];
        for (const l of lineas) {
          const lugarLinea = lugarCercano(sec.texto, l.titulo) || lugarContinuacion(sec.texto, l.titulo) || barrio || muni;
          const cls = clasificarDetalle(l.titulo, ventana(sec.texto, l.titulo, 400), l.hora, lugarLinea, l.extra);
          if (!cls.esVerbena) continue;
          push({
            id: `canariasfiestas-${slug.slice(0, 20)}-${l.hora.replace(':', '') || 'sh'}-${day}`.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9-]+/g, '-'),
            titulo: l.titulo, day, hora: l.hora, municipio: muni,
            lugar: lugarLinea, orquestas: l.orquestas,
            tipo: tipoDeEvento(l.titulo), url: it.url,
            score: cls.score, motivos: [...cls.motivos, `programa: ${it.titulo.slice(0, 50)}`]
          });
        }
      }
    } catch (e) {
      console.error('canariasfiestas detalle fallo', it.url, e);
    }
  }

  if (verbenas.length === 0) {
    avisar('CanariasFiestas', 'sin-eventos', CANARIASFIESTAS_URL, 'sin programas tinerfeños vigentes');
  }

  cache = { at: Date.now(), data: verbenas };
  return verbenas;
}
