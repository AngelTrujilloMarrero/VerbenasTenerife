// Revisión automática al encender el Mac: extrae últimos posts de las cuentas,
// detecta posibles verbenas, lo guarda en Firebase y deja un listado.
// Uso manual: node scripts/revision-auto.mjs [--forzar] [--sin-extraer]
//   --forzar: ignora el guardado de 20h (si ya se revisó hoy, no repite)
//   --sin-extraer: no abre el navegador, solo clasifica lo ya descargado
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

// ---------- 1. Extracción ----------
if (!args['sin-extraer']) {
  console.log('1/3 Extrayendo últimos posts de las cuentas…');
  const r = spawnSync('node', ['scripts/monitor-facebook-browser.mjs', '--todas', '--posts=3'],
    { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) console.warn('Extracción acabó con código', r.status, '(se clasifica lo que haya)');
} else {
  console.log('1/3 Extracción omitida (--sin-extraer).');
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
const DB = 'https://verbenastenerife-default-rtdb.europe-west1.firebasedatabase.app';
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
  let m = t.match(/\beste\s+(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/);
  if (m) return mas(SEM_LUN[m[1]] - dowMon); // misma semana (si ya pasó, sale pasado)
  m = t.match(/\bel\s+(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/);
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
      let score = 0;
      const motivos = [];
      const pm = p.texto.match(RE_VERBENA);
      if (pm) { score += 3; motivos.push('keyword: ' + pm[1]); }
      const fi = p.texto.match(RE_FIESTA);
      if (fi) { score += 2; motivos.push('fiesta: ' + fi[1].slice(0, 40)); }
      const ho = orquestaEn(p.texto);
      if (ho) { score += 5; motivos.push('orquesta 2024-25: ' + ho); }
      if (RE_HORA.test(p.texto)) { score += 1; motivos.push('hora 19-23h'); }
      if (/plaza|parque|recinto/i.test(p.texto)) { score += 1; motivos.push('lugar verbena'); }
      if (RE_ANTI.test(p.texto)) { score -= 4; motivos.push('penalización no-verbena'); }
      const dias = antiguedadDias(p.fecha, d.revisadoEl);
      // Fecha del evento: si el texto la delata y ya pasó, fuera (post de hace
      // 4 días diciendo "esta noche" = evento de hace 4 días).
      const fEv = fechaEvento(d.revisadoEl, dias, p.texto);
      if (fEv && fEv < hoy0()) { eventosPasados++; continue; }
      // Señales de ciclo de vida: solo posts frescos (<=10 días) con orquesta.
      if (dias <= 10) {
        const hoNombre = (ho || '').split(' (')[0];
        if (hoNombre && RE_CANCEL.test(p.texto)) {
          senales.push({ tipo: 'cancelacion', orquesta: hoNombre, cuenta: d.cuenta, url: p.url || '', texto: p.texto.slice(0, 300), fecha: p.fecha || '' });
        } else if (hoNombre && RE_RETOMAR.test(p.texto)) {
          senales.push({ tipo: 'retomar', orquesta: hoNombre, cuenta: d.cuenta, url: p.url || '', texto: p.texto.slice(0, 300), fecha: p.fecha || '' });
        }
      }
      // Pre-filtro barato: a la IA solo lo que huele a verbena (>=2).
      if (score >= 2) {
        pre.push({ indice: pre.length, cuenta: d.cuenta, url: p.url || '', fecha: p.fecha || '',
          dias, fEv: fEv ? dmyDe(fEv) : '', texto: p.texto.slice(0, 800),
          fotos: (p.imagenes || []).slice(0, 4), pdfs: p.pdfs || [],
          ho, score, motivos, revisadoEl: d.revisadoEl });
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
{
  const hoyDmy = (() => { const d = new Date(); return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`; })();
  if (!SOLO_REGEX && pre.length) {
    const via = GEMINI_KEY ? `Gemini ${GEMINI_MODEL}` : GROQ_KEY ? 'Groq' : OPENROUTER_KEY ? 'OpenRouter' : 'Pollinations (sin clave)';
    console.log(`2a/3 Verificando ${pre.length} posts con IA (vía ${via})…`);
    const resIA = await verificarConIA(
      pre.map((e) => ({ indice: e.indice, cuenta: e.cuenta, fechaPost: e.fecha || `hace ${e.dias} días`, texto: e.texto })),
      { geminiKey: GEMINI_KEY, geminiModel: GEMINI_MODEL, groqKey: GROQ_KEY, openrouterKey: OPENROUTER_KEY,
        customBase: envLocal('IA_BASE_URL'), customKey: envLocal('IA_API_KEY'), customModel: envLocal('IA_MODEL'),
        deepseekKey: envLocal('DEEPSEEK_API_KEY'), pago: envLocal('IA_PAGO') === '1',
        maxPosts: Number(envLocal('MAX_IA_POSTS') || 120), hoy: hoyDmy });
    veredictos = resIA.veredictos;
    console.log(`IA: ${veredictos.size} veredictos de ${pre.length}`);
  } else if (pre.length) {
    console.log('2a/3 IA omitida (--sin-ia): decide la regex.');
  }
}

for (const e of pre) {
  const v = veredictos.get(e.indice);
  if (v && !GEMINI_KEY) { /* imposible, guardia */ }
  if (veredictos.size && !v) continue; // la IA lo vio y no lo devolvió = irrelevante
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
  const orquestas = [...(e.ho ? [e.ho.split(' (')[0]] : []), ...orqExtra].filter(Boolean);
  candidatas.push({
    id: idPost(e.cuenta, { url: e.url, texto: e.texto }),
    cuenta: e.cuenta, fecha: e.fecha, dias: e.dias, url: e.url,
    eventoDay, texto: e.texto.slice(0, 600), fotos: e.fotos, pdfs: e.pdfs,
    orquestas, score: v ? Math.max(score, 4) : score, motivos, revisadoEl: e.revisadoEl
  });
}
candidatas.sort((a, b) => b.score - a.score || a.dias - b.dias);

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

// ---------- 3. Guardado: informe + Firebase ----------
const hoy = new Date().toISOString().slice(0, 10);
const informe = path.join(ROOT, '.cache', `fb-revision-${hoy}.md`);
let md = `# Revisión Facebook ${hoy}\n\nCuentas: ${cuentas} · Posts: ${totalPosts} (reels omitidos: ${reelsOmitidos}, eventos ya pasados: ${eventosPasados}) · Candidatas a verbena: ${candidatas.length}\n\n`;
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
fs.writeFileSync(informe, md);
// Listado completo para la web (/api/fb-candidatas lo sirve si no hay Firebase).
fs.writeFileSync(path.join(ROOT, '.cache', 'fb-candidatas.json'),
  JSON.stringify({ actualizadoEl: new Date().toISOString(), cuentas, posts: totalPosts, candidatas }, null, 2));
console.log(`3/3 Informe: .cache/fb-revision-${hoy}.md (${candidatas.length} candidatas de ${totalPosts} posts en ${cuentas} cuentas)`);

// Volcado a Firebase por REST (las reglas están abiertas; sin service account
// no hay Admin SDK, pero el PUT anónimo vale igual para estos nodos).
try {
  // A la nube solo lo fresco (post de <=7 días): los hallazgos son presente.
  const frescas = candidatas.filter((c) => (c.dias ?? 999) <= 7);
  for (const c of frescas) {
    const r = await fetch(`${DB}/fb_candidatos/${c.id}.json`, { method: 'PUT', body: JSON.stringify(c) });
    if (!r.ok) throw new Error(`PUT fb_candidatos: HTTP ${r.status}`);
  }
  await fetch(`${DB}/meta/fb_revision.json`, { method: 'PUT',
    body: JSON.stringify({ at: Date.now(), cuentas, posts: totalPosts, candidatas: candidatas.length, cambiosEstado: cambiosEstado.length }) });
  console.log(`Firebase: ${frescas.length} candidatas frescas + meta/fb_revision ✓`);
} catch (e) {
  console.log('Firebase: no se pudo volcar (' + (e.message || e).split('\n')[0] + '). Informe local OK.');
}

if (!args['sin-extraer']) {
  fs.writeFileSync(STAMP, String(Date.now()));
  try { execFileSync('osascript', ['-e', `display notification "${candidatas.length} candidatas, ${cambiosEstado.length} cambios de estado" with title "Verbenas: revisión Facebook lista"`]); } catch { /* sin GUI */ }
}
