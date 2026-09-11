# VerbenasTenerife (piloto: Arona + Adeje + Tegueste)

Astro 7 SSR + scrapers en vivo. Sin BD todavía: cada visita lee las agendas
de los ayuntamientos (caché 1h por adaptador) y filtra verbenas con patrones.

- `pnpm dev` → http://localhost:4322/ (listado, `?municipio=arona|adeje`) y
  `/api/verbenas.json` (JSON, `?municipio=` y `?filtro=futuras|pasadas|todas`)
- La página es shell instantánea (~0.04s): pinta barra de progreso + chips por
  municipio y carga cada fuente en paralelo (lotes de 4) desde la API,
  ordenando y separando próximas/celebradas en el navegador.
- La página muestra arriba las próximas (fecha >= hoy) y abajo, colapsado,
  el listado inferior de ya celebradas. `src/lib/fechas.ts` (`esFutura`).
- Lógica: `src/lib/classifier.ts` (patrones + `partirPorDias` + `tipoDeEvento`),
  adaptadores `src/lib/arona.ts` / `src/lib/adeje.ts` / `src/lib/tegueste.ts`,
  agregador `src/lib/verbenas.ts`, PDFs en `src/lib/pdf.ts` (pdfjs-dist, gratis).
- Tegueste DESCUBRE programas: cada ciclo lee /fiestas/ y procesa los PDF
  "programa+fiestas" que encuentre. Un PDF nuevo en diciembre entra solo.
  PDFs escaneados se avisan y quedan para Fase 2 (IA visión).
- Filtro: título con baile/verbena/orquesta, `amenizado por`, diccionario de
  orquestas, hora 20-23h, lugar plaza/parque. Descarte: misa, teatro, expo, cuentos.
  Títulos tipo "Fiestas de X" entran como contenedores y se parten por días.
- Añadir municipio = 1 adaptador + 1 línea en `FUENTES` (escala a 31).

Estado: 11 eventos (6 Arona + 1 Adeje + 4 Tegueste del PDF de Los Remedios;
10 futuras + Noche Boricua ya celebrada, que estrena el listado inferior).
Siguiente paso: 3er ayuntamiento o guardar en Firebase con el modelo `Event`.
