// Importa la lista de seguidos (.cache/fb-seguidos.json) directamente a
// .cache/fb-cuentas.json, sin necesidad de tener el servidor Astro levantado.
//
// Clasifica automáticamente cada cuenta por tipo:
//   - ayuntamiento (aytos, concejalías, distritos)
//   - comision (comisiones de fiestas, comités, romerías, AAVV)
//   - orquesta (orquestas, grupos musicales, bandas, solistas, DJs)
//   - otro (medios, portales, varios)
//
// Asigna municipio si el nombre incluye alguno de los 31 municipios de Tenerife.
//
// Uso:
//   node scripts/importar-seguidos.mjs [--origen=.cache/fb-seguidos.json] [--sobrescribir]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k, v.join('=') || true];
  })
);

const ORIGEN = path.resolve(ROOT, String(args.origen || '.cache/fb-seguidos.json'));
const DESTINO = path.join(ROOT, '.cache', 'fb-cuentas.json');

const MUNICIPIOS_31 = [
  'Adeje', 'Arafo', 'Arico', 'Arona', 'Buenavista del Norte', 'Candelaria',
  'El Rosario', 'El Sauzal', 'El Tanque', 'Fasnia', 'Garachico',
  'Granadilla de Abona', 'La Guancha', 'Guía de Isora', 'Güímar',
  'Icod de los Vinos', 'La Matanza', 'La Orotava', 'Puerto de la Cruz',
  'Los Realejos', 'La Laguna', 'San Juan de la Rambla', 'San Miguel de Abona',
  'Santa Cruz de Tenerife', 'Santa Úrsula', 'Santiago del Teide', 'Tacoronte',
  'Tegueste', 'La Victoria', 'Vilaflor', 'Los Silos'
];

function normTxt(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function handleDeUrl(url) {
  try {
    const u = new URL(url.trim());
    if (!/facebook\.com$/i.test(u.hostname.replace(/^www\.|^m\.|^mbasic\./, ''))) return '';
    const parts = u.pathname.split('/').filter(Boolean);
    if (!parts.length) return '';
    const fbid = u.searchParams.get('fbid');
    if (fbid) return `fbid:${fbid}`;
    const pid = u.searchParams.get('id');
    if (/profile\.php/i.test(u.pathname) && pid) return `id:${pid}`;
    return parts.slice(0, 2).join('/');
  } catch {
    return '';
  }
}

function generarId(nombre) {
  const slug = nombre
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'cuenta';
  return `${slug}-${Date.now().toString(36)}`;
}

function clasificar(nombre) {
  const norm = normTxt(nombre);
  if (/ayuntami|ayto|alcaldia|concejalia|distrito|cabildo/i.test(norm)) return 'ayuntamiento';
  if (/comision|fiesta|fiestas|romeria|carnaval|aavv|asociacion|parranda|hermandad|cofradia|baile/i.test(norm)) return 'comision';
  if (/orquesta|band|banda|grupo|trio|duo|sound|music|musica|producciones|espectaculo|show|dj|sonora|cantante/i.test(norm)) return 'orquesta';
  return 'otro';
}

function detectarMunicipio(nombre) {
  const norm = ' ' + normTxt(nombre) + ' ';
  // 1. Coincidencia por nombre completo oficial (los más específicos/largos primero)
  const ordenados = [...MUNICIPIOS_31].sort((a, b) => normTxt(b).length - normTxt(a).length);
  for (const m of ordenados) {
    if (norm.includes(' ' + normTxt(m) + ' ')) return m;
  }
  // 2. Coincidencias específicas por toponimia de Tenerife
  if (norm.includes(' santa cruz ')) return 'Santa Cruz de Tenerife';
  if (norm.includes(' san miguel ')) return 'San Miguel de Abona';
  if (norm.includes(' icod ')) return 'Icod de los Vinos';
  if (norm.includes(' santiago del teide ') || norm.includes(' tamaimo ') || norm.includes(' puerto de santiago ')) return 'Santiago del Teide';
  if (norm.includes(' realejos ') || norm.includes(' realejo ') || norm.includes(' tigaiga ') || norm.includes(' icod el alto ')) return 'Los Realejos';
  if (norm.includes(' orotava ')) return 'La Orotava';
  if (norm.includes(' matanza ')) return 'La Matanza';
  if (norm.includes(' victoria ')) return 'La Victoria';
  if (norm.includes(' sauzal ')) return 'El Sauzal';
  if (norm.includes(' silos ')) return 'Los Silos';
  if (norm.includes(' buenavista ')) return 'Buenavista del Norte';
  if (norm.includes(' rosario ') || norm.includes(' la esperanza ')) return 'El Rosario';
  if (norm.includes(' granadilla ')) return 'Granadilla de Abona';
  if (norm.includes(' guia ') || norm.includes(' isora ') || norm.includes(' chio ')) return 'Guía de Isora';
  if (norm.includes(' rambla ')) return 'San Juan de la Rambla';
  if (norm.includes(' arico ') || norm.includes(' la listada ') || norm.includes(' las maretas ')) return 'Arico';
  if (norm.includes(' fasnia ') || norm.includes(' la zarza ') || norm.includes(' las eras ')) return 'Fasnia';
  if (norm.includes(' candelaria ') || norm.includes(' igueste de candelaria ')) return 'Candelaria';
  if (norm.includes(' guimar ') || norm.includes(' escobonal ')) return 'Güímar';
  if (norm.includes(' taganana ') || norm.includes(' almaciga ') || norm.includes(' valleseco ') || norm.includes(' san andres ')) return 'Santa Cruz de Tenerife';
  if (norm.includes(' tejina ') || norm.includes(' bajamar ') || norm.includes(' punta del hidalgo ') || norm.includes(' geneto ') || norm.includes(' valle jimenez ')) return 'La Laguna';
  return '';
}

function main() {
  if (!fs.existsSync(ORIGEN)) {
    console.error('No existe el fichero origen:', ORIGEN);
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(ORIGEN, 'utf8'));
  const lista = Array.isArray(raw) ? raw : (raw.seguidos || []);
  console.log(`Leídos ${lista.length} seguidos desde ${path.relative(ROOT, ORIGEN)}`);

  // Cargar cuentas existentes en .cache/fb-cuentas.json si existen
  let existentes = [];
  if (fs.existsSync(DESTINO) && !args.sobrescribir) {
    try {
      existentes = JSON.parse(fs.readFileSync(DESTINO, 'utf8'));
      if (!Array.isArray(existentes)) existentes = [];
    } catch {
      existentes = [];
    }
  }

  const porHandle = new Map(existentes.map((c) => [c.handle, c]));
  let nuevas = 0;
  let omitidas = 0;
  let yaExistian = 0;

  const ahora = Date.now();
  const resumenTipo = { ayuntamiento: 0, comision: 0, orquesta: 0, otro: 0 };

  for (const item of lista) {
    const nombre = (item.nombre || '').trim();
    const url = (item.url || '').trim();

    // Omitir perfil propio y enlaces internos de navegación de Facebook
    if (/editar perfil|solicitudes de amistad/i.test(nombre) ||
        url.includes('61587088775574') ||
        /\/friends\/?([?#]|$)/i.test(url)) {
      omitidas++;
      continue;
    }

    const handle = handleDeUrl(url);
    if (!handle) {
      omitidas++;
      continue;
    }

    if (porHandle.has(handle)) {
      yaExistian++;
      continue;
    }

    const tipo = clasificar(nombre);
    const municipio = detectarMunicipio(nombre);

    const nuevaCuenta = {
      id: generarId(nombre),
      nombre,
      url,
      handle,
      municipio,
      tipo,
      activa: true,
      createdAt: ahora,
      updatedAt: ahora
    };

    porHandle.set(handle, nuevaCuenta);
    resumenTipo[tipo]++;
    nuevas++;
  }

  const resultado = [...porHandle.values()].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  fs.mkdirSync(path.dirname(DESTINO), { recursive: true });
  fs.writeFileSync(DESTINO, JSON.stringify(resultado, null, 2));

  console.log(`\n✓ Importación finalizada con éxito en ${path.relative(ROOT, DESTINO)}:`);
  console.log(`  - Nuevas importadas: ${nuevas}`);
  console.log(`  - Ya existían previamente: ${yaExistian}`);
  console.log(`  - Descartadas (perfil propio / enlaces de menú): ${omitidas}`);
  console.log(`  - Total cuentas guardadas en monitor: ${resultado.length}`);
  console.log(`\nDesglose de cuentas importadas por tipo:`);
  console.log(`  🏛️  Ayuntamientos: ${resumenTipo.ayuntamiento}`);
  console.log(`  🎉 Comisiones y Fiestas: ${resumenTipo.comision}`);
  console.log(`  🎺 Orquestas y Grupos: ${resumenTipo.orquesta}`);
  console.log(`  📌 Otros: ${resumenTipo.otro}`);
}

main();
