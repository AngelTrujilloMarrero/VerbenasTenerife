// Genera src/lib/data/calendario-fiestas.json desde los archives estáticos
// de DeBelingo (2024+2025): municipio -> meses calientes para priorizar la
// revisión de cuentas en pre-fiesta/temporada (ver PLANES.txt Plan D).
//
// Uso: node scripts/generar-calendario.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARCH = [2024, 2025].map((y) =>
  path.join(ROOT, '..', 'AdminDeBelingo', 'public', 'events-archive', `${y}.json`));
const OUT = path.join(ROOT, 'src', 'lib', 'data', 'calendario-fiestas.json');

const porMuni = {}; // muni -> { total, meses: {MM: n} }
for (const f of ARCH) {
  if (!fs.existsSync(f)) {
    console.error('Falta:', f);
    process.exit(2);
  }
  const crudo = JSON.parse(fs.readFileSync(f, 'utf8'));
  const evs = Array.isArray(crudo) ? crudo : crudo.events || [];
  for (const e of evs) {
    const muni = String(e.municipio || '').trim();
    const m = String(e.day || '').match(/^\d{4}-(\d{2})-\d{2}$/)?.[1];
    if (!muni || !m) continue;
    porMuni[muni] = porMuni[muni] || { total: 0, meses: {} };
    porMuni[muni].total++;
    porMuni[muni].meses[m] = (porMuni[muni].meses[m] || 0) + 1;
  }
}
// Meses calientes: los que concentran actividad (>=15% del total del municipio,
// mínimo 2 eventos para municipios con poco histórico).
const cal = {};
for (const [muni, d] of Object.entries(porMuni)) {
  const calientes = Object.entries(d.meses)
    .filter(([, n]) => n >= Math.max(2, d.total * 0.15))
    .sort((a, b) => b[1] - a[1])
    .map(([mm]) => mm);
  cal[muni] = { total: d.total, meses: d.meses, calientes };
}
fs.writeFileSync(OUT, JSON.stringify(
  { generadoEl: new Date().toISOString(), fuentes: ['2024.json', '2025.json'], municipios: cal }, null, 2));
const nMuni = Object.keys(cal).length;
const nEv = Object.values(porMuni).reduce((s, d) => s + d.total, 0);
console.log(`Calendario: ${nMuni} municipios, ${nEv} eventos 2024-25 → ${OUT}`);
for (const [muni, d] of Object.entries(cal).sort((a, b) => b[1].total - a[1].total).slice(0, 12)) {
  console.log(`  ${muni} (${d.total}): meses ${d.calientes.join(',')}`);
}
