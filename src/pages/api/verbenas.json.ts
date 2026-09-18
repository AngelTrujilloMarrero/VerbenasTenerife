import type { APIRoute } from 'astro';
import { claveDe } from '../../lib/dedup.js';
import { esFutura, hoyDMY } from '../../lib/fechas.js';
import { purgarAntiguas, volcarVerbenas } from '../../lib/db.js';
import { FUENTES, obtenerVerbenas } from '../../lib/verbenas.js';

export const prerender = false;

export const GET: APIRoute = async ({ url }) => {
  const municipio = url.searchParams.get('municipio') || undefined;
  // ?filtro=futuras (defecto) | pasadas | todas
  const filtro = url.searchParams.get('filtro') || 'futuras';
  try {
    const todas = await obtenerVerbenas(municipio);
    // Clave canónica por evento para que el cliente fusione por clave además
    // de por ID (los IDs viejos de la BD no coinciden con los nuevos).
    const conFlag = todas.map((v) => ({ ...v, futura: esFutura(v.day),
      clave: claveDe(v.municipio, v.day, v.titulo, v.orquestas) }));
        // Volcado a RTDB en 2º plano (upsert por ID: solo escribe lo nuevo o
    // cambiado; purga todo lo anterior a hoy: la BD es solo presente+futuro).
    // La fuente se resuelve por hostname de agenda (Drive ambiguo -> por
    // municipio; resto -> 'agregador').
    void (async () => {
      try {
        const norm = (s: string): string =>
          s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z]/g, '');
        const hostDe = (u: string): string => {
          try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; }
        };
        const hostAId = new Map<string, string>();
        for (const f of FUENTES) {
          const h = hostDe(f.agendaUrl);
          if (h && h !== 'drive.google.com') hostAId.set(h, f.id);
        }
        const fbPorHandle = FUENTES.filter((f) => f.fbHandle)
          .map((f) => ({ id: f.id, tag: '/' + (f.fbHandle as string).toLowerCase() }));
        const porFuente = new Map<string, typeof todas>();
        for (const v of todas) {
          const bajo = v.url.toLowerCase();
          const fid = fbPorHandle.find((f) => bajo.includes(f.tag))?.id
            || hostAId.get(hostDe(v.url))
            || FUENTES.find((f) => norm(f.nombre) === norm(v.municipio))?.id
            || 'agregador';
          if (!porFuente.has(fid)) porFuente.set(fid, []);
          porFuente.get(fid)!.push(v);
        }
        for (const [fid, lista] of porFuente) {
          await volcarVerbenas(lista, fid);
        }
        await purgarAntiguas(0);
      } catch (e) {
        console.error('db: volcado fondo fallo', (e as Error)?.message || e);
      }
    })();
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
