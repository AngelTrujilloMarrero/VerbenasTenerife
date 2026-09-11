// Los 31 municipios + resolución por tokens distintivos.
// Sirve para normalizar el municipio desde textos libres ("lugar: Fañabé",
// slugs "municipio-de-guia-de-isora"...). OJO: barrios repetidos (Tejina hay
// en Tegueste y en Guía de Isora) no resuelven solos: requieren contexto.
export const MUNICIPIOS_31 = [
  'Adeje', 'Arafo', 'Arico', 'Arona', 'Buenavista del Norte', 'Candelaria',
  'El Rosario', 'El Sauzal', 'El Tanque', 'Fasnia', 'Garachico',
  'Granadilla de Abona', 'La Guancha', 'Guía de Isora', 'Güímar',
  'Icod de los Vinos', 'La Matanza', 'La Orotava', 'Puerto de la Cruz',
  'Los Realejos', 'La Laguna', 'San Juan de la Rambla', 'San Miguel de Abona',
  'Santa Cruz de Tenerife', 'Santa Úrsula', 'Santiago del Teide', 'Tacoronte',
  'Tegueste', 'La Victoria', 'Vilaflor', 'Los Silos'
];

const IGNORAR = new Set(['de', 'la', 'el', 'los', 'las', 'del', 'san', 'santa', 'municipio', 'lugar', 'lugares']);

export function normTxt(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z]+/g, ' ').trim();
}

const POR_TOKEN = new Map<string, string>();
for (const m of MUNICIPIOS_31) {
  for (const tok of normTxt(m).split(' ')) {
    if (!tok || IGNORAR.has(tok)) continue;
    // 'cruz'/'victoria'/'matanza'...: primera definición gana; no colisionan
    // entre municipios salvo 'san'/'santa' (ignorados).
    if (!POR_TOKEN.has(tok)) POR_TOKEN.set(tok, m);
  }
}

/** Devuelve el municipio oficial si el texto contiene un token distintivo. */
export function resolverMunicipio(texto: string): string | null {
  for (const tok of normTxt(texto).split(' ')) {
    const m = POR_TOKEN.get(tok);
    if (m) return m;
  }
  return null;
}
