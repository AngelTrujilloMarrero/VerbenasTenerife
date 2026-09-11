import { ADEJE_URL, obtenerVerbenasAdeje } from './adeje.js';
import { ARONA_URL, obtenerVerbenasArona } from './arona.js';
import { GUIADEISORA_URL, obtenerVerbenasGuiaDeIsora } from './guiadeisora.js';
import { LALAGUNA_URL, obtenerVerbenasLaLaguna } from './lalaguna.js';
import { TEGUESTE_URL, obtenerVerbenasTegueste } from './tegueste.js';
import { porFecha, type Fuente, type Verbena } from './types.js';

// Registro de fuentes. Añadir un municipio = 1 línea + su adaptador.
// Escala a 31 sin tocar API ni página.
export const FUENTES: Fuente[] = [
  { id: 'arona', nombre: 'Arona', agendaUrl: ARONA_URL, obtener: obtenerVerbenasArona },
  { id: 'adeje', nombre: 'Adeje', agendaUrl: ADEJE_URL, obtener: obtenerVerbenasAdeje },
  { id: 'tegueste', nombre: 'Tegueste', agendaUrl: TEGUESTE_URL, obtener: obtenerVerbenasTegueste },
  { id: 'lalaguna', nombre: 'La Laguna', agendaUrl: LALAGUNA_URL, obtener: obtenerVerbenasLaLaguna },
  { id: 'guiadeisora', nombre: 'Guía de Isora', agendaUrl: GUIADEISORA_URL, obtener: obtenerVerbenasGuiaDeIsora }
];

export type { Verbena };

/** Agrega todas las fuentes en paralelo; si una falla, las demás siguen. */
export async function obtenerVerbenas(municipio?: string): Promise<Verbena[]> {
  const fuentes = municipio
    ? FUENTES.filter((f) => f.id === municipio.toLowerCase())
    : FUENTES;
  const res = await Promise.allSettled(fuentes.map((f) => f.obtener()));
  const todas: Verbena[] = [];
  res.forEach((r, i) => {
    if (r.status === 'fulfilled') todas.push(...r.value);
    else console.error(`fuente ${fuentes[i].id} falló:`, r.reason);
  });
  return todas.sort(porFecha);
}
