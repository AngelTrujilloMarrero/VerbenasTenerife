// OCR de programas publicados SOLO como imágenes (macOS Vision, gratis y offline).
// Descarga las páginas, las OCR-ea y deja el texto en src/lib/data/ocr-programas.json
// para que los adaptadores lo lean sin OCR en runtime (portable a Vercel).
//
// Uso:
//   node scripts/ocr-programas.mjs --municipio=arico \
//     --url=https://www.ayuntamientodearico.com/programa-fiestas-lustrales-virgen-de-abona-2026/ \
//     [--patron="programa|page-\\d"] [--max=40] [--forzar]
//
// Requiere macOS con Xcode CLT (swiftc). Usa `curl` para descargar (evita el
// problema de cadenas TLS incompletas de algunos ayuntamientos).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import * as cheerio from 'cheerio';

const root = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k, v.join('=') || true];
  })
);

const municipio = String(args.municipio || '').toLowerCase();
const pagina = args.url;
if (!municipio || !pagina) {
  console.error('uso: node scripts/ocr-programas.mjs --municipio=<id> --url=<pagina> [--patron=regex] [--max=40] [--forzar]');
  process.exit(2);
}
if (process.platform !== 'darwin') {
  console.error('OCR Vision solo está disponible en macOS. Ejecútalo en local y commitea el JSON generado.');
  process.exit(3);
}

const PATRON = String(args.patron || 'programa|page[-_]?\\d|p[aá]gina|pag[-_]?\\d|cartel');
const MAX = Number(args.max || 40);
const OUT = args.salida
  ? path.resolve(String(args.salida))
  : path.join(root, '..', 'src', 'lib', 'data', 'ocr-programas.json');
const CACHE = path.join(root, '..', '.cache', 'ocr', municipio);
const BIN = path.join(root, '..', '.cache', 'ocr-vision');

const curl = (url, out) =>
  execFileSync('curl', ['-sL', '--max-time', '120', '-A', 'Mozilla/5.0', url, '-o', out],
    { stdio: ['ignore', 'ignore', 'inherit'] });
const curlTexto = (url) =>
  execFileSync('curl', ['-sL', '--max-time', '60', '-A', 'Mozilla/5.0', url],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

function compilaVision() {
  if (fs.existsSync(BIN)) return;
  fs.mkdirSync(path.dirname(BIN), { recursive: true });
  console.log('compilando helper Vision…');
  execFileSync('swiftc', ['-O', path.join(root, 'ocr-vision.swift'), '-o', BIN], { stdio: 'inherit' });
}

function anyoDe(html, url) {
  return (url.match(/(20\d{2})/) || html.match(/Fecha de publicaci[oó]n[\s\S]{0,400}?(20\d{2})/) ||
    [null, String(new Date().getFullYear())])[1];
}

console.log(`descargando ${pagina}`);
const html = curlTexto(pagina);
const $ = cheerio.load(html);
const patron = new RegExp(PATRON, 'i');
const urls = [];
$('img').each((_, el) => {
  const src = $(el).attr('src') || $(el).attr('data-src') || '';
  if (!/^https?:/i.test(src)) return;
  if (!patron.test(src)) return;
  // fuera miniaturas de WordPress (-212x300.jpg)
  if (/-\d{2,4}x\d{2,4}\.(jpg|jpeg|png|webp)$/i.test(src)) return;
  if (!urls.includes(src)) urls.push(src);
});

const numPagina = (u) => {
  const m = u.match(/(?:page|pag|p)[-_]?(\d{2,4})(?=[^\d]|$)/i) || u.match(/(\d{2,4})(?=\.[a-z]+$)/i);
  return m ? parseInt(m[1], 10) : 0;
};
urls.sort((a, b) => numPagina(a) - numPagina(b));
if (!urls.length) {
  console.error(`no encontré imágenes con patrón /${PATRON}/ en ${pagina}`);
  process.exit(4);
}
console.log(`páginas detectadas: ${urls.length}`);

fs.mkdirSync(CACHE, { recursive: true });
const ficheros = urls.slice(0, MAX).map((u, i) => {
  const ext = (u.match(/\.(jpg|jpeg|png|webp)(?:\?|$)/i) || [null, 'jpg'])[1].toLowerCase();
  const f = path.join(CACHE, `p${String(i + 1).padStart(3, '0')}.${ext}`);
  if (args.forzar || !fs.existsSync(f)) {
    process.stdout.write(`  ↓ ${path.basename(u)}\n`);
    curl(u, f);
  }
  return f;
});

compilaVision();
console.log('OCR…');
const crudo = execFileSync(BIN, ficheros, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const paginas = crudo.split('\f').map((p) => p.replace(/[ \t]+\n/g, '\n').trim()).filter(Boolean);

let data = {};
if (fs.existsSync(OUT)) {
  try { data = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch { data = {}; }
}
data[municipio] = {
  generado: new Date().toISOString().slice(0, 10),
  fuente: pagina,
  anyo: anyoDe(html, pagina),
  totalPaginas: paginas.length,
  paginas,
  texto: paginas.join('\n')
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(data, null, 1) + '\n');
console.log(`OK ${municipio}: ${paginas.length} páginas OCR -> ${OUT}`);
