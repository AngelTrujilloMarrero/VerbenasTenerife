// Helper HTTP compartido (una sola UA para los 31 aytos).
// Con timeout: una fuente colgada falla rápido (chip ✗) en vez de colgar la petición.
import * as cheerio from 'cheerio';

export async function fetchText(url: string, timeoutMs = 25000): Promise<string> {
  const r = await fetch(url, {
    headers: { 'User-Agent': 'VerbenasTenerife/0.1 (piloto; contacto admin)' },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} en ${url}`);
  return r.text();
}

export async function fetchBytes(url: string, timeoutMs = 60000): Promise<Uint8Array> {
  const r = await fetch(url, {
    headers: { 'User-Agent': 'VerbenasTenerife/0.1 (piloto; contacto admin)' },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} en ${url}`);
  return new Uint8Array(await r.arrayBuffer());
}

/**
 * Texto preservando saltos de línea (<br>, <p>, <li>...): imprescindible para
 * que el extractor de líneas ("HH:MM - Baile...") no cruce de una línea a otra.
 */
export async function fetchTextConSaltos(url: string): Promise<string> {
  const html = await fetchText(url);
  return textoConSaltos(html);
}

export function textoConSaltos(html: string): string {
  const conSaltos = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n');
  // Strip tags sin cheerio (rápido y suficiente para programas)
  return conSaltos
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .split('\n')
    .map((l) => decodificarEntidades(l).replace(/[\s\u00A0]+/g, ' ').trim())
    .filter((l) => l.length > 0)
    .join('\n');
}

/** Texto visible del body: SIN scripts/estilos. cheerio.text() los incluye y
 *  el JS inline contamina lugar, fechas y clasificador
 *  ("Lugar: La Quinta, Adeje function mostrarEventosPasados(){ $('#boto..."). */
export function textoVisible(html: string): string {
  const $ = cheerio.load(html);
  $('script, style, noscript').remove();
  return $('body').text().replace(/\s+/g, ' ');
}

/** Decodifica entidades HTML (&nbsp;, &amp;, &mdash;...). Sin esto los
 *  títulos salen con "Verbena y&nbsp;el&nbsp;domingo". */
export function decodificarEntidades(s: string): string {
  return s
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;|&#38;/gi, '&')
    .replace(/&lt;|&#60;/gi, '<')
    .replace(/&gt;|&#62;/gi, '>')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&ndash;|&#8211;/gi, '-')
    .replace(/&mdash;|&#8212;/gi, '-')
    .replace(/&hellip;|&#8230;/gi, '...')
    .replace(/&[a-z]+;/gi, ' ');
}
