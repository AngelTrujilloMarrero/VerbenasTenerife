// Fechas en formato dd-mm-yyyy (el que devuelven los adaptadores).
// Hoy en hora local de Canarias para no tumbar la verbena de esta noche.

/** dd-mm-yyyy de hoy. Acepta fecha inyectada para tests. */
export function hoyDMY(ahora = new Date()): string {
  const d = String(ahora.getDate()).padStart(2, '0');
  const m = String(ahora.getMonth() + 1).padStart(2, '0');
  return `${d}-${m}-${ahora.getFullYear()}`;
}

function aNum(day: string): number {
  const [d, m, y] = day.split('-').map(Number);
  if (!d || !m || !y) return NaN;
  return y * 10000 + m * 100 + d;
}

/**
 * true si la verbena aún no ha pasado (hoy inclusive).
 * Sin fecha -> true para no ocultar datos por un fallo de parseo.
 */
export function esFutura(day: string, ahora = new Date()): boolean {
  if (!day) return true;
  const v = aNum(day);
  if (Number.isNaN(v)) return true;
  return v >= aNum(hoyDMY(ahora));
}
