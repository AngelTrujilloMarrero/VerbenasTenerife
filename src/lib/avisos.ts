// Monitor central de programas y salud de fuentes (gratis, sin servicios).
// Los adaptadores avisan aquí cuando detectan un programa nuevo (PDF o solo
// imagen), un PDF escaneado sin texto o un fallo. El endpoint /api/estado.json
// lo expone para vigilancia sin mirar logs del servidor.
//
// Los avisos llevan timestamp y se deduplican por (municipio, tipo, url), así
// que un programa pendiente no spamea: aparece una vez hasta que se resuelve.
export type TipoAviso = 'programa-pdf' | 'pdf-escaneado' | 'programa-imagen' | 'ocr-en-curso' | 'fuente-fallo' | 'sin-eventos';

export interface Aviso {
  at: number;
  municipio: string;
  tipo: TipoAviso;
  url: string;
  detalle: string;
}

const avisos: Aviso[] = [];
const MAX = 300;

/** Registra un aviso (y lo deja también en el log del servidor). */
export function avisar(municipio: string, tipo: TipoAviso, url: string, detalle = ''): void {
  const at = Date.now();
  console.warn(`[${municipio}] ${tipo}: ${detalle} ${url}`);
  const i = avisos.findIndex((a) => a.municipio === municipio && a.tipo === tipo && a.url === url);
  if (i >= 0) {
    avisos[i] = { at, municipio, tipo, url, detalle };
  } else {
    avisos.push({ at, municipio, tipo, url, detalle });
    if (avisos.length > MAX) avisos.shift();
  }
}

/** Avisos recientes (por defecto, últimas 30 h: cubre varios ciclos de 1 h). */
export function leerAvisos(maxHoras = 30): Aviso[] {
  const corte = Date.now() - maxHoras * 3600 * 1000;
  return avisos.filter((a) => a.at >= corte).sort((a, b) => b.at - a.at);
}

// Programas del año en curso en enlaces ("Programa-San-Jose-2026.pdf").
// Solo año vigente para no reflotar históricos; máx 5 por pasada.
const RE_PDF = /\.pdf(?:[?#]|$)/i;
const RE_PROG = /programa|fiesta|cartel|verbena|romer|festival|gala/i;

/** Rastrea programas nuevos en el HTML ya descargado (sin coste extra) y los
 *  avisa para revisión/OCR. Automático en todos los adaptadores: basta con
 *  llamarlo sobre la página índice/agenda. No descarga nada. */
export function rastrearProgramas(municipio: string, html: string, base: string): string[] {
  const vigente = String(new Date().getFullYear());
  const vistas = new Set<string>();
  const nuevas: string[] = [];
  const re = /<a[^>]+href=["']([^"']+)["\'][^>]*>(.*?)<\/a>/gis;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && nuevas.length < 5) {
    let href = (m[1] || '').trim();
    if (!RE_PDF.test(href.split('?')[0])) continue;
    if (!href.startsWith('http')) {
      if (!href.startsWith('/')) continue;
      href = base.replace(/\/$/, '') + href;
    }
    if (vistas.has(href)) continue;
    vistas.add(href);
    const texto = (m[2] || '').replace(/<[^>]+>/g, ' ');
    if (!RE_PROG.test(href + ' ' + texto)) continue;
    if (!href.includes(vigente)) continue;
    nuevas.push(href);
    avisar(municipio, 'programa-pdf', href, 'programa detectado en agenda');
  }
  return nuevas;
}
