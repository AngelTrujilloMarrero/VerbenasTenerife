# VerbenasTenerife (piloto: 5 municipios)

Astro 7 SSR + scrapers en vivo. Sin BD todavía: cada visita lee las agendas
de los ayuntamientos (caché 1h por adaptador) y filtra verbenas con patrones.

- `pnpm dev` → http://localhost:4322/ (listado, `?municipio=arona|adeje`) y
  `/api/verbenas.json` (JSON, `?municipio=` y `?filtro=futuras|pasadas|todas`)
- La página es shell instantánea (~0.04s): pinta barra de progreso + chips por
  municipio y carga cada fuente en paralelo (lotes de 4) desde la API,
  ordenando y separando próximas/celebradas en el navegador.
- La página replica el formato de DeBelingo (fondo oscuro, cabecera azul→púrpura,
  días amarillos agrupados, tarjetas con borde lateral por tipo, leyenda,
  detalle expandible con Cómo llegar/TITSA/fuente oficial). Orden de más nueva
  a más vieja. OJO Astro: el `<style>` lleva `is:global` porque las tarjetas
  se inyectan por JS (con scope no les aplica el CSS). Sin honeypots ni
  marcas de agua: aquí el contenido es propio.
- Lógica: `src/lib/classifier.ts` (patrones + `partirPorDias` + `tipoDeEvento`),
  adaptadores `src/lib/arona.ts` / `src/lib/adeje.ts` / `src/lib/tegueste.ts`,
  agregador `src/lib/verbenas.ts`, PDFs en `src/lib/pdf.ts` (pdfjs-dist, gratis).
- Tegueste DESCUBRE programas: cada ciclo lee /fiestas/ y procesa los PDF
  "programa+fiestas" que encuentre. Un PDF nuevo en diciembre entra solo.
  PDFs escaneados se avisan y quedan para Fase 2 (IA visión).
- Filtro: título con baile/verbena/orquesta, `amenizado por`, diccionario de
  orquestas, hora 20-23h, lugar plaza/parque. Descarte: misa, teatro, expo, cuentos.
  Títulos tipo "Fiestas de X" entran como contenedores y se parten por días.
- Filtro histórico: `src/lib/data/orquestas.json` (144 orquestas con >=2
  actuaciones en 2024-25, generado con `scripts/extraer-orquestas.mjs` desde
  los archives estáticos de DeBelingo). Mencionar una suma +5. Purgados
  topónimos y genéricos ("Tenerife", "Calle", "Sergio"...) para no crear FPs.

Estado: 15 eventos (6 Arona + 1 Adeje + 4 Tegueste + 4 La Laguna del programa
del Cristo; 12 futuras + 3 pasadas). Guía de Isora: monitor activo
(EO AJAX + noticias) pero su web no publica la verbena del 12-13/09.
Siguiente paso: 5º ayuntamiento o guardar en Firebase con el modelo `Event`.
