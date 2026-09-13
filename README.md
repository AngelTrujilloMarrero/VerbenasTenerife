# VerbenasTenerife (16 ayuntamientos + lagenda.org)

Astro 7 SSR + scrapers en vivo. Sin BD todavía: cada visita lee las agendas
de los ayuntamientos (caché 1h por adaptador) y filtra verbenas con patrones.

- `pnpm dev` → http://localhost:4322/ (listado, `?municipio=arona|adeje`) y
  `/api/verbenas.json` (JSON, `?municipio=` y `?filtro=futuras|pasadas|todas`)
- La página es shell instantánea (~0.04s): pinta barra de progreso + chips por
  municipio (solo futuras, `0` si fuera de fecha) y carga cada fuente en
  paralelo (lotes de 4) desde la API, ordenando y separando próximas/celebradas
  en el navegador.
- La página replica el formato de DeBelingo (fondo oscuro, cabecera azul→púrpura,
  días amarillos agrupados, tarjetas con borde lateral por tipo, leyenda,
  detalle expandible con Cómo llegar/TITSA/fuente oficial). Orden de más nueva
  a más vieja. OJO Astro: el `<style>` lleva `is:global` porque las tarjetas
  se inyectan por JS (con scope no les aplica el CSS). Sin honeypots ni
  marcas de agua: aquí el contenido es propio.
- Lógica: `src/lib/classifier.ts` (patrones + `partirPorDias` + `tipoDeEvento`),
  adaptadores `src/lib/arona.ts` / `src/lib/adeje.ts` / `src/lib/tegueste.ts`
  / `src/lib/icodvinos.ts` / `src/lib/lossilos.ts` / `src/lib/buenavista.ts` / `src/lib/laorotava.ts` / `src/lib/losrealejos.ts` / `src/lib/guimar.ts` / `src/lib/candelaria.ts` / `src/lib/elsauzal.ts` / `src/lib/santaursula.ts` / `src/lib/lamatanza.ts` / `src/lib/lavictoria.ts`, agregadores `src/lib/lagenda.ts` / `src/lib/tenerifesevive.ts` / `src/lib/canariasfiestas.ts`, agregador `src/lib/verbenas.ts`, PDFs en `src/lib/pdf.ts` (pdfjs-dist, gratis).
- Verificación por municipio: primero ¿hay algo nuevo del año vigente? Luego
  ¿en qué formato? PDF con texto → directo; solo imágenes (La Orotava
  galería 7 PNGs, Arico 21 págs) → `programa-imagen` en `/api/estado.json` y OCR
  offline en `src/lib/data/ocr-programas.json` (`textoOcr()`); inline en la web
  → `textoConSaltos`. Futuros entran solos.
- Icod de los Vinos: WP REST `wp-json/wp/v2` + mediateca PDF año vigente (Drive portada) + inline. X muro con login.
- Los Silos: web informativa (EventON pruebas, mediateca vacía 25-26). Vigila REST + mediateca vigente; día a día en Facebook muro.
- Buenavista del Norte: `/noticias/YYYY/` scraping (REST 401). PDFs vigentes enlazados desde noticia (Remedios).
- La Orotava: Drupal 10 sin REST, agenda `/es/agenda`. Programa 2026 solo como galería PNG (OCR La Luz 05-09 y 12-09 Maquinaria Band este finde); futuros igual.
- Los Realejos: WP REST `wp-json/wp/v2` posts + mediateca PDF año vigente (Carmen, Mayo). Formato programa: día + `» 21:00 horas – Plaza X`.
- Güímar: Drupal 9 sin REST, noticias `/noticias` con fecha visible + PDFs "Descargar PDF:" año vigente (Socorro). Solo año vigente.
- Candelaria: WP REST posts cat 41 + mediateca PDF vigente (Agosto-2026). Noticias con programa inline (Nueva Línea). Fotos de programas por pueblo (año en nombre) -> `programa-imagen` si no hay OCR.
- El Sauzal: WP (REST 401), todo TEXTO web: `/actividad/slug` con ficha DÍA/HORA/LUGAR/ACTUACIONES + noticia del programa. PDFs fiestas escaneados -> aviso. Solo año vigente.
- Santa Úrsula: WP (REST 401), noticias con fecha visible + programa inline (verbena 11/oct Fórmula Latina). Eventos /evento/ son viajes. Patronales en octubre.
- La Matanza: WP Divi (REST 401), noticias /{area}/2026/{slug}/ con fecha en meta Yoast. Patronales 25 jul–6 ago en flip-book Heyzine (PDF 32 págs escaneado → OCR `lamatanza`: verbena 25/jul Swing Latino, Noche en Blanco 1/ago, verbena 6/ago Samady). Mes por día (>=20 jul, si no ago); "noche en blanco" clasifica como verbena.
- La Victoria: WP REST abierta (slugs planos sin año: vigencia por `date`), cat Fiestas 52 + web fiestas.lavictoriadeacentejo.es/programa/ ("19 Miércoles", alias Explanada→Recinto). PDF mediateca (AAFF-Programa con texto) solo si la web no da eventos (sin cabeceras de día). Fiestas de Agosto 21 ago–2 sep (Gran Verbena 2 sep 23:00).
- TenerifeSeVive (blog WP.com): tabla viva Fecha|Localidad|Tipo|Orquestas vía REST pública (39 filas sep-nov 2026). Cubre barrios sin fuente oficial (Abrigos, Fañabé, Vilaflor...). Agregador último, fusiona con oficial.
- CanariasFiestas (blog programas): archivo mensual /YYYY/MM/ filtrado a Tenerife por municipio en titular (dos primeras partes; Pájara/Gáldar/Costa Norte vetados). Programas inline día+hora. Agregador último.
- Tegueste DESCUBRE programas: cada ciclo lee /fiestas/ y procesa los PDF
  "programa+fiestas" que encuentre. Un PDF nuevo en diciembre entra solo.
  PDFs escaneados se avisan y quedan para Fase 2 (IA visión).
- Programas publicados SOLO como imágenes (p. ej. Arico): OCR offline con
  Vision de macOS y caché versionada. `node scripts/ocr-programas.mjs
  --municipio=arico --url=<pagina>` descarga las páginas, las OCR-ea y escribe
  `src/lib/data/ocr-programas.json`; el adaptador lo lee con `textoOcr()`
  (portable a Vercel, sin OCR en runtime). Requiere macOS con `swiftc`.
- OCR automático en local (`src/lib/ocr-auto.ts`, tesseract.js `spa`, sin
  claves): centralizado en `pdf.ts` para TODOS los municipios. Cuando un PDF
  es escaneado y no hay `textoOcr()` versionado, devuelve el texto cacheado
  en `.cache/ocr-auto/` o lanza el OCR en 2º plano (aviso `ocr-en-curso`;
  entra en el siguiente ciclo). Piloto y compuerta anti-fechas-basura en
  La Matanza (secciones con día imposible o día-semana incoherente se
  descartan).
- Filtro: título con baile/verbena/orquesta, `amenizado por`, diccionario de
  orquestas, hora 20-23h, lugar plaza/parque. Descarte: misa, teatro, expo, cuentos.
  Títulos tipo "Fiestas de X" entran como contenedores y se parten por días.
- Filtro histórico: `src/lib/data/orquestas.json` (144 orquestas con >=2
  actuaciones en 2024-25, generado con `scripts/extraer-orquestas.mjs` desde
  los archives estáticos de DeBelingo). Mencionar una suma +5. Purgados
  topónimos y genéricos ("Tenerife", "Calle", "Sergio"...) para no crear FPs.

Estado: ~52 eventos en 13 municipios (Icod 5, La Orotava 12-09 Maquinaria Band este finde, etc.; ~30 futuras). Santa Cruz: días flexibles, bailes sin hora con hora previa, penalty religioso solo sin mención explícita, dedup general con fusión. Chips y `pie-total` ya cuentan solo futuras.
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
