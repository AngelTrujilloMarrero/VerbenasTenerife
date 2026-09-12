// Coordenadas por municipio para meteo (centros aproximados).
// Escala a 31 añadiendo líneas. La AEMET llegará cuando exista su clave en Vercel.
export const COORDS: Record<string, { lat: number; lon: number }> = {
  arona: { lat: 28.0999, lon: -16.68 },
  adeje: { lat: 28.1227, lon: -16.7253 },
  tegueste: { lat: 28.5219, lon: -16.3387 },
  lalaguna: { lat: 28.4856, lon: -16.3134 },
  guiadeisora: { lat: 28.2097, lon: -16.7792 },
  elrosario: { lat: 28.526, lon: -16.368 },
  arico: { lat: 28.1833, lon: -16.4667 },
  fasnia: { lat: 28.2398, lon: -16.4243 },
  tacoronte: { lat: 28.4787, lon: -16.4119 },
  sanjuandelarambla: { lat: 28.3947, lon: -16.6486 },
  icoddelosvinos: { lat: 28.3679, lon: -16.7195 },
  lossilos: { lat: 28.3641, lon: -16.8139 },
  buenavista: { lat: 28.3725, lon: -16.8492 },
  buenavistadelnorte: { lat: 28.3725, lon: -16.8492 },
  laorotava: { lat: 28.3905, lon: -16.5233 },
  losrealejos: { lat: 28.3804, lon: -16.5796 },
  guimar: { lat: 28.3156, lon: -16.4137 },
  candelaria: { lat: 28.3548, lon: -16.3716 },
  elsauzal: { lat: 28.4781, lon: -16.4357 },
  santaursula: { lat: 28.4567, lon: -16.4900 }
};

export function coordsDe(municipio: string): { lat: number; lon: number } | null {
  const k = municipio.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, '');
  return COORDS[k] || null;
}
