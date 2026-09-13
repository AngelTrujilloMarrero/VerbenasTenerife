// OCR automático en local de PDFs escaneados (gratis, sin servicios ni claves).
// Flujo: pdfjs-dist extrae la imagen de cada página (puro JS, sin canvas
// nativo) y tesseract.js (WASM, `spa`) la pasa a texto. Pensado para local:
// el resultado se cachea en disco (.cache/, gitignored) y el trabajo corre
// en 2º plano para no bloquear la carga: la primera visita lanza el job
// (aviso 'ocr-en-curso') y el siguiente ciclo (caché 1h del adaptador) ya
// procesa el texto. El OCR manual con Vision sigue teniendo prioridad
// (mejor calidad): esto solo cubre lo que no tiene `textoOcr()`.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PNG } from 'pngjs';
import { createWorker, OEM } from 'tesseract.js';
import { avisar } from './avisos.js';
import { fetchBytes } from './http.js';

export interface OcrAuto {
  url: string;
  at: number;
  paginas: number;
  parcial: boolean;
  texto: string;
}

const DIR = path.join(process.cwd(), '.cache', 'ocr-auto');
const TESSDATA = path.join(process.cwd(), '.cache', 'tesseract');
const MAX_PAGINAS = 40;
const MAX_BYTES = 40 * 1024 * 1024;
const MAX_IMGS = 25;
const MAX_IMG_BYTES = 15 * 1024 * 1024;
const TIMEOUT_PAGINA_MS = 90 * 1000;
const REINTENTO_FALLO_MS = 6 * 3600 * 1000;

const ficheroCache = (url: string): string =>
  createHash('sha1').update(url).digest('hex') + '.json';

/** Texto OCR ya cacheado en disco, o null (no bloquea nunca). */
export function leerOcrAuto(url: string): OcrAuto | null {
  try {
    const f = path.join(DIR, ficheroCache(url));
    if (!fs.existsSync(f)) return null;
    const o = JSON.parse(fs.readFileSync(f, 'utf8')) as OcrAuto;
    if (!o.texto || o.texto.length < 200) return null;
    return o;
  } catch {
    return null;
  }
}

const enVuelo = new Map<string, Promise<void>>();
const ultimoFallo = new Map<string, number>();

/** ¿Parece una imagen (JPEG/PNG/WEBP/GIF)? Descarta HTML de error, DOCX... */
function esImagen(buf: Uint8Array): boolean {
  if (buf.length < 16) return false;
  const jpg = buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
  const png = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
  const gif = buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46;
  const webp = buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
    && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50;
  return jpg || png || gif || webp;
}
/** Lanza el OCR de una galería web (programa solo-imagen) en 2º plano.
 *  `clave` es estable (URL de la página) para la caché en disco. */
export function lanzarOcrAutoImagenes(clave: string, imgs: string[], municipio: string, max = MAX_IMGS): void {
  if (leerOcrAuto(clave)) return;
  if (enVuelo.has(clave)) return;
  const fallo = ultimoFallo.get(clave) || 0;
  if (Date.now() - fallo < REINTENTO_FALLO_MS) return;
  const lista = [...new Set(imgs)].filter((u) => /^https?:/i.test(u)).slice(0, max);
  if (lista.length < 2) return;
  avisar(municipio, 'ocr-en-curso', clave, `OCR automático de galería en 2º plano (${lista.length} imgs)`);
  const job = procesarImagenes(clave, lista).catch((e) => {
    ultimoFallo.set(clave, Date.now());
    console.error(`ocr-auto galería fallo ${clave}`, e);
  }).finally(() => {
    enVuelo.delete(clave);
  });
  enVuelo.set(clave, job);
}

async function procesarImagenes(clave: string, lista: string[]): Promise<void> {
  const worker = await createWorker('spa', OEM.LSTM_ONLY, { cachePath: TESSDATA });
  const paginas: string[] = [];
  try {
    for (const [i, u] of lista.entries()) {
      try {
        const buf = await fetchBytes(u, 120000);
        if (!esImagen(buf) || buf.length > MAX_IMG_BYTES) continue;
        const texto = await conTimeout(reconocer(worker, Buffer.from(buf)), TIMEOUT_PAGINA_MS);
        const limpio = texto.replace(/[ \t]+\n/g, '\n').trim();
        if (limpio.length > 50) paginas.push(`[página ${i + 1}]\n${limpio}`);
      } catch (e) {
        console.warn(`ocr-auto img omitida (${u}):`, (e as Error)?.message || e);
      }
    }
  } finally {
    await worker.terminate().catch(() => {});
  }
  const texto = paginas.join('\n');
  if (texto.length < 200) throw new Error(`sin texto útil (${paginas.length}/${lista.length} imgs)`);
  fs.mkdirSync(DIR, { recursive: true });
  const o: OcrAuto = { url: clave, at: Date.now(), paginas: paginas.length, parcial: paginas.length < lista.length, texto };
  fs.writeFileSync(path.join(DIR, ficheroCache(clave)), JSON.stringify(o));
  console.log(`ocr-auto galería OK ${clave}: ${paginas.length} imgs, ${texto.length} caracteres`);
}

/** ¿Hablan dos textos del mismo programa? (evita procesar el auto si el
 *  manual versionado ya lo cubre: solape de tokens >= 80% en el corto). */
export function textoSimilar(a: string, b: string): boolean {
  const toks = (s: string): Set<string> => new Set(
    s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .split(/[^a-z0-9]+/).filter((w) => w.length > 3));
  const ta = toks(a), tb = toks(b);
  if (!ta.size || !tb.size) return false;
  const [corto, largo] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  let comunes = 0;
  for (const w of corto) if (largo.has(w)) comunes++;
  return comunes / corto.size >= 0.8;
}

/** Lanza el OCR en 2º plano (deduplicado; no bloquea la petición). */
export function lanzarOcrAuto(url: string, municipio: string, bytes?: Uint8Array): void {
  if (leerOcrAuto(url)) return;
  if (enVuelo.has(url)) return;
  const fallo = ultimoFallo.get(url) || 0;
  if (Date.now() - fallo < REINTENTO_FALLO_MS) return;
  avisar(municipio, 'ocr-en-curso', url, 'OCR automático en 2º plano (estará en el siguiente ciclo)');
  const job = procesar(url, bytes).catch((e) => {
    ultimoFallo.set(url, Date.now());
    console.error(`ocr-auto fallo ${url}`, e);
  }).finally(() => {
    enVuelo.delete(url);
  });
  enVuelo.set(url, job);
}

async function procesar(url: string, previo?: Uint8Array): Promise<void> {
  const buf = previo ?? await fetchBytes(url, 180000);
  if (buf.length > MAX_BYTES) throw new Error(`PDF demasiado grande (${buf.length} bytes)`);
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  const n = Math.min(doc.numPages, MAX_PAGINAS);
  const worker = await createWorker('spa', OEM.LSTM_ONLY, { cachePath: TESSDATA });
  const paginas: string[] = [];
  try {
    for (let i = 1; i <= n; i++) {
      try {
        const png = await paginaAPng(doc, i);
        if (!png) continue;
        const texto = await conTimeout(reconocer(worker, png), TIMEOUT_PAGINA_MS);
        const limpio = texto.replace(/[ \t]+\n/g, '\n').trim();
        if (limpio) paginas.push(limpio);
      } catch (e) {
        console.warn(`ocr-auto pág ${i}/${n} omitida (${url}):`, (e as Error)?.message || e);
      }
    }
  } finally {
    await worker.terminate().catch(() => {});
    await doc.cleanup().catch(() => {});
  }
  const texto = paginas.join('\n');
  if (texto.length < 200) throw new Error(`sin texto útil (${paginas.length}/${n} págs)`);
  fs.mkdirSync(DIR, { recursive: true });
  const o: OcrAuto = { url, at: Date.now(), paginas: paginas.length, parcial: n < doc.numPages, texto };
  fs.writeFileSync(path.join(DIR, ficheroCache(url)), JSON.stringify(o));
  console.log(`ocr-auto OK ${url}: ${paginas.length} págs, ${texto.length} caracteres`);
}

/** Imagen mayor de la página (el escaneo a página completa) a PNG. */
async function paginaAPng(doc: any, num: number): Promise<Buffer | null> {
  const page = await doc.getPage(num);
  try {
    const opList = await page.getOperatorList();
    const OPSNS = (pdfjs as any).OPS;
    let mejor: any = null;
    let nImg = 0;
    for (let i = 0; i < opList.fnArray.length; i++) {
      const name = Object.keys(OPSNS).find((k) => OPSNS[k] === opList.fnArray[i]);
      if (name !== 'paintImageXObject' && name !== 'paintInlineImageXObject') continue;
      nImg++;
      const img = await new Promise<any>((resolve) => page.objs.get(opList.argsArray[i][0], resolve));
      if (img?.data && (!mejor || img.width * img.height > mejor.width * mejor.height)) mejor = img;
    }
    if (!mejor) return null;
    return aPng(mejor.width, mejor.height, mejor.data);
  } finally {
    try { await page.cleanup(); } catch { /* pdfjs cleanup es void */ }
  }
}

function aPng(width: number, height: number, src: Uint8Array | Uint8ClampedArray): Buffer {
  const n = width * height;
  const bpp = Math.round(src.length / n); // 1 gris, 3 RGB, 4 RGBA
  const rgba = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    if (bpp === 1) {
      const g = src[i];
      rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = g;
    } else if (bpp === 3) {
      rgba[i * 4] = src[i * 3]; rgba[i * 4 + 1] = src[i * 3 + 1]; rgba[i * 4 + 2] = src[i * 3 + 2];
    } else {
      rgba[i * 4] = src[i * 4]; rgba[i * 4 + 1] = src[i * 4 + 1]; rgba[i * 4 + 2] = src[i * 4 + 2];
    }
    rgba[i * 4 + 3] = 255;
  }
  const png = new PNG({ width, height });
  png.data = rgba;
  return PNG.sync.write(png);
}

async function reconocer(worker: any, png: Buffer): Promise<string> {
  const { data } = await worker.recognize(png);
  return (data?.text || '') as string;
}

function conTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
