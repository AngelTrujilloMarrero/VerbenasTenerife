// Limpieza de duplicados en Firebase (Plan B Fase 2).
// Las reglas están abiertas (ver database.rules.json), así que trabaja por
// REST sin service account. SIEMPRE hace backup antes de escribir.
//
// Uso:
//   node scripts/dedup-db.mjs --seco        -> informa sin tocar nada
//   node scripts/dedup-db.mjs --aplicar     -> fusiona + backfill clave/estado
const DB = 'https://verbenastenerife-default-rtdb.europe-west1.firebasedatabase.app';
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.join('=') || true];
}));
const SECO = !args.aplicar;

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORQ_HIST = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'lib', 'data', 'orquestas.json'), 'utf8')).orquestas || [];

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const alnum = (s) => norm(s).replace(/ /g, '');
const STOP = new Set(['de', 'la', 'el', 'las', 'los', 'del', 'en', 'con', 'por', 'una', 'uno', 'y', 'al', 'fin', 'gran', 'san', 'santa', 'fiesta', 'fiestas', 'baile', 'verbena', 'orquesta', 'orquestas', 'grupo', 'grupos', 'plaza', 'parque', 'recinto']);
const toks = (s) => new Set(norm(s).split(' ').filter((w) => w.length > 3 && !STOP.has(w)));
const orqSet = (v) => new Set((v.orquestas || []).map((o) => alnum(o)).filter((x) => x.length > 2));

function orquestaPrincipal(v) {
  const hay = ` ${norm([...(v.orquestas || []), v.titulo].join(' '))} `;
  for (const { nombre } of ORQ_HIST) {
    const low = norm(nombre);
    if (low.includes(' ') ? hay.includes(` ${low} `) : hay.split(' ').includes(low)) return alnum(nombre);
  }
  return (v.orquestas || []).length ? alnum(v.orquestas[0]).slice(0, 24) : '';
}
function slugTitulo(t) {
  return norm(t).split(' ').filter((w) => w.length > 2 && !STOP.has(w)).slice(0, 5).join('-');
}
const claveDe = (v) => `${norm(v.municipio).replace(/ /g, '')}|${v.day || ''}|${orquestaPrincipal(v) || slugTitulo(v.titulo)}`;

function mismos(a, b) {
  if (norm(a.municipio) !== norm(b.municipio)) return false;
  if (!a.day || a.day !== b.day) return false;
  if (a.hora && b.hora && a.hora !== b.hora) return false;
  const oa = orqSet(a), ob = orqSet(b);
  for (const x of oa) for (const y of ob) {
    if (x === y || x.includes(y) || y.includes(x)) return true;
  }
  const ta = toks(a.titulo), tb = toks(b.titulo);
  let c = 0;
  for (const w of ta) if (tb.has(w)) c++;
  return c >= 2;
}

function fusionar(a, b) {
  const conHora = a.hora ? a : b;
  const otra = conHora === a ? b : a;
  const orq = [...(conHora.orquestas || [])];
  for (const o of otra.orquestas || []) {
    if (!orq.some((x) => norm(x) === norm(o))) orq.push(o);
  }
  const fuentes = [...new Set([...(conHora.fuentes || [conHora.fuente].filter(Boolean)), ...((otra.fuentes || [otra.fuente]).filter(Boolean))])];
  const motivos = [...new Set([...(a.motivos || []), ...(b.motivos || [])])];
  return {
    ...conHora,
    titulo: conHora.titulo.length >= (otra.titulo || '').length ? conHora.titulo : otra.titulo,
    lugar: conHora.lugar || otra.lugar, url: conHora.url || otra.url,
    orquestas: orq, fuentes, fuente: fuentes[0] || conHora.fuente,
    score: Math.max(a.score || 0, b.score || 0), motivos,
    clave: claveDe(conHora), estado: a.estado || b.estado || 'activo',
    actualizadoAt: Date.now(), dayNum: conHora.dayNum
  };
}

const get = async (p) => (await fetch(`${DB}/${p}.json`)).json();
const put = async (p, v) => {
  const r = await fetch(`${DB}/${p}.json`, { method: 'PUT', body: JSON.stringify(v) });
  if (!r.ok) throw new Error(`PUT ${p}: HTTP ${r.status}`);
};
const del = async (p) => {
  const r = await fetch(`${DB}/${p}.json`, { method: 'DELETE' });
  if (!r.ok) throw new Error(`DELETE ${p}: HTTP ${r.status}`);
};

async function main() {
  const events = (await get('events')) || {};
  const ids = Object.keys(events);
  console.log(`Events en Firebase: ${ids.length}`);
  // Backup siempre (también en --seco, por si acaso).
  const hoy = new Date().toISOString().slice(0, 10);
  fs.mkdirSync(path.join(ROOT, '.cache'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, '.cache', `dedup-backup-${hoy}.json`), JSON.stringify(events, null, 1));
  console.log('Backup en .cache/dedup-backup-' + hoy + '.json');

  // Agrupa por (municipio, day) y clusteriza por parejas.
  const grupos = new Map();
  for (const id of ids) {
    const v = events[id];
    const k = `${norm(v.municipio)}|${v.day || ''}`;
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k).push(id);
  }
  const fusiones = []; // {keeper, merged, borrar:[]}
  let backfill = 0;
  for (const [, g] of grupos) {
    if (g.length < 2) continue;
    const clusters = [];
    for (const id of g) {
      const v = events[id];
      let c = clusters.find((cl) => cl.some((x) => mismos(events[x], v)));
      if (!c) { c = []; clusters.push(c); }
      c.push(id);
    }
    for (const cl of clusters) {
      if (cl.length < 2) continue;
      // Keeper: con hora, más orquestas, título más largo.
      cl.sort((x, y) => (((events[y].hora ? 1 : 0) - (events[x].hora ? 1 : 0))
        || ((events[y].orquestas || []).length - (events[x].orquestas || []).length)
        || ((events[y].titulo || '').length - (events[x].titulo || '').length)));
      let merged = events[cl[0]];
      for (const id of cl.slice(1)) merged = fusionar(merged, events[id]);
      fusiones.push({ keeper: cl[0], merged, borrar: cl.slice(1), muni: events[cl[0]].municipio, day: events[cl[0]].day });
    }
  }
  // Backfill de clave/fuentes/estado en las que no se fusionan.
  const tocadas = new Set(fusiones.flatMap((f) => [f.keeper, ...f.borrar]));
  const faltan = ids.filter((id) => !tocadas.has(id) && (!events[id].clave || !events[id].fuentes || !events[id].estado));

  console.log(`Clústeres a fusionar: ${fusiones.length} (${fusiones.reduce((s, f) => s + f.borrar.length, 0)} filas sobrantes)`);
  console.log(`Filas para backfill (clave/fuentes/estado): ${faltan.length}`);
  for (const f of fusiones.slice(0, 25)) {
    console.log(`  [${f.muni} ${f.day}] keeper=${f.keeper.slice(0, 38)} <- borra ${f.borrar.length}: ${f.borrar.map((b) => b.slice(0, 30)).join(' | ').slice(0, 100)}`);
  }
  fs.writeFileSync(path.join(ROOT, '.cache', `dedup-informe-${hoy}.md`),
    `# Dedup ${hoy}\n\nClústeres: ${fusiones.length}, sobrantes: ${fusiones.reduce((s, f) => s + f.borrar.length, 0)}, backfill: ${faltan.length}\n\n` +
    fusiones.map((f) => `## ${f.muni} ${f.day}\n- keeper: ${f.keeper}\n- borra: ${f.borrar.join(', ')}\n- orquestas: ${(f.merged.orquestas || []).join(' + ')}\n`).join('\n'));

  if (SECO) {
    console.log('\n--seco: sin escribir. Informe en .cache/dedup-informe-' + hoy + '.md');
    return;
  }
  let n = 0;
  for (const f of fusiones) {
    await put(`events/${f.keeper}`, f.merged);
    for (const b of f.borrar) await del(`events/${b}`);
    n += f.borrar.length;
  }
  for (const id of faltan) {
    const v = events[id];
    await put(`events/${id}`, { ...v, clave: v.clave || claveDe(v),
      fuentes: v.fuentes?.length ? v.fuentes : [v.fuente].filter(Boolean),
      estado: v.estado || 'activo' });
  }
  console.log(`\nAplicado: ${n} filas borradas, ${fusiones.length} keepers, ${faltan.length} backfill.`);
}

main().catch((e) => { console.error('FALLO:', e.message); process.exit(1); });
