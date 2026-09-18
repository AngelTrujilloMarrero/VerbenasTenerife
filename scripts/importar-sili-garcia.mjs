// Importa la agenda de Sili García (18/19/20-sep-2026) a Firebase `events`.
// Cada línea del post = un evento con su municipio, con la MISMA clave
// canónica de src/lib/dedup.ts (upsert: si el baile ya existe de otra
// fuente se fusiona en vez de duplicar). También sube la cuenta a
// `fb_cuentas` para el monitoreo constante.
//
// Uso: node scripts/importar-sili-garcia.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORQ_HIST = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'src', 'lib', 'data', 'orquestas.json'), 'utf8')).orquestas || [];

function envLocal(k) {
  if (process.env[k]) return process.env[k].trim();
  try {
    const m = fs.readFileSync(path.join(ROOT, '.env'), 'utf8').match(new RegExp(`^${k}=(.*)$`, 'm'));
    return (m?.[1] || '').trim();
  } catch { return ''; }
}
const DB = envLocal('PUBLIC_FIREBASE_DATABASE_URL')
  .replace(/\/$/, '');

const normTxt = (s) => String(s || '').toLowerCase().normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '');
const alnum = (s) => normTxt(s).replace(/[^a-z0-9]/g, '');
const STOP = new Set(['de', 'la', 'el', 'las', 'los', 'del', 'en', 'con', 'por',
  'una', 'uno', 'y', 'al', 'fin', 'gran', 'san', 'santa', 'fiesta', 'fiestas',
  'baile', 'verbena', 'orquesta', 'orquestas', 'grupo', 'grupos', 'plaza',
  'parque', 'recinto']);
function orquestaPrincipal(orquestas, titulo = '') {
  const hay = normTxt([...orquestas, titulo].join(' '));
  for (const { nombre } of ORQ_HIST) {
    const low = normTxt(nombre);
    if (!low) continue;
    if (low.includes(' ') ? ` ${hay} `.includes(` ${low} `) : ` ${hay} `.split(' ').includes(low)) {
      return alnum(nombre);
    }
  }
  return orquestas.length ? alnum(orquestas[0]).slice(0, 24) : '';
}
function slugTitulo(titulo, n = 5) {
  return normTxt(titulo).split(' ').filter((w) => w.length > 2 && !STOP.has(w)).slice(0, n).join('-');
}
// Paridad con claveDe() de src/lib/dedup.ts.
function claveDe(municipio, day, titulo, orquestas = []) {
  const m = normTxt(municipio).replace(/ /g, '');
  return `${m}|${day}|${orquestaPrincipal(orquestas, titulo) || slugTitulo(titulo)}`;
}
function idDeClave(clave) {
  let h1 = 0xdeadbeef;
  for (let i = 0; i < clave.length; i++) h1 = Math.imul(h1 ^ clave.charCodeAt(i), 2654435761);
  return 'fb-' + (h1 >>> 0).toString(36);
}

// [titulo, day, hora, municipio, lugar, orquestas[], urlPost]
const URL_VIE = 'https://www.facebook.com/sili.garcia/posts/pfbid0tzupab3ikmnWvpggQLXAwEmCAegMjaVaXQtc5kLRQ4habwQf4cgcLkiprKBfXQ37l';
const URL_SAB = 'https://www.facebook.com/sili.garcia/posts/pfbid07nLfuiqptWWCaY8stW6Rvs5a42LbMG5jHv7tQF9Nonn8Pu7qbVDbYNK1jWSYpJs3l';
const URL_DOM = 'https://www.facebook.com/sili.garcia/posts/pfbid0DYJcXUpdqpQZBZzFxtoPVLrajJ5fvmnoLhzocikyJfbFvxoAFiLUDPAS7kzKEq6kl';
const EV = [
  // Viernes 18-sep-2026
  ['Verbena en Icod de los Vinos con Tropin', '18-09-2026', '23:30', 'Icod de los Vinos', 'Icod de los Vinos', ['Tropin'], URL_VIE],
  ['Baile en Los Roques (Fasnia)', '18-09-2026', '23:00', 'Fasnia', 'Los Roques, Fasnia', ['Jose Zalba', 'Pepe Benavente'], URL_VIE],
  ['Gran Verbena en Fañabé', '18-09-2026', '22:30', 'Adeje', 'Fañabé, Adeje', ['Acapulco', 'Generación Zero', 'Pasión Gomera'], URL_VIE],
  ['Noche en Blanco en El Draguillo', '18-09-2026', '22:30', 'Santa Cruz de Tenerife', 'El Draguillo, Anaga', ['David Pérez', 'Saoco'], URL_VIE],
  ['Baile en El Palmar (Buenavista) con La Calle', '18-09-2026', '', 'Buenavista del Norte', 'El Palmar, Buenavista', ['La Calle'], URL_VIE],
  ['Baile en San Juan de la Rambla con Malibú Band', '18-09-2026', '21:30', 'San Juan de la Rambla', 'San Juan de la Rambla', ['Malibú Band'], URL_VIE],
  ['Baile en San José de los Llanos con Malibú Band', '18-09-2026', '01:00', 'El Tanque', 'San José de los Llanos, El Tanque', ['Malibú Band'], URL_VIE],
  ['Baile en Tacoronte con Maquinaria Band', '18-09-2026', '00:00', 'Tacoronte', 'Tacoronte', ['Maquinaria Band'], URL_VIE],
  ['Verbena en Benijos', '18-09-2026', '21:30', 'La Orotava', 'Benijos, La Orotava', ['Grupo LD', 'Wamampy'], URL_VIE],
  ['Baile en La Cruz Santa con Kimbara', '18-09-2026', '', 'Los Realejos', 'La Cruz Santa, Los Realejos', ['Kimbara'], URL_VIE],
  // Sábado 19-sep-2026
  ['Baile tras la Romería de San José (San Juan de la Rambla)', '19-09-2026', '19:00', 'San Juan de la Rambla', 'San José, San Juan de la Rambla', ['Kimbara', 'Malibú Band', 'Guaracha'], URL_SAB],
  ['Tardeo en Punta de Abona con parrandas', '19-09-2026', '17:00', 'Arico', 'Punta de Abona, Arico', ['Kilombo Improvisado', 'Parranda Mal País'], URL_SAB],
  ['Verbena en Punta de Abona', '19-09-2026', '22:45', 'Arico', 'Punta de Abona, Arico', ['Tropin', 'The Boys Machine'], URL_SAB],
  ['Verbena en Punta del Hidalgo', '19-09-2026', '23:00', 'La Laguna', 'Punta del Hidalgo, La Laguna', ['Dinacord', 'Acapulco'], URL_SAB],
  ['Baile en Camino El Tornero con David Pérez', '19-09-2026', '', 'La Laguna', 'Camino El Tornero, La Laguna', ['David Pérez'], URL_SAB],
  ['Verbena en Cueva Bermeja', '19-09-2026', '22:00', 'Santa Cruz de Tenerife', 'Cueva Bermeja, Anaga', ['David Pérez', 'Kadetes'], URL_SAB],
  ['Verbena en El Médano', '19-09-2026', '23:00', 'Granadilla de Abona', 'El Médano, Granadilla', ['La Calle', 'Joven Sensación'], URL_SAB],
  ['Verbena en Casas de la Cumbre (Anaga)', '19-09-2026', '19:00', 'Santa Cruz de Tenerife', 'Casas de la Cumbre, Anaga', ['José Manuel Hernández', 'Macacos', 'Fórmula Latina', 'Los Concejales'], URL_SAB],
  ['Baile Tacorontazo en Tacoronte con Tony Tun Tun', '19-09-2026', '23:50', 'Tacoronte', 'Tacoronte', ['Tony Tun Tun'], URL_SAB],
  ['Gran Verbena en Fañabé', '19-09-2026', '23:00', 'Adeje', 'Fañabé, Adeje', ['Sabrosa', 'Sensación Gomera', 'Atlantic'], URL_SAB],
  ['Verbena en El Lomo (Tegueste)', '19-09-2026', '21:00', 'Tegueste', 'El Lomo, Tegueste', ['Latin Sound', 'Atenia'], URL_SAB],
  ['Gran Verbena en Benijos', '19-09-2026', '20:00', 'La Orotava', 'Benijos, La Orotava', ['Son Sin Límite', 'Orquesta Tenerife', 'Arguayo Band'], URL_SAB],
  ['Baile en Los Roques (Fasnia)', '19-09-2026', '', 'Fasnia', 'Los Roques, Fasnia', ['Primera Marcha', 'Generación Zero'], URL_SAB],
  ['Verbena en El Tanque con Dorada Band', '19-09-2026', '23:00', 'El Tanque', 'El Tanque', ['Dorada Band'], URL_SAB],
  ['Verbena en La Hornera (Los Majuelos)', '19-09-2026', '23:00', 'La Laguna', 'Polideportivo de Los Majuelos, La Laguna', ['Columbia'], URL_SAB],
  ['Verbena en Icod (Plaza Andrés de Lorenzo) con Teymar', '19-09-2026', '23:30', 'Icod de los Vinos', 'Plaza Andrés de Lorenzo, Icod', ['Teymar'], URL_SAB],
  ['Baile en San José de los Llanos con Malibú Band', '19-09-2026', '00:00', 'El Tanque', 'San José de los Llanos, El Tanque', ['Malibú Band'], URL_SAB],
  ['Baile en El Palmar (Buenavista) con Saoco', '19-09-2026', '01:00', 'Buenavista del Norte', 'El Palmar, Buenavista', ['Saoco'], URL_SAB],
  ['Baile en El Draguillo', '19-09-2026', '20:00', 'Santa Cruz de Tenerife', 'El Draguillo, Anaga', ['Renzzo', 'Revelación', 'Corinto Band'], URL_SAB],
  ['Verbena en Guía de Isora con Edwin Rivera y Sabrosa', '19-09-2026', '00:00', 'Guía de Isora', 'Guía de Isora', ['Edwin Rivera', 'Sabrosa'], URL_SAB],
  // Domingo 20-sep-2026
  ['Bailes del mediodía en El Médano', '20-09-2026', '12:00', 'Granadilla de Abona', 'El Médano, Granadilla', ['Dorada Band', 'Sonora Olimpia', 'Maquinaria Band', 'Tropin', 'Malibú Band'], URL_DOM],
  ['Baile en Casas de la Cumbre (Anaga)', '20-09-2026', '16:00', 'Santa Cruz de Tenerife', 'Casas de la Cumbre, Anaga', ['Manuel Dorta', 'David Siverio', 'Samady Band'], URL_DOM],
  ['Tarde-noche de baile en Fañabé', '20-09-2026', '', 'Adeje', 'Fañabé, Adeje', ['Fernando Martín', 'Toque Latino'], URL_DOM],
  ['Baile del mediodía en El Draguillo', '20-09-2026', '15:00', 'Santa Cruz de Tenerife', 'El Draguillo, Anaga', ['Saoco', 'Clase Aparte'], URL_DOM],
  ['Baile de tarde en El Draguillo con Willy Melián', '20-09-2026', '20:30', 'Santa Cruz de Tenerife', 'El Draguillo, Anaga', ['Willy Melián'], URL_DOM],
  ['Fiesta del Bañador en Los Roques (Fasnia)', '20-09-2026', '14:00', 'Fasnia', 'Los Roques, Fasnia', ['Proyecto Joven'], URL_DOM],
  ['Baile en El Lomo (Tegueste) con Garajonay', '20-09-2026', '20:00', 'Tegueste', 'El Lomo, Tegueste', ['Garajonay'], URL_DOM],
];

async function main() {
  if (!DB) { console.error('Sin PUBLIC_FIREBASE_DATABASE_URL en .env'); process.exit(1); }
  const todo = await (await fetch(`${DB}/events.json`)).json() || {};
  const porClave = new Map();
  for (const [id, e] of Object.entries(todo)) {
    if (e?.clave && !porClave.has(e.clave)) porClave.set(e.clave, { id, e });
    if (e?.clave && e?.hora) porClave.set(e.clave + '|' + e.hora, { id, e });
  }
  let nuevos = 0, fusionados = 0;
  for (const [titulo, day, hora, municipio, lugar, orquestas, url] of EV) {
    const [dd, mm, yy] = day.split('-').map(Number);
    const clave = claveDe(municipio, day, titulo, orquestas);
    const marca = 'agenda de bailes en Facebook (Sili García)';
    let mapKey = clave;
    let hit = (hora && porClave.get(clave + '|' + hora)) || null;
    if (hit) mapKey = clave + '|' + hora;
    else {
      const base = porClave.get(clave);
      if (base && (!hora || !base.e.hora || base.e.hora === hora)) hit = base;
      else if (base && hora) mapKey = clave + '|' + hora;
    }
    if (hit) {
      const orqU = [...(hit.e.orquestas || [])];
      for (const o of orquestas) {
        if (!orqU.some((x) => alnum(x) === alnum(o))) orqU.push(o);
      }
      await fetch(`${DB}/events/${hit.id}.json`, { method: 'PATCH', body: JSON.stringify({
        orquestas: orqU,
        motivos: [...new Set([...(hit.e.motivos || []), marca])],
        fuentes: [...new Set([...(hit.e.fuentes || [hit.e.fuente].filter(Boolean)), 'facebook'])],
        score: Math.max(hit.e.score || 0, 6),
        ...(!hit.e.hora && hora ? { hora } : {}),
        actualizadoAt: Date.now() }) });
      porClave.set(mapKey, { id: hit.id, e: { ...hit.e, orquestas: orqU } });
      fusionados++;
      console.log(`✅ fusionado: ${day} ${titulo.slice(0, 55)} ← ${hit.id}`);
      continue;
    }
    const id = idDeClave(mapKey);
    const doc = { id, titulo, day, dayNum: yy * 10000 + mm * 100 + dd,
      hora: hora || '', municipio, lugar, orquestas, tipo: 'verbena', url,
      score: 6, motivos: [marca, 'keyword: baile', 'agenda multi-municipio'],
      fuente: 'facebook', fuentes: ['facebook'], clave, estado: 'activo',
      actualizadoAt: Date.now() };
    const r = await fetch(`${DB}/events/${id}.json`, { method: 'PUT', body: JSON.stringify(doc) });
    if (!r.ok) { console.error(`❌ PUT ${id}: HTTP ${r.status}`); continue; }
    porClave.set(mapKey, { id, e: doc });
    nuevos++;
    console.log(`🆕 nuevo: ${day} ${titulo.slice(0, 55)}`);
  }
  // Cuenta para el monitoreo constante (si ya está, se conserva su ritmo).
  try {
    const cuentas = await (await fetch(`${DB}/fb_cuentas.json?shallow=true`)).json() || {};
    let existe = false;
    for (const id of Object.keys(cuentas)) {
      const c = await (await fetch(`${DB}/fb_cuentas/${id}.json`)).json();
      if (c?.handle === 'sili.garcia') { existe = true; break; }
    }
    if (!existe) {
      const ahora = Date.now();
      const id = 'sili-garcia-' + ahora.toString(36);
      await fetch(`${DB}/fb_cuentas/${id}.json`, { method: 'PUT', body: JSON.stringify({
        id, nombre: 'Sili García', url: 'https://www.facebook.com/sili.garcia',
        handle: 'sili.garcia', municipio: '', tipo: 'otro', activa: true,
        ritmo: 'caliente', postsVistos: 10, fallosSeguidos: 0,
        ultimaActividad: ahora, createdAt: ahora, updatedAt: ahora }) });
      console.log(`📘 cuenta Sili García subida a fb_cuentas (${id})`);
    } else console.log('📘 cuenta Sili García ya estaba en fb_cuentas');
  } catch (e) { console.warn('fb_cuentas:', e.message); }
  console.log(`\nListo: ${nuevos} nuevos, ${fusionados} fusionados, ${EV.length} líneas procesadas.`);
}
main().catch((e) => { console.error('FALLO:', e.message); process.exit(1); });
