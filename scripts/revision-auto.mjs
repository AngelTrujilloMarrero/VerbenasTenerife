// Revisión automática al encender el Mac: extrae últimos posts de las cuentas,
// detecta posibles verbenas, lo guarda en Firebase y deja un listado.
// Uso manual: node scripts/revision-auto.mjs [--forzar] [--sin-extraer]
//   --forzar: ignora el guardado de 20h (si ya se revisó hoy, no repite)
//   --sin-extraer: no abre el navegador, solo clasifica lo ya descargado
//   --nivel=auto|todo|caliente|templada|fria: alcance (se reenvía al monitor)
//   --posts=N (1-10): posts por cuenta (se reenvía al monitor)
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verificarConIA } from './ia-clasificar.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.join('=') || true];
}));
const POSTS_DIR = path.join(ROOT, '.cache', 'fb-posts');
const STAMP = path.join(ROOT, '.cache', 'fb-ultima-revision');
const MIN_HORAS = 20;

// ---------- 0. Guardas ----------
if (!args.forzar && !args['sin-extraer'] && fs.existsSync(STAMP)) {
  const haceH = (Date.now() - Number(fs.readFileSync(STAMP, 'utf8') || 0)) / 36e5;
  if (haceH < MIN_HORAS) {
    console.log(`Revisado hace ${haceH.toFixed(1)}h (<${MIN_HORAS}h). Nada que hacer. Usa --forzar para repetir.`);
    process.exit(0);
  }
}
try {
  const otros = execSync('pgrep -f "monitor-facebook-browser" || true', { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  if (otros.length > 0 && !args['sin-extraer']) {
    console.log('Ya hay una extracción en marcha (pid ' + otros.join(',') + '). Salgo.');
    process.exit(3);
  }
} catch { /* sin pgrep: se sigue */ }

// El LaunchAgent no tiene PATH con homebrew: 'node' pelado muere con
// ENOENT (status null). Se usa el mismo binario que ejecuta este script.
const NODE = process.execPath;

// DB primero: el progreso temprano (y la web /lectura) la necesitan antes
// de la fase de clasificación.
const DB = 'https://verbenastenerife-default-rtdb.europe-west1.firebasedatabase.app';

// Progreso visible en la web (/api/fb-progreso → /lectura): fichero local +
// espejo en Firebase (en Vercel no hay .cache). Best-effort, nunca bloquea.
const PROGRESO = path.join(ROOT, '.cache', 'fb-progreso.json');
function leerProgreso() {
  try { return JSON.parse(fs.readFileSync(PROGRESO, 'utf8')); } catch { return {}; }
}
async function marcarProgreso(parche) {
  const doc = { ...leerProgreso(), ...parche, actualizadoEl: new Date().toISOString() };
  try {
    fs.mkdirSync(path.dirname(PROGRESO), { recursive: true });
    // Atómico (tmp+rename): la API lo lee en caliente.
    fs.writeFileSync(PROGRESO + '.tmp', JSON.stringify(doc, null, 2));
    fs.renameSync(PROGRESO + '.tmp', PROGRESO);
  } catch { /* disco lleno: se sigue */ }
  try {
    await fetch(`${DB}/meta/fb_progreso.json`, { method: 'PUT', body: JSON.stringify(doc) });
  } catch { /* sin red: el fichero local vale */ }
}

// ---------- 1. Extracción ----------
if (!args['sin-extraer']) {
  const nivelR = String(args.nivel || 'auto').toLowerCase();
  const postsR = Math.max(1, Math.min(Number(args.posts || 3), 10));
  console.log(`1/3 Extrayendo últimos posts de las cuentas (nivel=${nivelR}, posts=${postsR})…`);
  await marcarProgreso({ estado: 'en-curso', fase: 'extrayendo', inicio: Date.now(),
    cuentasHechas: 0, cuentasTotal: 0, cuentaActual: '' });
  const r = spawnSync(NODE, ['scripts/monitor-facebook-browser.mjs', '--todas',
    `--nivel=${nivelR}`, `--posts=${postsR}`],
    { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) console.warn('Extracción acabó con código', r.status, `(signal ${r.signal || '-'}, error ${r.error?.message || '-'})`, '(se clasifica lo que haya)');
  await marcarProgreso({ fase: 'ocr' });
} else {
  console.log('1/3 Extracción omitida (--sin-extraer).');
  await marcarProgreso({ estado: 'en-curso', fase: 'clasificando', inicio: Date.now() });
}

// ---------- 2a-bis. OCR de carteles (fotos de posts pre-filtrados) ----------
if (!args['sin-extraer'] || args['con-ocr']) {
  console.log('2a-bis/3 OCR de carteles…');
  const r = spawnSync(NODE, ['scripts/ocr-fb.mjs'], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) console.warn('OCR-FB acabó con código', r.status, `(signal ${r.signal || '-'}, error ${r.error?.message || '-'})`, '(se clasifica sin carteles)');
  await marcarProgreso({ fase: 'clasificando' });
}

// ---------- 2. Clasificación ----------
console.log('2/3 Clasificando…');
const ORQ = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'lib', 'data', 'orquestas.json'), 'utf8')).orquestas || [];
const norm = (s) => ' ' + String(s || '').toLowerCase().replace(/[.,;:()"“”‘’¡!¿?]/g, ' ').replace(/\s+/g, ' ') + ' ';
const RE_VERBENA = /(gran baile|baile|verbena|verbenazo|tardeo|noche latina|noche en blanco|latinazo|baile de magos|orquesta)/i;
// Keywords de fiesta (contenedor de verbenas): programa, cartel, próxima...
const RE_FIESTA = /(fiestas?( patronales)?|festejos|proxim[ao]s?\s+(verbena|baile|eventos?|actos)|programa de (fiestas|actos)|cartel de fiestas|fiestas en honor)/i;
const RE_ANTI = /infantil|familiar|beb[ée]cuento|hinchables?|tercera edad|tercera juventud|\bmayores\b|misa|procesi[óo]n|rosario/i;
const RE_HORA = /(19|2[0-3]):\d{2}/;
// Fase 3: señales de ciclo de vida en posts de orquestas/cuentas.
const RE_CANCEL = /cancel|suspen|aplaz|no se celebrar|no podremos estar|comunica(do|mos).*susp/i;
const RE_RETOMAR = /retom|se mantiene|finalmente s[ií]|nueva fecha|aplazado al/i;
// DB definida arriba (la usa también el progreso temprano).
const alnum = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');

function orquestaEn(texto) {
  const hay = norm(texto);
  for (const { nombre, n } of ORQ) {
    const low = nombre.toLowerCase();
    if (low.includes(' ') ? hay.includes(low) : hay.includes(' ' + low + ' ')) return `${nombre} (${n})`;
  }
  return null;
}
function antiguedadDias(fecha, revisadoEl) {
  const f = String(fecha || '');
  let m = f.match(/(\d+)\s*min|(\d+)\s*h\b/i);
  if (m || /hoy/i.test(f)) return 0;
  if (/ayer/i.test(f)) return 1;
  m = f.match(/(\d+)\s*d\b/i); if (m) return Number(m[1]);
  m = f.match(/(\d+)\s*sem/i); if (m) return Number(m[1]) * 7;
  m = f.match(/(\d{1,2})\s*de\s*([a-záéíóúñ]+)/i);
  if (m) {
    const meses = { ene: 0, feb: 1, mar: 2, abr: 3, may: 4, jun: 5, jul: 6, ago: 7, sep: 8, oct: 9, nov: 10, dic: 11 };
    const mi = meses[m[2].slice(0, 3).toLowerCase()];
    if (mi !== undefined) {
      const rev = new Date(revisadoEl);
      let d = new Date(rev.getFullYear(), mi, Number(m[1]));
      if (d > rev) d = new Date(rev.getFullYear() - 1, mi, Number(m[1]));
      return Math.round((rev - d) / 864e5);
    }
  }
  return 999;
}

function hashTxt(s) {
  let h = 5381;
  const t = String(s || '');
  for (let i = 0; i < t.length; i++) h = (Math.imul(h, 33) ^ t.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function idPost(cuenta, p) {
  const m = String(p.url || '').match(/(?:fbid=|story_fbid=)(\d+)|reel\/(\d+)|\/posts\/(\d+)|(pfbid[\w]+)/);
  if (m) return 'fb-' + (m[1] || m[2] || m[3] || m[4]).slice(0, 40).replace(/[^a-z0-9]/gi, '');
  // Hash estable de url+texto (el base64 del prefijo colisionaba: todas las
  // URLs comparten https://www.facebook.com/).
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  const s = `${cuenta}|${p.url || ''}|${(p.texto || '').slice(0, 80)}`;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 'fb-' + (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

const candidatas = [];
const pre = []; // pre-filtro regex (>=2) pendiente de verificación IA

// Fecha del EVENTO mencionado en el texto, relativa al día del post
// (revisadoEl - dias). Devuelve Date o null si no hay pista. Si el evento ya
// pasó (ej. post de hace 4 días diciendo "esta noche"), se excluye: es pasado.
const SEM_LUN = { lunes: 0, martes: 1, miercoles: 2, jueves: 3, viernes: 4, sabado: 5, domingo: 6 };
const MESES_IDX = { ene: 0, feb: 1, mar: 2, abr: 3, may: 4, jun: 5, jul: 6, ago: 7, sep: 8, oct: 9, nov: 10, dic: 11 };
const normD = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
function fechaEvento(postISO, diasPost, texto) {
  const t = normD(texto);
  const post = new Date(postISO);
  post.setHours(12, 0, 0, 0);
  post.setDate(post.getDate() - (diasPost || 0));
  const mas = (n) => { const d = new Date(post); d.setDate(d.getDate() + n); return d; };
  const dowMon = (post.getDay() + 6) % 7; // lunes=0
  if (/\b(hoy|esta noche|esta tarde|esta manana)\b/.test(t)) return post;
  if (/\bpasado manana\b/.test(t)) return mas(2);
  if (/\bmanana\b/.test(t)) return mas(1);
  if (/\beste\s+(fin de semana|finde)\b/.test(t)) return mas(5 - dowMon); // sábado de su semana
  let   m = t.match(/\beste\s+(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/);
  if (m) return mas(SEM_LUN[m[1]] - dowMon); // misma semana (si ya pasó, sale pasado)
  // "el <día>" = próximo venidero… salvo "hasta el <día>" (fecha FIN de un
  // rango del cartel: "Ventorrillos hasta el miércoles 23" no es este miércoles).
  m = t.match(/(?<!hasta )\bel\s+(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/);
  if (m) return mas(((SEM_LUN[m[1]] - dowMon + 7) % 7) || 7); // próximo venidero
  m = t.match(/(\d{1,2})\s*de\s*(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)/);
  if (m) {
    const d = new Date(post.getFullYear(), MESES_IDX[m[2].slice(0, 3)], Number(m[1]), 12);
    if (d.getTime() > mas(180).getTime()) d.setFullYear(d.getFullYear() - 1); // "10 de enero" en septiembre = pasado
    return d;
  }
  return null;
}
const dmyDe = (d) => `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
const hoy0 = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const senales = []; // {tipo: 'cancelacion'|'retomar', orquesta, cuenta, url, texto, fecha}
let totalPosts = 0, cuentas = 0, reelsOmitidos = 0, eventosPasados = 0;
// Reel aunque venga sin marcar de extracciones viejas (url /reel/ o duración).
const esReel = (p) => p.esReel === true || /\/reel\//.test(p.url || '') || /\d+:\d+\s*\/\s*\d+:\d+/.test(p.texto || '');
// Clave Gemini del .env local (aistudio.google.com). Sin ella, todo regex.
function envLocal(k) {
  if (process.env[k]) return process.env[k].trim();
  try {
    const m = fs.readFileSync(path.join(ROOT, '.env'), 'utf8').match(new RegExp(`^${k}=(.*)$`, 'm'));
    return (m?.[1] || '').trim();
  } catch { return ''; }
}
if (fs.existsSync(POSTS_DIR)) {
  for (const f of fs.readdirSync(POSTS_DIR).filter((x) => x.endsWith('.json'))) {
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(POSTS_DIR, f), 'utf8')); } catch { continue; }
    cuentas++;
    for (const p of d.posts || []) {
      totalPosts++;
      // Reels no se verifican: solo imagen, texto y PDF.
      if (esReel(p)) { reelsOmitidos++; continue; }
      // Texto + transcripción del cartel (si el paso 2a-bis la generó).
      // Puerta de calidad: los carteles decorativos salen del tesseract como
      // basura; el OCR solo entra si aporta alguna señal (keyword, hora,
      // orquesta o mes). Si no, se guarda pero se ignora.
      let ocrValido = '';
      if (p.ocrTexto) {
        const t = p.ocrTexto;
        const vale = RE_VERBENA.test(t) || RE_FIESTA.test(t) || RE_HORA.test(t) ||
          /enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre|lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo|20\d{2}/i.test(t) ||
          !!orquestaEn(t);
        if (vale) ocrValido = t;
      }
      const textoFull = p.texto + (ocrValido ? '\n[CARTEL] ' + ocrValido : '');
      const conCartel = !!ocrValido;
      let score = 0;
      const motivos = [];
      const pm = textoFull.match(RE_VERBENA);
      if (pm) { score += 3; motivos.push('keyword: ' + pm[1]); }
      const fi = textoFull.match(RE_FIESTA);
      if (fi) { score += 2; motivos.push('fiesta: ' + fi[1].slice(0, 40)); }
      const ho = orquestaEn(textoFull);
      if (ho) { score += 5; motivos.push('orquesta 2024-25: ' + ho + (conCartel && !(p.texto || '').includes(ho.split(' (')[0]) ? ' (cartel)' : '')); }
      if (RE_HORA.test(textoFull)) { score += 1; motivos.push('hora 19-23h'); }
      if (/plaza|parque|recinto/i.test(textoFull)) { score += 1; motivos.push('lugar verbena'); }
      if (RE_ANTI.test(textoFull)) { score -= 4; motivos.push('penalización no-verbena'); }
      // Un cartel transcrito con fechas y horas ES un programa de actos:
      // vale por sí solo aunque el texto del post sea pobre ("ya disponible").
      if (conCartel && /\d{1,2}:\d{2}/.test(textoFull) &&
          /enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre/i.test(textoFull)) {
        score += 3; motivos.push('cartel: programa con fechas y horas');
      }
      const dias = antiguedadDias(p.fecha, d.revisadoEl);
      // Fecha del evento: si el texto la delata y ya pasó, fuera (post de hace
      // 4 días diciendo "esta noche" = evento de hace 4 días).
      const fEv = fechaEvento(d.revisadoEl, dias, textoFull);
      if (fEv && fEv < hoy0()) { eventosPasados++; continue; }
      // Señales de ciclo de vida: solo posts frescos (<=10 días) con orquesta.
      if (dias <= 10) {
        const hoNombre = (ho || '').split(' (')[0];
        if (hoNombre && RE_CANCEL.test(textoFull)) {
          senales.push({ tipo: 'cancelacion', orquesta: hoNombre, cuenta: d.cuenta, url: p.url || '', texto: textoFull.slice(0, 300), fecha: p.fecha || '' });
        } else if (hoNombre && RE_RETOMAR.test(textoFull)) {
          senales.push({ tipo: 'retomar', orquesta: hoNombre, cuenta: d.cuenta, url: p.url || '', texto: textoFull.slice(0, 300), fecha: p.fecha || '' });
        }
      }
      // Pre-filtro barato: a la IA solo lo que huele a verbena (>=2).
      if (score >= 2) {
        pre.push({ indice: pre.length, id: idPost(d.cuenta, p),
          hash: hashTxt(p.texto + (conCartel ? '#ocr' : '')),
          cuenta: d.cuenta, url: p.url || '', fecha: p.fecha || '',
          dias, fEv: fEv ? dmyDe(fEv) : '', texto: textoFull.slice(0, 800),
          fotos: (p.imagenes || []).slice(0, 4), pdfs: p.pdfs || [],
          ho, score, motivos, revisadoEl: d.revisadoEl, cartel: conCartel });
      }
    }
  }
}

// ---------- 2a. Verificación IA (opcional; sin clave, manda la regex) ----------
const GEMINI_KEY = args['sin-ia'] ? '' : envLocal('GEMINI_API_KEY');
const GEMINI_MODEL = envLocal('GEMINI_MODEL') || 'gemini-2.5-flash';
const GROQ_KEY = args['sin-ia'] ? '' : envLocal('GROQ_API_KEY');
const OPENROUTER_KEY = args['sin-ia'] ? '' : envLocal('OPENROUTER_API_KEY');
const SOLO_REGEX = args['sin-ia'] || args['solo-regex'] ? true : false;
let veredictos = new Map();
let iaCacheHits = 0;
const vistosIA = new Set();
{
  const hoyDmy = (() => { const d = new Date(); return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`; })();
  // Caché de veredictos en la nube: un post ya juzgado (mismo hash de texto)
  // no se vuelve a preguntar; solo los nuevos o editados van a la IA.
  // Así la página no dispara IAs: lee veredictos guardados, y una nueva
  // valoración solo ocurre al revisar cuentas (post nuevo) o si la web del
  // ayuntamiento cambió el evento (vía cruce 2c, sin IA).
  const cacheIA = new Map();
  try {
    const prev = await (await fetch(`${DB}/fb_candidatos.json`)).json() || {};
    for (const c of Object.values(prev)) {
      if (c.id && c.textoHash && c.ia) cacheIA.set(c.id + '|' + c.textoHash, c.ia);
    }
  } catch { /* sin caché: todo a la IA */ }
  const pendientes = [];
  // Los carteles transcritos primero: son la señal más rica y el cap de la
  // IA (120) no debe dejarlos fuera.
  const ordenPre = [...pre].sort((a, b) =>
    ((b.cartel ? 1 : 0) - (a.cartel ? 1 : 0)) || (b.score - a.score));
  for (const e of ordenPre) {
    const hit = cacheIA.get(e.id + '|' + e.hash);
    if (hit) { veredictos.set(e.indice, { ...hit, deCache: true }); iaCacheHits++; e.cacheHit = true; }
    else pendientes.push(e);
  }
  // Reasigna índices de los pendientes para la IA (el mapa usa e.indice).
  pendientes.forEach((e, k) => { e.iaIdx = k; });
  if (!SOLO_REGEX && pendientes.length) {
    const via = GEMINI_KEY ? `Gemini ${GEMINI_MODEL}` : GROQ_KEY ? 'Groq' : OPENROUTER_KEY ? 'OpenRouter' : 'Pollinations (sin clave)';
    console.log(`2a/3 Verificando ${pendientes.length} posts nuevos con IA (vía ${via}, ${iaCacheHits} de caché)…`);
    const resIA = await verificarConIA(
      pendientes.map((e) => ({ indice: e.iaIdx, cuenta: e.cuenta, fechaPost: e.fecha || `hace ${e.dias} días`, texto: e.texto })),
      { geminiKey: GEMINI_KEY, geminiModel: GEMINI_MODEL, groqKey: GROQ_KEY, openrouterKey: OPENROUTER_KEY,
        customBase: envLocal('IA_BASE_URL'), customKey: envLocal('IA_API_KEY'), customModel: envLocal('IA_MODEL'),
        deepseekKey: envLocal('DEEPSEEK_API_KEY'), pago: envLocal('IA_PAGO') === '1',
        maxPosts: Number(envLocal('MAX_IA_POSTS') || 120), hoy: hoyDmy });
    for (const [k, v] of resIA.veredictos) {
      const e = pendientes.find((x) => x.iaIdx === k);
      if (e) veredictos.set(e.indice, v);
    }
    // Índices vistos por la IA (lotes con éxito) mapeados a pre: solo esos
    // pueden descartarse por "vistos sin veredicto"; los de lotes fallidos
    // caen al fallback regex en vez de perderse.
    for (const k of resIA.vistos || []) {
      const e = pendientes.find((x) => x.iaIdx === k);
      if (e) vistosIA.add(e.indice);
    }
    for (const e of pendientes) {
      if (e.cacheHit) vistosIA.add(e.indice);
    }
    console.log(`IA: ${resIA.veredictos.size} veredictos nuevos + ${iaCacheHits} de caché`);
    for (const [k, v] of veredictos) {
      if (k < 12) console.log(`  IA #${k}: relevante=${v.relevante !== false} · ${String(v.motivo || '').slice(0, 70)}`);
    }
  } else if (pre.length) {
    console.log(`2a/3 IA omitida (--sin-ia) o todo en caché (${iaCacheHits}): decide la regex.`);
  }
}

for (const e of pre) {
  const v = veredictos.get(e.indice);
  if (vistosIA.has(e.indice) && !v) continue; // la IA lo vio y no lo devolvió = irrelevante
  if (v && v.relevante === false) continue; // la IA lo descarta aunque la regex lo quisiera
  const motivos = [...e.motivos];
  let eventoDay = e.fEv, score = e.score;
  const orqExtra = [];
  if (v) {
    motivos.push('IA: ' + String(v.motivo || 'vigente').slice(0, 80));
    if (v.fechaEvento && /^\d{2}-\d{2}-\d{4}$/.test(v.fechaEvento)) eventoDay = v.fechaEvento;
    for (const o of v.orquestas || []) {
      if (!e.ho?.includes(String(o).split(' (')[0]) && !orqExtra.includes(o)) orqExtra.push(o);
    }
    if (v.esCancelacion && (v.orquestas?.[0] || e.ho)) {
      const on = String(v.orquestas?.[0] || e.ho).split(' (')[0];
      if (!senales.some((s) => s.tipo === 'cancelacion' && s.orquesta === on)) {
        senales.push({ tipo: 'cancelacion', orquesta: on, cuenta: e.cuenta, url: e.url, texto: e.texto.slice(0, 300), fecha: e.fecha });
      }
    }
    if (v.esRetomar && (v.orquestas?.[0] || e.ho)) {
      const on = String(v.orquestas?.[0] || e.ho).split(' (')[0];
      if (!senales.some((s) => s.tipo === 'retomar' && s.orquesta === on)) {
        senales.push({ tipo: 'retomar', orquesta: on, cuenta: e.cuenta, url: e.url, texto: e.texto.slice(0, 300), fecha: e.fecha });
      }
    }
  }
  // Sin veredicto IA rige la regex (>=4); con veredicto favorable basta >=2.
  if (!v && score < 4) continue;
  // La fecha que da la IA también se valida: si ya pasó, fuera.
  if (eventoDay) {
    const [ed, em, ey] = eventoDay.split('-').map(Number);
    if (ey && em && ed && new Date(ey, em - 1, ed) < hoy0()) { eventosPasados++; continue; }
  }
  const orquestas = [...(e.ho ? [e.ho.split(' (')[0]] : []), ...orqExtra].filter(Boolean);
  candidatas.push({
    id: e.id,
    cuenta: e.cuenta, fecha: e.fecha, dias: e.dias, url: e.url,
    eventoDay, texto: e.texto.slice(0, 600), fotos: e.fotos, pdfs: e.pdfs,
    orquestas, score: v ? Math.max(score, 4) : score, motivos, revisadoEl: e.revisadoEl,
    // Veredicto IA cacheable: la web lee esto, no pregunta a la IA.
    textoHash: e.hash,
    ia: v ? { relevante: v.relevante !== false, fechaEvento: v.fechaEvento || null,
      motivo: String(v.motivo || '').slice(0, 120), deCache: !!v.deCache, at: Date.now() } : null
  });
}
candidatas.sort((a, b) => b.score - a.score || a.dias - b.dias);
// Sin duplicados: dos recortes del mismo hilo (post + comentario con el
// mismo story_fbid) colisionan en ID; se queda el de mayor score.
for (let i = candidatas.length - 1; i >= 0; i--) {
  if (candidatas.findIndex((x) => x.id === candidatas[i].id) !== i) candidatas.splice(i, 1);
}

// ---------- 2b. Cruce con eventos en BD: cancelaciones y retomadas ----------
console.log('2b/3 Ciclo de vida…');
const hoyN = (() => { const d = new Date(); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); })();
const cambiosEstado = []; // {id, titulo, day, de, a, motivo}
try {
  const events = await (await fetch(`${DB}/events.json`)).json() || {};
  const lista = Object.entries(events).map(([id, v]) => ({ id, ...v }));
  const deOrquesta = (nombre) => {
    const n = alnum(nombre);
    return lista.filter((e) => (e.dayNum || 0) >= hoyN && (e.orquestas || []).some((o) => {
      const a = alnum(o);
      return a && (a === n || a.includes(n) || n.includes(a));
    }));
  };
  for (const s of senales) {
    const evs = deOrquesta(s.orquesta);
    if (s.tipo === 'cancelacion') {
      if (evs.length === 1) {
        const e = evs[0];
        await fetch(`${DB}/events/${e.id}.json`, { method: 'PATCH',
          body: JSON.stringify({ estado: 'cancelado', motivoCancelacion: s.url, actualizadoAt: Date.now() }) });
        cambiosEstado.push({ id: e.id, titulo: e.titulo, day: e.day, de: e.estado || 'activo', a: 'cancelado', motivo: s.url });
      } else if (evs.length > 1) {
        for (const e of evs) {
          await fetch(`${DB}/events/${e.id}.json`, { method: 'PATCH',
            body: JSON.stringify({ posibleCancelacion: true, motivoCancelacion: s.url }) });
        }
        cambiosEstado.push({ id: evs[0].id, titulo: `${evs.length} eventos de ${s.orquesta}`, day: '', de: 'activo', a: 'posible-cancelacion', motivo: s.url });
      }
    } else if (s.tipo === 'retomar') {
      const canc = evs.filter((e) => e.estado === 'cancelado');
      for (const e of canc) {
        await fetch(`${DB}/events/${e.id}.json`, { method: 'PATCH',
          body: JSON.stringify({ estado: 'activo', motivoCancelacion: null, posibleCancelacion: null, actualizadoAt: Date.now() }) });
        cambiosEstado.push({ id: e.id, titulo: e.titulo, day: e.day, de: 'cancelado', a: 'activo', motivo: s.url });
      }
    }
  }
  console.log(`Señales: ${senales.length} · cambios de estado: ${cambiosEstado.length}`);
} catch (e) {
  console.log('Ciclo de vida omitido (' + (e.message || e).split('\n')[0] + ')');
}

// ---------- 2c. Cruce candidatas IA-verificadas con eventos presentes/futuros ----------
// Si la candidata casa con un evento en BD se enriquece (confirmado por FB);
// si no casa con ninguno, queda como novedosa (posible evento nuevo).
console.log('2c/3 Cruce con eventos en BD…');
const cruces = []; // {candidata, evento, accion}
let futurosBD = []; // eventos presentes/futuros: los reutiliza 2d (cola)
try {
  // Municipio por cuenta (de /cuentas).
  const muniPorCuenta = new Map();
  try {
    const cuentasDb = JSON.parse(fs.readFileSync(path.join(ROOT, '.cache', 'fb-cuentas.json'), 'utf8'));
    for (const c of cuentasDb) {
      if (c.url) muniPorCuenta.set(normD(c.url).replace(/\/$/, ''), c.municipio || '');
      if (c.handle) muniPorCuenta.set('handle:' + normD(c.handle), c.municipio || '');
    }
  } catch { /* sin lista de cuentas: se cruza solo por orquesta+título */ }
  const muniDeCuenta = (cuenta) => {
    const u = normD(cuenta).replace(/\/$/, '');
    if (muniPorCuenta.has(u)) return muniPorCuenta.get(u);
    const h = u.split('/').filter(Boolean).pop() || '';
    return muniPorCuenta.get('handle:' + h) || '';
  };
  const STOPC = new Set(['de', 'la', 'el', 'las', 'los', 'del', 'en', 'con', 'por', 'una', 'y', 'al', 'gran', 'san', 'santa', 'fiesta', 'fiestas', 'baile', 'verbena']);
  const toksC = (s) => new Set(normD(s).split(' ').filter((w) => w.length > 3 && !STOPC.has(w)));
  const events2 = await (await fetch(`${DB}/events.json`)).json() || {};
  futurosBD = Object.entries(events2).map(([id, v]) => ({ id, ...v }))
    .filter((e) => (e.dayNum || 0) >= hoyN && (e.estado || 'activo') === 'activo');

  for (const c of candidatas) {
    const muniC = muniDeCuenta(c.cuenta);
    const tc = toksC(c.texto);
    const casan = futurosBD.filter((e) => {
      if (muniC && normD(e.municipio) !== normD(muniC)) return false;
      const eo = (e.orquestas || []).map(alnum).filter(Boolean);
      const co = (c.orquestas || []).map(alnum).filter(Boolean);
      const hayOrq = eo.some((a) => co.some((b) => a === b || a.includes(b) || b.includes(a)));
      if (hayOrq) return true;
      if (!muniC) return false; // sin municipio solo vale orquesta común
      const te = toksC(e.titulo);
      let n = 0;
      for (const w of tc) if (te.has(w)) n++;
      return n >= 2;
    });
    if (casan.length === 1) {
      const e = casan[0];
      const marca = `confirmado en Facebook (${c.cuenta.split('/').filter(Boolean).pop()})`;
      const orqU = [...(e.orquestas || [])];
      for (const o of c.orquestas || []) {
        if (!orqU.some((x) => alnum(x) === alnum(o))) orqU.push(o);
      }
      const patch = {
        orquestas: orqU,
        motivos: [...new Set([...(e.motivos || []), marca])],
        fuentes: [...new Set([...(e.fuentes || [e.fuente].filter(Boolean)), 'facebook'])],
        score: Math.max(e.score || 0, c.score || 0),
        actualizadoAt: Date.now()
      };
      await fetch(`${DB}/events/${e.id}.json`, { method: 'PATCH', body: JSON.stringify(patch) });
      c.eventoId = e.id;
      cruces.push({ candidata: c.id, evento: e.id, accion: 'enriquecido', titulo: e.titulo, day: e.day });
    } else if (casan.length === 0) {
      cruces.push({ candidata: c.id, evento: null, accion: 'novedoso', titulo: c.texto.slice(0, 60) });
    } else {
      cruces.push({ candidata: c.id, evento: null, accion: 'ambiguo', titulo: `${casan.length} candidatos` });
    }
  }
  const enr = cruces.filter((x) => x.accion === 'enriquecido').length;
  const nov = cruces.filter((x) => x.accion === 'novedoso').length;
  console.log(`Cruce: ${enr} enriquecidos, ${nov} novedosos, ${cruces.length - enr - nov} ambiguos`);
} catch (e) {
  console.log('Cruce omitido (' + (e.message || e).split('\n')[0] + ')');
}

// ---------- 2d. Actividad por cuenta (Plan C) + cola priorizada (Plan D) ----------
// Mide diasUltimoPost por cuenta desde lo extraído, guarda el ritmo en local
// + Firebase, y deja .cache/fb-cola.json con las orquestas en cartel para que
// el monitor las ponga primeras en la próxima pasada.
console.log('2d/3 Actividad y cola…');
let mdActividad = '';
try {
  let conf = [];
  try { conf = JSON.parse(fs.readFileSync(path.join(ROOT, '.cache', 'fb-cuentas.json'), 'utf8')); } catch {}
  if (!Array.isArray(conf)) conf = [];
  const porUrl = new Map(conf.map((c) => [String(c.url || '').replace(/\/$/, ''), c]));
  const ahora = Date.now();
  const cambios = [];
  if (fs.existsSync(POSTS_DIR)) {
    for (const f of fs.readdirSync(POSTS_DIR).filter((x) => x.endsWith('.json'))) {
      let d;
      try { d = JSON.parse(fs.readFileSync(path.join(POSTS_DIR, f), 'utf8')); } catch { continue; }
      const c = porUrl.get(String(d.cuenta || '').replace(/\/$/, ''));
      if (!c?.id) continue;
      const posts = d.posts || [];
      const rev = Date.parse(d.revisadoEl) || ahora;
      let mejor = 0;
      for (const p of posts) {
        let tp = Date.parse(p.fecha || '');
        if (!tp) {
          const dd = antiguedadDias(p.fecha, d.revisadoEl);
          tp = dd < 900 ? rev - dd * 864e5 : 0;
        }
        if (tp > mejor) mejor = tp;
      }
      const dias = mejor ? Math.max(0, Math.round((ahora - mejor) / 864e5)) : 999;
      // Abandonada = +1 año sin publicar. Las comisiones callan fuera de
      // temporada hasta el año siguiente: eso es "fría", no abandono (el
      // boost de temporada/pre-fiesta las sigue subiendo en la cola).
      const ritmo = dias < 7 ? 'caliente' : dias < 30 ? 'templada' : dias < 365 ? 'fria' : 'abandonada';
      const fallos = posts.length ? 0 : (c.fallosSeguidos || 0) + 1;
      cambios.push({ id: c.id, patch: {
        ultimaActividad: mejor || c.ultimaActividad || 0,
        ritmo: fallos >= 3 ? 'abandonada' : ritmo,
        fallosSeguidos: fallos, postsVistos: posts.length, updatedAt: ahora } });
    }
  }
  const arr = conf.map((c) => {
    const ch = cambios.find((x) => x.id === c.id);
    return ch ? { ...c, ...ch.patch } : c;
  });
  try { fs.writeFileSync(path.join(ROOT, '.cache', 'fb-cuentas.json'), JSON.stringify(arr, null, 2)); } catch {}
  let guardadas = 0;
  for (const ch of cambios) {
    try {
      const r = await fetch(`${DB}/fb_cuentas/${ch.id}.json`, { method: 'PATCH', body: JSON.stringify(ch.patch) });
      if (r.ok) guardadas++;
    } catch { /* una cuenta sin red no bloquea la pasada */ }
  }
  const enCartel = new Set();
  for (const e of futurosBD) for (const o of e.orquestas || []) {
    const n = alnum(o);
    if (n) enCartel.add(n);
  }
  try {
    fs.writeFileSync(path.join(ROOT, '.cache', 'fb-cola.json'),
      JSON.stringify({ at: ahora, orquestas: [...enCartel].slice(0, 80) }, null, 2));
  } catch {}
  const conRitmo = (r) => arr.filter((c) => c.ritmo === r && c.activa !== false).length;
  const sinMedir = arr.filter((c) => !c.ritmo && c.activa !== false).length;
  const porTipo = {};
  for (const c of arr.filter((c) => c.activa !== false)) {
    const k = `${c.tipo || 'otro'}/${c.ritmo || 'sin-medir'}`;
    porTipo[k] = (porTipo[k] || 0) + 1;
  }
  mdActividad = `\n## Actividad por cuenta (ritmo medido)\n\n` +
    `Calientes: ${conRitmo('caliente')} · Templadas: ${conRitmo('templada')} · Frías: ${conRitmo('fria')} · Abandonadas: ${conRitmo('abandonada')} · Sin medir: ${sinMedir}\n\n` +
    Object.entries(porTipo).sort().map(([k, n]) => `- ${k}: ${n}`).join('\n') + '\n\n' +
    `Orquestas en cartel para la próxima cola: ${enCartel.size} · Ritmos guardados en Firebase: ${guardadas}/${cambios.length}\n`;
  console.log(`Actividad: ${cambios.length} medidas, ${guardadas} en Firebase · en cartel: ${enCartel.size}`);
} catch (e) {
  console.log('Actividad omitida (' + (e.message || e).split('\n')[0] + ')');
}

// ---------- 3. Guardado: informe + Firebase ----------
const hoy = new Date().toISOString().slice(0, 10);
const informe = path.join(ROOT, '.cache', `fb-revision-${hoy}.md`);
let md = `# Revisión Facebook ${hoy}\n\nCuentas: ${cuentas} · Posts: ${totalPosts} (reels omitidos: ${reelsOmitidos}, eventos ya pasados: ${eventosPasados}) · Candidatas a verbena: ${candidatas.length}\n\n`;
if (mdActividad) md += mdActividad;
if (candidatas.length) {
  md += `## Candidatas (score ≥ 4)\n\n`;
  for (const c of candidatas) {
    md += `### ${c.cuenta} · ${c.fecha || 's/f'}${c.eventoDay ? ` · evento ${c.eventoDay}` : ''} · score ${c.score}\n${c.motivos.join(' · ')}\n\n> ${c.texto.slice(0, 400).replace(/\n/g, ' ')}\n\n${c.url}\n`;
    if (c.fotos.length) md += `\nFotos (${c.fotos.length}):\n` + c.fotos.map((f) => `- ${f}`).join('\n') + '\n';
    if (c.pdfs.length) md += `\nPDFs:\n` + c.pdfs.map((f) => `- ${f}`).join('\n') + '\n';
    md += '\n';
  }
} else {
  md += `Sin candidatas esta vez.\n`;
}
if (cambiosEstado.length) {
  md += `## Cambios de estado\n\n`;
  for (const c of cambiosEstado) {
    md += `- ${c.titulo} (${c.day || 's/f'}): ${c.de} → **${c.a}** · ${c.motivo}\n`;
  }
  md += '\n';
}
if (cruces.length) {
  const enr = cruces.filter((x) => x.accion === 'enriquecido');
  const nov = cruces.filter((x) => x.accion === 'novedoso');
  md += `## Cruce con eventos en BD\n\nEnriquecidos: ${enr.length} · Novedosos: ${nov.length} · Ambiguos: ${cruces.length - enr.length - nov.length}\n\n`;
  for (const x of enr.slice(0, 30)) md += `- ✅ ${x.titulo} (${x.day}) ← ${x.candidata}\n`;
  for (const x of nov.slice(0, 30)) md += `- 🆕 ${x.titulo}… ← ${x.candidata}\n`;
  md += '\n';
}
fs.writeFileSync(informe, md);
// Listado completo para la web (/api/fb-candidatas lo sirve si no hay Firebase).
fs.writeFileSync(path.join(ROOT, '.cache', 'fb-candidatas.json'),
  JSON.stringify({ actualizadoEl: new Date().toISOString(), cuentas, posts: totalPosts, candidatas }, null, 2));
console.log(`3/3 Informe: .cache/fb-revision-${hoy}.md (${candidatas.length} candidatas de ${totalPosts} posts en ${cuentas} cuentas)`);

// Volcado a Firebase por REST (las reglas están abiertas; sin service account
// no hay Admin SDK, pero el PUT anónimo vale igual para estos nodos).
// Espejo exacto del listado local: se borran los IDs que ya no están para
// que la web no muestre fantasmas descartados por la IA o envejecidos.
try {
  for (const c of candidatas) {
    const r = await fetch(`${DB}/fb_candidatos/${c.id}.json`, { method: 'PUT', body: JSON.stringify(c) });
    if (!r.ok) throw new Error(`PUT fb_candidatos: HTTP ${r.status}`);
  }
  const idsAhora = new Set(candidatas.map((c) => c.id));
  const previas = Object.keys((await (await fetch(`${DB}/fb_candidatos.json?shallow=true`)).json()) || {});
  let borradas = 0;
  for (const id of previas) {
    if (!idsAhora.has(id)) {
      const r = await fetch(`${DB}/fb_candidatos/${id}.json`, { method: 'DELETE' });
      if (r.ok) borradas++;
    }
  }
  await fetch(`${DB}/meta/fb_revision.json`, { method: 'PUT',
    body: JSON.stringify({ at: Date.now(), cuentas, posts: totalPosts, candidatas: candidatas.length, cambiosEstado: cambiosEstado.length }) });
  const frescas = candidatas.filter((c) => (c.dias ?? 999) <= 7).length;
  console.log(`Firebase: ${candidatas.length} candidatas (${frescas} frescas) + meta/fb_revision ✓${borradas ? ` · ${borradas} obsoletas borradas` : ''}`);
} catch (e) {
  console.log('Firebase: no se pudo volcar (' + (e.message || e).split('\n')[0] + '). Informe local OK.');
}

await marcarProgreso({ estado: 'lista', fase: 'lista', fin: Date.now(),
  cuentas, posts: totalPosts, candidatas: candidatas.length, cuentaActual: '' });

if (!args['sin-extraer']) {
  fs.writeFileSync(STAMP, String(Date.now()));
  try { execFileSync('osascript', ['-e', `display notification "${candidatas.length} candidatas, ${cambiosEstado.length} cambios de estado" with title "Verbenas: revisión Facebook lista"`]); } catch { /* sin GUI */ }
}
