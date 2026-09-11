// Texto OCR de programas publicados solo como imágenes.
// Generado por scripts/ocr-programas.mjs (Vision, macOS) y versionado para que
// funcione también en Vercel sin OCR en runtime.
import OCR from './data/ocr-programas.json';

export interface ProgramaOcr {
  generado: string;
  fuente: string;
  anyo: string;
  totalPaginas: number;
  texto: string;
}

const MAPA = OCR as Record<string, ProgramaOcr>;

/** Texto OCR cacheado de un municipio, o null si no hay programa imagen. */
export function textoOcr(municipio: string): ProgramaOcr | null {
  return MAPA[municipio.toLowerCase()] || null;
}
