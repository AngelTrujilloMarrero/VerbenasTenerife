import type { APIRoute } from 'astro';
import { leerAvisos } from '../../lib/avisos.js';
import { FUENTES, estadoFuentes, obtenerVerbenas } from '../../lib/verbenas.js';

export const prerender = false;

/** Monitor de fuentes: eventos por adaptador + avisos (programas nuevos,
 *  PDFs escaneados pendientes de OCR, fallos). Refresca las fuentes
 *  (caché 1h por adaptador) para que los avisos estén al día. */
export const GET: APIRoute = async () => {
  try {
    const todas = await obtenerVerbenas();
    const porMunicipio: Record<string, number> = {};
    for (const v of todas) porMunicipio[v.municipio] = (porMunicipio[v.municipio] || 0) + 1;
    const avisos = leerAvisos();
    const pendientes = avisos.filter((a) =>
      a.tipo === 'programa-pdf' || a.tipo === 'pdf-escaneado' || a.tipo === 'programa-imagen');
    return new Response(JSON.stringify({
      ok: true,
      at: new Date().toISOString(),
      total: todas.length,
      porMunicipio,
      fuentes: FUENTES.map((f) => ({
        id: f.id,
        nombre: f.nombre,
        agenda: f.agendaUrl,
        // Bruto por adaptador (antes del dedup global con otras fuentes).
        ...(estadoFuentes[f.id] || { at: 0, eventos: 0, ok: false })
      })),
      avisos,
      pendientesOCR: pendientes
    }, null, 2), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: String(e?.message || e) }), { status: 500 });
  }
};
