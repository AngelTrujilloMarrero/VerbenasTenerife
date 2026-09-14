// Revisión automática al encender el Mac: extrae últimos posts de las cuentas,
// detecta posibles verbenas, lo guarda en Firebase y deja un listado.
// Uso manual: node scripts/revision-auto.mjs [--forzar] [--sin-extraer]
//   --forzar: ignora el guardado de 20h (si ya se revisó hoy, no repite)
//   --sin-extraer: no abre el navegador, solo clasifica lo ya descargado
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
const RE_ANTI = /infantil|familiar|beb[ée]cuento|hinchables?|tercera edad|tercera juventud|\bmayores\b|misa|procesi[óo]n|rosario/i;
const RE_HORA = /(19|2[0-3]):\d{2}/;

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

const candidatas = [];
let totalPosts = 0, cuentas = 0;
if (fs.existsSync(POSTS_DIR)) {
  for (const f of fs.readdirSync(POSTS_DIR).filter((x) => x.endsWith('.json'))) {
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(POSTS_DIR, f), 'utf8')); } catch { continue; }
    cuentas++;
    for (const p of d.posts || []) {
      totalPosts++;
      let score = 0;
      const motivos = [];
      const pm = p.texto.match(RE_VERBENA);
      if (pm) { score += 3; motivos.push('keyword: ' + pm[1]); }
      const ho = orquestaEn(p.texto);
      if (ho) { score += 5; motivos.push('orquesta 2024-25: ' + ho); }
      if (RE_HORA.test(p.texto)) { score += 1; motivos.push('hora 19-23h'); }
      if (/plaza|parque|recinto/i.test(p.texto)) { score += 1; motivos.push('lugar verbena'); }
      if (RE_ANTI.test(p.texto)) { score -= 4; motivos.push('penalización no-verbena'); }
      const dias = antiguedadDias(p.fecha, d.revisadoEl);
      if (score >= 4) {
        candidatas.push({
          id: 'fb-' + Buffer.from(p.url || (d.cuenta + p.texto.slice(0, 40))).toString('base64').replace(/[^a-z0-9]/gi, '').slice(0, 24),
          cuenta: d.cuenta, fecha: p.fecha || '', dias, url: p.url || '',
          texto: p.texto.slice(0, 600), fotos: (p.imagenes || []).slice(0, 4), pdfs: p.pdfs || [],
          score, motivos, revisadoEl: d.revisadoEl
        });
      }
    }
  }
}
candidatas.sort((a, b) => b.score - a.score || a.dias - b.dias);

// ---------- 3. Guardado: informe + Firebase ----------
const hoy = new Date().toISOString().slice(0, 10);
const informe = path.join(ROOT, '.cache', `fb-revision-${hoy}.md`);
let md = `# Revisión Facebook ${hoy}\n\nCuentas: ${cuentas} · Posts: ${totalPosts} · Candidatas a verbena: ${candidatas.length}\n\n`;
if (candidatas.length) {
  md += `## Candidatas (score ≥ 4)\n\n`;
  for (const c of candidatas) {
    md += `### ${c.cuenta} · ${c.fecha || 's/f'} · score ${c.score}\n${c.motivos.join(' · ')}\n\n> ${c.texto.slice(0, 400).replace(/\n/g, ' ')}\n\n${c.url}\n`;
    if (c.fotos.length) md += `\nFotos (${c.fotos.length}):\n` + c.fotos.map((f) => `- ${f}`).join('\n') + '\n';
    if (c.pdfs.length) md += `\nPDFs:\n` + c.pdfs.map((f) => `- ${f}`).join('\n') + '\n';
    md += '\n';
  }
} else {
  md += `Sin candidatas esta vez.\n`;
}
fs.writeFileSync(informe, md);
// Listado completo para la web (/api/fb-candidatas lo sirve si no hay Firebase).
fs.writeFileSync(path.join(ROOT, '.cache', 'fb-candidatas.json'),
  JSON.stringify({ actualizadoEl: new Date().toISOString(), cuentas, posts: totalPosts, candidatas }, null, 2));
console.log(`3/3 Informe: .cache/fb-revision-${hoy}.md (${candidatas.length} candidatas de ${totalPosts} posts en ${cuentas} cuentas)`);

// Volcado a Firebase con Admin SDK (lectura pública, escritura solo servidor).
function cargarEnv() {
  const f = path.join(ROOT, '.env');
  if (!fs.existsSync(f)) return;
  for (const lin of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = lin.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}
cargarEnv();
try {
  const { default: admin } = await import('firebase-admin');
  const sa = (process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
  const url = (process.env.PUBLIC_FIREBASE_DATABASE_URL || '').trim();
  const cred = sa.startsWith('{') ? JSON.parse(sa)
    : sa ? JSON.parse(fs.readFileSync(path.isAbsolute(sa) ? sa : path.join(ROOT, sa), 'utf8')) : null;
  if (cred && url) {
    const app = admin.initializeApp({ credential: admin.credential.cert(cred), databaseURL: url });
    const db = admin.database(app);
    for (const c of candidatas) await db.ref(`fb_candidatos/${c.id}`).set(c);
    await db.ref('meta/fb_revision').set({ at: Date.now(), cuentas, posts: totalPosts, candidatas: candidatas.length });
    console.log(`Firebase: ${candidatas.length} candidatas en fb_candidatos + meta/fb_revision ✓`);
    await app.delete();
  } else {
    console.log('Firebase: sin credenciales en .env (informe local igualmente guardado).');
  }
} catch (e) {
  console.log('Firebase: no se pudo volcar (' + (e.message || e).split('\n')[0] + '). Informe local OK.');
}

if (!args['sin-extraer']) {
  fs.writeFileSync(STAMP, String(Date.now()));
  try { execFileSync('osascript', ['-e', `display notification "${candidatas.length} candidatas de ${cuentas} cuentas" with title "Verbenas: revisión Facebook lista"`]); } catch { /* sin GUI */ }
}
