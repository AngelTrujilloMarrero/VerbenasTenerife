// Infraestructura PDF compartida para los 31 aytos (gratis, sin APIs).
// Estrategia: pdfjs-dist en local. Si el PDF es escaneado (sin texto),
// se marca y queda para Fase 2 (Gemini Vision free-tier), no se silencia.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { fetchBytes } from './http.js';

export interface PdfTexto {
  url: string;
  texto: string;
  paginas: number;
  escaneado: boolean;
}

const cache = new Map<string, { at: number; pdf: PdfTexto }>();
const TTL = 1000 * 60 * 60; // 1h, como el resto de adaptadores
const MAX_PAGINAS = 80;

interface ItemPagina { s: string; x: number; y: number; w: number }

/** Detecta el pasillo central de una maquetación a dos columnas. Devuelve la x
 *  de corte o null si la página es a una columna. */
function corteColumnas(items: ItemPagina[], ancho: number): number | null {
  const pasos = 200;
  const ocupado = new Array(pasos + 1).fill(false);
  for (const o of items) {
    // Cabeceras a todo lo ancho cruzan el pasillo legítimamente: se ignoran.
    if (o.w > ancho * 0.35) continue;
    const a = Math.max(0, Math.floor((o.x / ancho) * pasos));
    const b = Math.min(pasos, Math.ceil(((o.x + o.w) / ancho) * pasos));
    for (let i = a; i <= b; i++) ocupado[i] = true;
  }
  let mejor: { ini: number; len: number } | null = null;
  let ini = -1;
  for (let i = Math.floor(pasos * 0.15); i <= Math.floor(pasos * 0.85); i++) {
    if (!ocupado[i]) {
      if (ini < 0) ini = i;
    } else if (ini >= 0) {
      const len = i - ini;
      if (!mejor || len > mejor.len) mejor = { ini, len };
      ini = -1;
    }
  }
  if (!mejor || mejor.len < pasos * 0.015) return null;
  const corte = ((mejor.ini + mejor.len / 2) / pasos) * ancho;
  // Un pasillo real deja contenido en ambos lados.
  const izq = items.filter((o) => o.x + o.w / 2 < corte).length;
  if (izq < 3 || items.length - izq < 3) return null;
  return corte;
}

/** Reordena los items de una página: columnas de izquierda a derecha y, dentro
 *  de cada una, de arriba a abajo. Corrige programas a dos columnas cuyo stream
 *  de PDF entremezcla días (Tacoronte: "18 Viernes" / "19 Sábado"). Si no hay
 *  pasillo claro se respeta el orden original del stream. */
function textoPorColumnas(items: ItemPagina[], ancho: number): string {
  const corte = corteColumnas(items, ancho);
  if (corte === null) return items.map((o) => o.s).join(' ');
  const izq = items.filter((o) => o.x + o.w / 2 < corte);
  const der = items.filter((o) => o.x + o.w / 2 >= corte);
  return `${leerBloque(izq)} ${leerBloque(der)}`.trim();
}

function leerBloque(items: ItemPagina[]): string {
  const filas = new Map<number, ItemPagina[]>();
  for (const o of items) {
    const k = Math.round(o.y / 4) * 4;
    if (!filas.has(k)) filas.set(k, []);
    filas.get(k)!.push(o);
  }
  return [...filas.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([, fila]) => fila.sort((a, b) => a.x - b.x).map((o) => o.s).join(' '))
    .join(' ');
}

export async function obtenerTextoPdf(url: string, maxBytes = 30 * 1024 * 1024, columnas = false): Promise<PdfTexto> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL) return hit.pdf;

  const buf = await fetchBytes(url, 120000);
  if (buf.length > maxBytes) throw new Error(`PDF demasiado grande (${buf.length} bytes): ${url}`);

  const doc = await pdfjs.getDocument({ data: buf, useSystemFonts: true }).promise;
  const n = Math.min(doc.numPages, MAX_PAGINAS);
  const partes: string[] = [];
  for (let i = 1; i <= n; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    const items: ItemPagina[] = tc.items
      .map((it: any) => ({ s: it.str, x: it.transform[4], y: it.transform[5], w: it.width || 0 }))
      .filter((o: ItemPagina) => o.s.trim());
    if (columnas) {
      const ancho = page.view?.[2] || 595;
      partes.push(textoPorColumnas(items, ancho));
    } else {
      partes.push(items.map((o) => o.s).join(' '));
    }
  }
  await doc.cleanup().catch(() => {});
  // Une palabras cortadas al final de línea ("TENE - RIFE" -> "TENERIFE").
  // Solo si la derecha empieza en minúscula ("veci- nas") o ambos lados son
  // mayúsculas ("BOM - BA"); así no toca separadores reales ("Música - Baile")
  // ni rangos ("12 - 13").
  const esMayus = (s: string): boolean => !/[a-záéíóúüñ]/.test(s);
  const sinGuiones = partes.join('\n').replace(
    /([A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+)\s+-\s+([A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+)/g,
    (m, izq: string, der: string) =>
      /^[a-záéíóúüñ]/.test(der) || (esMayus(izq) && esMayus(der)) ? izq + der : m
  );
  const texto = sinGuiones.replace(/[\s\u00A0]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  const pdf: PdfTexto = { url, texto, paginas: doc.numPages, escaneado: texto.length < 200 };
  cache.set(url, { at: Date.now(), pdf });
  return pdf;
}

/** Año del documento: el MÁXIMO 20xx (los programas recapitulan años pasados). */
export function anyoDelTexto(texto: string, fallback = String(new Date().getFullYear())): string {
  const todos = texto.match(/\b(20[2-9]\d)\b/g);
  if (!todos) return fallback;
  return todos.sort().at(-1)!;
}
