// Infraestructura PDF compartida para los 31 aytos (gratis, sin APIs).
// Estrategia: pdfjs-dist en local. Si el PDF es escaneado (sin texto),
// se marca y queda para Fase 2 (Gemini Vision free-tier), no se silencia.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

export interface PdfTexto {
  url: string;
  texto: string;
  paginas: number;
  escaneado: boolean;
}

const cache = new Map<string, { at: number; pdf: PdfTexto }>();
const TTL = 1000 * 60 * 60; // 1h, como el resto de adaptadores
const MAX_BYTES = 30 * 1024 * 1024;
const MAX_PAGINAS = 60;

export async function obtenerTextoPdf(url: string): Promise<PdfTexto> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL) return hit.pdf;

  const r = await fetch(url, {
    headers: { 'User-Agent': 'VerbenasTenerife/0.1 (piloto; contacto admin)' }
  });
  if (!r.ok) throw new Error(`PDF HTTP ${r.status} en ${url}`);
  const buf = new Uint8Array(await r.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error(`PDF demasiado grande (${buf.length} bytes): ${url}`);

  const doc = await pdfjs.getDocument({ data: buf, useSystemFonts: true }).promise;
  const n = Math.min(doc.numPages, MAX_PAGINAS);
  const partes: string[] = [];
  for (let i = 1; i <= n; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    partes.push(tc.items.map((it: any) => it.str).join(' '));
  }
  await doc.cleanup().catch(() => {});
  const texto = partes.join('\n').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  const pdf: PdfTexto = { url, texto, paginas: doc.numPages, escaneado: texto.length < 200 };
  cache.set(url, { at: Date.now(), pdf });
  return pdf;
}

/** Año del documento (programas "Fiestas 2026"). Ignora años viejos tipo BIC 2007. */
export function anyoDelTexto(texto: string, fallback = String(new Date().getFullYear())): string {
  const m = texto.match(/\b(20[2-9]\d)\b/);
  return m ? m[1] : fallback;
}
