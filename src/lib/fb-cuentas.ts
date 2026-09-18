// Cuentas públicas de Facebook a monitorizar (aytos, comisiones, orquestas).
// Sin login: solo páginas/posts públicos. El monitor (scripts/monitor-facebook)
// leerá 1 vez cada 2-3 días el feed de cada cuenta activa.
export type TipoCuentaFB = 'ayuntamiento' | 'comision' | 'orquesta' | 'otro';

export interface CuentaFB {
  id: string;
  nombre: string;
  url: string;
  handle: string;
  municipio: string;
  tipo: TipoCuentaFB;
  activa: boolean;
  createdAt: number;
  updatedAt: number;
  // Medición de actividad (la escribe scripts/revision-auto.mjs en cada
  // pasada; Plan C de PLANES.txt). Opcionales: las viejas siguen valiendo.
  /** ms del post más reciente visto (0 = aún sin medir). */
  ultimaActividad?: number;
  /** caliente (<7d) | templada (<30d) | fria (<1 año) | abandonada (+1 año). */
  ritmo?: 'caliente' | 'templada' | 'fria' | 'abandonada';
  /** Pasadas seguidas sin posts (muro vacío/privado). */
  fallosSeguidos?: number;
  /** Posts vistos en la última pasada (base de la escala de actividad). */
  postsVistos?: number;
}

export const RITMOS_CUENTA = ['caliente', 'templada', 'fria', 'abandonada'] as const;
export type RitmoCuentaFB = (typeof RITMOS_CUENTA)[number];

export const TIPOS_CUENTA: TipoCuentaFB[] = ['ayuntamiento', 'comision', 'orquesta', 'otro'];

/** Cuentas prioritarias: se revisan primero a mano y en auto al abrir la
 *  web; el resto va en el barrido programado. Handles en minúsculas. */
export const CUENTAS_PRIORITARIAS = ['sili.garcia', 'larutadelcherne'];

/** ¿Es prioritaria? Casa por handle exacto o por URL que lo contenga. */
export function esPrioritaria(c: { handle?: string; url?: string }): boolean {
  const h = String(c.handle || '').toLowerCase().trim();
  if (h && CUENTAS_PRIORITARIAS.includes(h)) return true;
  const u = String(c.url || '').toLowerCase();
  return CUENTAS_PRIORITARIAS.some((p) => u.includes('/' + p));
}

/** Saca el handle/slug de una URL de Facebook para mostrar y deduplicar. */
export function handleDeUrl(url: string): string {
  try {
    const u = new URL(url.trim());
    if (!/facebook\.com$/i.test(u.hostname.replace(/^www\.|^m\.|^mbasic\./, ''))) return '';
    const parts = u.pathname.split('/').filter(Boolean);
    if (!parts.length) return '';
    // /photo/?fbid=... -> usa el fbid como handle estable
    const fbid = u.searchParams.get('fbid');
    if (fbid) return `fbid:${fbid}`;
    // /aytofuencaliente, /pages/xxx/123, /profile.php?id=123
    const pid = u.searchParams.get('id');
    if (/profile\.php/i.test(u.pathname) && pid) return `id:${pid}`;
    return parts.slice(0, 2).join('/');
  } catch {
    return '';
  }
}

/** Normaliza y valida lo que llega del formulario. Lanza Error si no vale. */
export function validarCuenta(input: Record<string, unknown>): Omit<CuentaFB, 'id' | 'handle' | 'createdAt' | 'updatedAt'> {
  const nombre = String(input.nombre || '').trim().slice(0, 120);
  let url = String(input.url || '').trim().slice(0, 500);
  const municipio = String(input.municipio || '').trim().slice(0, 80);
  const tipo = String(input.tipo || 'otro').toLowerCase() as TipoCuentaFB;
  const activa = input.activa !== false && input.activa !== 'false' && input.activa !== 0;

  if (!nombre) throw new Error('Falta el nombre (ej. Ayto Los Silos)');
  if (!url) throw new Error('Falta la URL de Facebook');
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  const handle = handleDeUrl(url);
  if (!handle) throw new Error('URL de Facebook no válida (debe ser facebook.com/...)');
  if (!TIPOS_CUENTA.includes(tipo)) throw new Error('Tipo no válido');
  return { nombre, url, municipio, tipo, activa };
}

/** ID estable: slug del nombre + base36 corto (evita colisiones). */
export function generarId(nombre: string): string {
  const slug = nombre.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'cuenta';
  return `${slug}-${Date.now().toString(36)}`;
}
