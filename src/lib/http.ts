// Helper HTTP compartido (una sola UA para los 31 aytos).
export async function fetchText(url: string): Promise<string> {
  const r = await fetch(url, {
    headers: { 'User-Agent': 'VerbenasTenerife/0.1 (piloto; contacto admin)' }
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} en ${url}`);
  return r.text();
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
    .map((l) => l.replace(/[\s\u00A0]+/g, ' ').trim())
    .filter((l) => l.length > 0)
    .join('\n');
}
