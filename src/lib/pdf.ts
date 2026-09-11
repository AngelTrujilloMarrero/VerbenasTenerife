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

export async function obtenerTextoPdf(url: string, maxBytes = 30 * 1024 * 1024): Promise<PdfTexto> {
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
    partes.push(tc.items.map((it: any) => it.str).join(' '));
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
