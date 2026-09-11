// Genera src/lib/data/orquestas.json desde los archives estáticos de DeBelingo.
// Uso: node scripts/extraer-orquestas.mjs [salida]
// Entradas: ../AdminDeBelingo/public/events-archive/{2024,2025}.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2] || path.join(root, '..', 'src', 'lib', 'data', 'orquestas.json');
const INS = [2024, 2025].map((y) =>
  path.join(root, '..', '..', 'AdminDeBelingo', 'public', 'events-archive', `${y}.json`));

// Una sola palabra solo vale si parece nombre propio (evita "Calle" de
// "Calle Prebendado Pacheco", "Plaza", "Grupo"...).
const SOLO_UNA = /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9.]{4,}$/;
const STOP = new Set(['calle', 'plaza', 'grupo', 'orquesta', 'orquestas', 'dj', 'duo', 'dúo',
  'los', 'las', 'la', 'el', 'the', 'tributo', 'show', 'live', 'tour', 'concierto',
  // Topónimos y genéricos que salen en cualquier programa o callejero
  'tenerife', 'canarias', 'canaria', 'canario', 'orotava', 'tejina', 'teresita',
  'laguna', 'tacoronte', 'adeje', 'arona', 'tegueste', 'santa', 'cruz', 'norte',
  'sur', 'isla', 'islas', 'concejales', 'concejal', 'isleño', 'isleños', 'isleña',
  'guayaba', 'relieve', 'acorde', 'dilema', 'revelación', 'revelacion',
  'salvapantallas', 'acontratiempo',
  // Nombres de pila sueltos (San Francisco, el concejal Sergio...): solo valen
  // dentro de nombre compuesto ("Pepe Benavente")
  'sergio', 'francisco', 'michael', 'mario', 'juanma', 'juancar', 'lucrecia',
  'elías', 'elias', 'falo', 'david', 'jose', 'pepe', 'juan', 'pedro', 'maria',
  'carmen', 'ana', 'luis', 'miguel', 'carlos', 'javier']);

const counts = new Map();
for (const f of INS) {
  if (!fs.existsSync(f)) {
    console.error('falta:', f);
    continue;
  }
  const evs = JSON.parse(fs.readFileSync(f, 'utf8')).events || [];
  for (const e of evs) {
    const campo = (e.orquesta || '').replace(/\s+/g, ' ').trim();
    if (!campo) continue;
    for (let parte of campo.split(/[,;/+&]+|\s+y\s+|\s+e\s+/i)) {
      parte = parte.replace(/\s+/g, ' ').trim().replace(/^[¿¡"'“”‘’(\[]+|[?!"'“”‘’)\].:;]+$/g, '').trim();
      if (!parte || /^\d+$/.test(parte)) continue;
      const low = parte.toLowerCase();
      if (!parte.includes(' ') && (!SOLO_UNA.test(parte) || STOP.has(low))) continue;
      if (STOP.has(low)) continue;
      counts.set(parte, (counts.get(parte) || 0) + 1);
    }
  }
}

// Recuerdo mínimo: 2 actuaciones en 2 años
const lista = [...counts.entries()]
  .filter(([, n]) => n >= 2)
  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'es'))
  .map(([nombre, n]) => ({ nombre, n }));

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ generado: new Date().toISOString().slice(0, 10), total: lista.length, orquestas: lista }, null, 1) + '\n');
console.log(`eventos usados, orquestas distintas totales: ${counts.size}, con >=2: ${lista.length} -> ${OUT}`);
for (const x of ['Filarmónica', 'filarm', 'encanto', 'Olimpia', 'Ledes', 'Toque Latino', 'Atenia', 'Bomba', 'Calle']) {
  const hit = lista.filter((o) => o.nombre.toLowerCase().includes(x.toLowerCase()));
  console.log(`chequeo "${x}":`, hit.length ? JSON.stringify(hit.slice(0, 5)) : 'ausente');
}
