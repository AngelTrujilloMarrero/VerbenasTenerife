# VerbenasTenerife (piloto: 5 ayuntamientos + lagenda.org)

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
  adaptadores `src/lib/arona.ts` / `src/lib/adeje.ts` / `src/lib/tegueste.ts`
  / `src/lib/icodvinos.ts` / `src/lib/lossilos.ts` / `src/lib/buenavista.ts` / `src/lib/laorotava.ts`, agregador `src/lib/verbenas.ts`, PDFs en `src/lib/pdf.ts` (pdfjs-dist, gratis).
- Icod de los Vinos usa la API REST de su WordPress (`wp-json/wp/v2`: búsqueda
  server-side + `content.rendered` + mediateca con los programas en PDF del
  año vigente). Su X (@Icod_Vinos) es muro con login y sin API pública: no
  integrable sin claves; la web publica lo mismo.
- Los Silos: web informativa sin agenda estructurada (EventON con datos de
  prueba; mediateca vacía 2025-26). El adaptador vigila REST + mediateca del
  año vigente: en cuanto cuelguen fiestadelaluz2026.pdf entra solo. El día a
  día real va por Facebook (muro con login, sin API pública).
- Buenavista del Norte: noticias en `/noticias/YYYY/` (REST bloqueado, 401).
  Descubre por scraping de `/noticias/` y buscador; programas en PDF del año
  vigente enlazados desde la noticia (Remedios). Futuros entran solos.
- La Orotava: Drupal 10 sin REST (404), agenda en `/es/agenda` con teaser
  fecha+título y detalle "Cuándo". Solo año vigente; programa futuro entra
  solo. Noticias en `/es/noticias`.
- Tegueste DESCUBRE programas: cada ciclo lee /fiestas/ y procesa los PDF
  "programa+fiestas" que encuentre. Un PDF nuevo en diciembre entra solo.
  PDFs escaneados se avisan y quedan para Fase 2 (IA visión).
- Programas publicados SOLO como imágenes (p. ej. Arico): OCR offline con
  Vision de macOS y caché versionada. `node scripts/ocr-programas.mjs
  --municipio=arico --url=<pagina>` descarga las páginas, las OCR-ea y escribe
  `src/lib/data/ocr-programas.json`; el adaptador lo lee con `textoOcr()`
  (portable a Vercel, sin OCR en runtime). Requiere macOS con `swiftc`.
- Filtro: título con baile/verbena/orquesta, `amenizado por`, diccionario de
  orquestas, hora 20-23h, lugar plaza/parque. Descarte: misa, teatro, expo, cuentos.
  Títulos tipo "Fiestas de X" entran como contenedores y se parten por días.
- Filtro histórico: `src/lib/data/orquestas.json` (144 orquestas con >=2
  actuaciones en 2024-25, generado con `scripts/extraer-orquestas.mjs` desde
  los archives estáticos de DeBelingo). Mencionar una suma +5. Purgados
  topónimos y genéricos ("Tenerife", "Calle", "Sergio"...) para no crear FPs.

Estado: 48 eventos en 10 municipios (Santa Cruz 13 del blog + programas
fijos; 28 futuras). Santa Cruz: días flexibles, bailes sin hora con hora
previa, penalty religioso solo sin mención explícita, dedup general con fusión.
- Exportar agenda: botón 📥 genera PNG de la semana (ayer→domingo) con
  html2canvas vía importmap CDN (`esm.sh`, sin bundlear) + modal
  Compartir/Descargar (adaptado de DeBelingo, sin Firebase).
- Deploy Vercel: adaptador `@astrojs/vercel` con `maxDuration: 60` (en local
  sigue Node). Tras cada push hay que REDEPLOYAR en Vercel.
Siguiente paso: 7º ayuntamiento o guardar en Firebase con el modelo `Event`.
- lagenda.org (`src/lib/lagenda.ts`): índice planfinde + programas con días y
  horas ("23:00 - Gran Baile..."). Respeto a robots (pausa entre detalles),
  prioriza fechas próximas, resuelve municipio (`municipios.ts`) y deduplica.
Siguiente paso: 6º ayuntamiento o guardar en Firebase con el modelo `Event`.
