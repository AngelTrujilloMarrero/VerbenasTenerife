// OCR de carteles en fotos de posts de Facebook (tesseract.js `spa`, gratis).
// Solo fotos de posts pre-filtrados (huelen a verbena por texto): 1ª imagen
// si el texto ya puntúa, hasta 4 si va flojo. Reutiliza la caché de
// src/lib/ocr-auto.ts (.cache/ocr-auto/<sha1>.json) y deja `ocrTexto` en el
// JSON de cada cuenta (.cache/fb-posts/). revision-auto.mjs lo ejecuta como
// paso 2a-bis antes de clasificar.
//
// Uso: node scripts/ocr-fb.mjs [--solo=slug-cuenta] [--max-total=40] [--forzar]
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createWorker, OEM } from 'tesseract.js';

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.join('=') || true];
}));
const POSTS_DIR = path.join(ROOT, '.cache', 'fb-posts');
const OCR_DIR = path.join(ROOT, '.cache', 'ocr-auto');
const TESSDATA = path.join(ROOT, '.cache', 'tesseract');
const MAX_TOTAL = Number(args['max-total'] || 40);
const MAX_IMG_BYTES = 15 * 1024 * 1024;
const TIMEOUT_MS = 90 * 1000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const RE_VERBENA = /(gran baile|baile|verbena|verbenazo|tardeo|noche latina|noche en blanco|latinazo|baile de magos|orquesta|fiestas?|festejos|programa de (fiestas|actos)|cartel)/i;
// Probado 15-sep-2026 con el programa de Las Eras: ling transcribe el cartel
// entero; nex-n2.5-pro devolvía vacío/timeout y gemma-4 429. Se puede forzar
// otro con IA_VISION_MODEL en el .env.
const VISION_MODEL = process.env.IA_VISION_MODEL || 'inclusionai/ling-3.0-flash-vl:free';

function envLocal(k) {
  if (process.env[k]) return process.env[k].trim();
  try {
    const m = fs.readFileSync(path.join(ROOT, '.env'), 'utf8').match(new RegExp(`^${k}=(.*)$`, 'm'));
    return (m?.[1] || '').trim();
  } catch { return ''; }
}
// ¿Aporta señal útil (fecha/hora/orquesta/keyword)? Si no, el tesseract falló.
function conSenal(t) {
  return RE_VERBENA.test(t) || /\d{1,2}:\d{2}/.test(t) ||
    /enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre|lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo|20\d{2}/i.test(t);
}
// Visión por IA (OpenRouter :free con imagen): para carteles donde el
// tesseract no da señal. 1 petición por imagen; respeta --max-vision.
async function visionTranscribir(url, apiKey, modelo) {
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(120000),
    body: JSON.stringify({ model: modelo, temperature: 0.1, max_tokens: 800,
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'Transcribe TODO el texto visible de este cartel de fiestas (fechas, horas, lugares, orquestas, actos). Solo la transcripción, sin comentarios.' },
        { type: 'image_url', image_url: { url } } ] }] }) });
  if (!r.ok) throw new Error(`vision HTTP ${r.status}`);
  const j = await r.json();
  const msg = j.choices?.[0]?.message || {};
  const txt = String(msg.content || msg.reasoning || '').replace(/```/g, '').trim();
  if (txt.length < 40) throw new Error('visión sin texto útil');
  return txt;
}

const sha1 = (s) => createHash('sha1').update(s).digest('hex');
const conTimeout = (p, ms) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`timeout ${ms}ms`)), ms);
  p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); });
});
function esImagen(buf) {
  if (buf.length < 16) return false;
  return (buf[0] === 0xFF && buf[1] === 0xD8) || // jpg
    (buf[0] === 0x89 && buf[1] === 0x50) || // png
    (buf[0] === 0x52 && buf[1] === 0x49) || // webp
    (buf[0] === 0x47 && buf[1] === 0x49); // gif
}

/** Texto OCR cacheado (umbral bajo: un cartel puede ser corto). */
export function leerOcrFb(url) {
  try {
    const f = path.join(OCR_DIR, sha1(url) + '.json');
    if (!fs.existsSync(f)) return null;
    const o = JSON.parse(fs.readFileSync(f, 'utf8'));
    return o.texto && o.texto.length > 40 ? o.texto : null;
  } catch { return null; }
}
function guardarOcrFb(url, texto) {
  fs.mkdirSync(OCR_DIR, { recursive: true });
  fs.writeFileSync(path.join(OCR_DIR, sha1(url) + '.json'),
    JSON.stringify({ url, at: Date.now(), paginas: 1, parcial: false, texto }));
}

async function descargar(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://www.facebook.com/' }, signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (!esImagen(buf)) throw new Error('no es imagen');
  if (buf.length > MAX_IMG_BYTES) throw new Error(`muy grande (${buf.length})`);
  return buf;
}

export async function ocrFotosPosts({ solo = '', maxTotal = MAX_TOTAL, maxVision = Number(args['max-vision'] || 10), forzar = false } = {}) {
  const ficheros = fs.existsSync(POSTS_DIR)
    ? fs.readdirSync(POSTS_DIR).filter((x) => x.endsWith('.json') && (!solo || x.includes(solo)))
    : [];
  // Candidatas: no reels, con fotos, texto con pinta de verbena, sin OCR previo.
  const cola = [];
  for (const f of ficheros) {
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(POSTS_DIR, f), 'utf8')); } catch { continue; }
    const esReel = (p) => p.esReel === true || /\/reel\//.test(p.url || '');
    (d.posts || []).forEach((p, idx) => {
      if (esReel(p) || !(p.imagenes || []).length) return;
      if (!RE_VERBENA.test(p.texto || '')) return;
      if (p.ocrTexto && !forzar) return;
      const pendientes = (p.imagenes || []).filter((u) => forzar || !leerOcrFb(u));
      if (!pendientes.length) return;
      // 1ª imagen si el texto ya trae orquesta/hora; si no, hasta 4.
      const rica = /orquesta|grupo|\d{1,2}:\d{2}/i.test(p.texto || '');
      cola.push({ fichero: f, idx, post: p, imgs: pendientes.slice(0, rica ? 1 : 4) });
    });
  }
  const totalImgs = cola.reduce((s, c) => s + c.imgs.length, 0);
  console.log(`OCR-FB: ${cola.length} posts, ${totalImgs} imágenes (cap ${maxTotal})`);
  if (!cola.length) return { posts: 0, imagenes: 0, caracteres: 0 };
  const worker = await createWorker('spa', OEM.LSTM_ONLY, { cachePath: TESSDATA });
  const visionKey = envLocal('OPENROUTER_API_KEY');
  const visionModelo = envLocal('IA_VISION_MODEL') || VISION_MODEL;
  let visiones = 0;
  let hechas = 0, caracteres = 0, postsOk = 0;
  try {
    for (const c of cola) {
      if (hechas >= maxTotal) { console.log(`OCR-FB: cap ${maxTotal} alcanzado, resto queda pendiente`); break; }
      const textos = [];
      for (const u of c.imgs) {
        if (hechas >= maxTotal) break;
        const previo = leerOcrFb(u);
        if (previo && !forzar) { textos.push(previo); continue; }
        try {
          const buf = await descargar(u);
          const { data } = await conTimeout(worker.recognize(buf), TIMEOUT_MS);
          const limpio = String(data?.text || '').replace(/[ \t]+\n/g, '\n').trim();
          hechas++;
          if (limpio.length > 40 && conSenal(limpio)) {
            guardarOcrFb(u, limpio);
            textos.push(limpio);
            caracteres += limpio.length;
          } else {
            // Tesseract sin señal útil → visión IA (si hay clave y cupo).
            console.log(`  tesseract sin señal (${limpio.length} car.), probando visión…`);
            if (!visionKey) { console.log('  sin OPENROUTER_API_KEY: se omite visión'); continue; }
            if (visiones >= maxVision) { console.log(`  cap visión (${maxVision}) alcanzado`); continue; }
            try {
              const vt = await visionTranscribir(u, visionKey, visionModelo);
              visiones++;
              if (conSenal(vt)) {
                guardarOcrFb(u, vt);
                textos.push(vt);
                caracteres += vt.length;
                console.log(`  visión OK (${vt.length} car.)`);
              } else {
                console.log('  visión también sin señal, se descarta');
              }
            } catch (e2) {
              console.log(`  visión fallo: ${String(e2.message || e2).slice(0, 80)}`);
            }
          }
        } catch (e) {
          console.log(`  omitida ${u.slice(0, 80)}: ${String(e.message || e).slice(0, 80)}`);
        }
      }
      if (textos.length) {
        const fp = path.join(POSTS_DIR, c.fichero);
        const d = JSON.parse(fs.readFileSync(fp, 'utf8'));
        if (d.posts && d.posts[c.idx]) {
          // Slice amplio (8000): un corte a mitad de palabra ("Sabro|sa")
          // rompe la detección de orquestas en revision-auto.
          d.posts[c.idx].ocrTexto = textos.join('\n---\n').slice(0, 8000);
          d.posts[c.idx].ocrAt = new Date().toISOString();
          fs.writeFileSync(fp, JSON.stringify(d, null, 1));
          postsOk++;
        }
      }
    }
  } finally {
    await worker.terminate().catch(() => {});
  }
  console.log(`OCR-FB listo: ${postsOk} posts con texto (${caracteres} caracteres, ${hechas} tesseract, ${visiones} visión)`);
  return { posts: postsOk, imagenes: hechas, visiones, caracteres };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  ocrFotosPosts({ solo: String(args.solo || ''), maxTotal: MAX_TOTAL, maxVision: Number(args['max-vision'] || 10), forzar: !!args.forzar })
    .catch((e) => { console.error('OCR-FB FALLO:', e.message); process.exit(1); });
}
