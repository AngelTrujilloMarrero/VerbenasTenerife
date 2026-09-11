// Coordenadas por municipio para meteo (centros aproximados).
// Escala a 31 añadiendo líneas. La AEMET llegará cuando exista su clave en Vercel.
export const COORDS: Record<string, { lat: number; lon: number }> = {
  arona: { lat: 28.0999, lon: -16.68 },
  adeje: { lat: 28.1227, lon: -16.7253 },
  tegueste: { lat: 28.5219, lon: -16.3387 },
  lalaguna: { lat: 28.4856, lon: -16.3134 },
  guiadeisora: { lat: 28.2097, lon: -16.7792 },
  elrosario: { lat: 28.526, lon: -16.368 }
};

export function coordsDe(municipio: string): { lat: number; lon: number } | null {
  const k = municipio.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, '');
  return COORDS[k] || null;
}
