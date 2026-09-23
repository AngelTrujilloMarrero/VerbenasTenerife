# AGENTS.md

## Commands
- Package manager: **pnpm** (`pnpm-lock.yaml`). `pnpm-workspace.yaml` solo lista `allowBuilds` (no es monorepo); no limpiar a ese fichero.
- `pnpm dev` → http://localhost:4322/ (`astro.config.mjs`; SSR, no estático).
- `pnpm build` — único check automático. **No hay tests, lint ni script de typecheck** (TS estricto solo se valida al build/`astro check` si lo lanzas a mano).
- Deploy: Vercel con adaptador `@astrojs/vercel` (`maxDuration: 60`); en local usa Node. **Tras cada push hay que REDEPLOYAR a mano en Vercel** (no hay auto-deploy por push).
- OCR de programas solo-imagen/PDF escaneado: `pnpm ocr:programa -- --municipio=<id> --url=<pagina>` (o `--pdf=`). **Solo macOS** (Vision/`swiftc`); escribe `src/lib/data/ocr-programas.json` — commitear ese JSON.

## Architecture
- Astro 7 SSR (`output: 'server'`): página shell en `src/pages/index.astro` + API en `src/pages/api/*.ts`. Cada route API lleva `export const prerender = false`.
- Scrapers = un adaptador por municipio en `src/lib/<municipio>.ts` que exporta `obtenerVerbenas<Municipio>(): Promise<Verbena[]>` + una `*_URL`. Registro único en `FUENTES` de `src/lib/verbenas.ts` — **añadir fuente = 1 entrada ahí** (agregadores y Facebook van ÚLTIMOS: ante duplicados gana la oficial).
- HTTP compartido: `src/lib/http.ts` (`fetchText` / `fetchTextConSaltos` / `textoVisible`). No usar `fetch` crudo en adaptadores (UA + timeout + TLS de `tls-ca.ts`).
- Clasificación/dedup: `src/lib/classifier.ts` (regex + diccionario de orquestas) y `src/lib/dedup.ts` (`claveDe` canónica `municipio|day|orquesta-slug`). La API volca a Firebase RTDB en 2º plano (`src/lib/db.ts`: upsert con `set`, nunca `push`; purga pasado).
- PDFs: `src/lib/pdf.ts` (pdfjs-dist + OCR auto tesseract.js en `.cache/ocr-auto/`). Texto OCR manual versionado en `src/lib/data/ocr-programas.json` (`textoOcr()` en `src/lib/ocr.ts`).

## Gotchas
- **Astro scope CSS**: `<style is:global>` es obligatorio en páginas que inyectan tarjetas por JS (sin él el CSS no aplica). Ver `index.astro` / `lectura.astro`.
- **API sin caché de navegador**: respuestas con `Cache-Control: no-store`; la caché de 1h vive en el servidor por adaptador. No añadir caché en cliente (un 0 temporal se pega 1h).
- `.env` gitignored (Firebase service account + claves IA); plantilla en `.env.example`. Sin credenciales Firebase el código **no falla**, solo no persiste.
- `src/lib/data/*.json` (`orquestas.json`, `ocr-programas.json`, `calendario-fiestas.json`) están versionados: son datos de runtime, no basura.
- Scripts `fb:*` y OCR asumen Playwright/tesseract ya instalados por pnpm (`allowBuilds`); no usar npm/yarn.

## Conventions
- Modelo de evento: `Verbena` en `src/lib/types.ts` (`day: dd-mm-yyyy`). IDs/`clave` estables entre fuentes.
- UI y comentarios en español.
- Orden de fuentes en `FUENTES` importa (dedup: gana la primera).
