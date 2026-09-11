import type { APIRoute } from 'astro';
import { esFutura, hoyDMY } from '../../lib/fechas.js';
import { FUENTES, obtenerVerbenas } from '../../lib/verbenas.js';

export const prerender = false;

export const GET: APIRoute = async ({ url }) => {
  const municipio = url.searchParams.get('municipio') || undefined;
  // ?filtro=futuras (defecto) | pasadas | todas
  const filtro = url.searchParams.get('filtro') || 'futuras';
  try {
    const todas = await obtenerVerbenas(municipio);
    const conFlag = todas.map((v) => ({ ...v, futura: esFutura(v.day) }));
    const verbenas = filtro === 'todas'
      ? conFlag
      : conFlag.filter((v) => (filtro === 'pasadas' ? !v.futura : v.futura));
    return new Response(JSON.stringify({
      ok: true,
      hoy: hoyDMY(),
      total: verbenas.length,
      fuentes: FUENTES.map((f) => ({ id: f.id, nombre: f.nombre, agenda: f.agendaUrl })),
      filtroMunicipio: municipio || null,
      filtroFecha: filtro,
      verbenas
      // Sin caché de navegador (no-store): la caché de 1h ya vive en el
      // servidor por adaptador; si el navegador cacheara, un 0 temporal
      // se quedaría pegado una hora.
    }, null, 2), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: String(e?.message || e) }), { status: 500 });
  }
};
