// Parte un cartel transcrito (OCR/visión) en actos de verbena con su día.
// Sin dependencias del pipeline: revision-auto.mjs lo importa y la fase 2e
// crea un evento por acto (cada uno con su clave → sin duplicados).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const normD = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
// Normalización que CONSERVA la longitud (1:1) para partir el original por
// índices: los acentos tumbarían el match ("Sábado"≠"sabado" y el acto caería
// en el día anterior: todas las verbenas salían el 25).
const norm1 = (s) => String(s || '').toLowerCase()
  .replace(/[áàäâ]/g, 'a').replace(/[éèëê]/g, 'e').replace(/[íìïî]/g, 'i')
  .replace(/[óòöô]/g, 'o').replace(/[úùüû]/g, 'u').replace(/ñ/g, 'n');
const SEM_LUN = { lunes: 0, martes: 1, miercoles: 2, jueves: 3, viernes: 4, sabado: 5, domingo: 6 };
const MESES = { ene: 0, feb: 1, mar: 2, abr: 3, may: 4, jun: 5, jul: 6, ago: 7, sep: 8, oct: 9, nov: 10, dic: 11 };
const dmyDe = (d) => `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
// Confusiones típicas del tesseract en días de semana.
const WD_ALIAS = { viemes: 'viernes', vierne: 'viernes', savado: 'sabado', ubado: 'sabado', domindo: 'domingo', dominical: 'domingo' };
const WD_ALL = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'];
const wdNorm = (w) => { const n = normD(w); return WD_ALIAS[n] || (WD_ALL.includes(n) ? n : null); };

let ORQ = [];
try { ORQ = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'lib', 'data', 'orquestas.json'), 'utf8')).orquestas || []; } catch {}

/** Primera orquesta del diccionario mencionada en la línea (estricta). */
function orquestaEnLinea(s) {
  const hay = ' ' + normD(s).replace(/[^a-z]+/g, ' ') + ' ';
  for (const { nombre } of ORQ) {
    const low = normD(nombre).replace(/[^a-z]+/g, ' ').trim();
    if (!low) continue;
    if (low.includes(' ') ? hay.includes(' ' + low + ' ') : hay.split(' ').includes(low)) {
      return nombre.split(' (')[0];
    }
  }
  return null;
}

/** Secciones por cabecera de día (weekday con o sin número) + líneas con
 *  verbena/baile+orquesta+hora. El weekday sin número se resuelve hacia
 *  adelante desde refISO (los programas se publican antes de las fiestas).
 *  Devuelve [{day, hora, titulo, orquestas}]. */
export function extraerActos(textoCartel, refISO) {
  const actos = [];
  const t = String(textoCartel || '');
  if (!/verbena|gran baile|baile popular|orquesta/i.test(t)) return actos;
  // Marcas sobre el texto normalizado (misma longitud → índices válidos).
  const tn = norm1(t);
  const marks = [...tn.matchAll(/\b(lunes|martes|miercoles|jueves|viernes|viemes|sabado|ubado|domingo|dominical)\b/gi)];
  if (!marks.length) return actos;
  let ref = new Date(refISO);
  if (isNaN(ref)) ref = new Date();
  ref.setHours(12, 0, 0, 0);
  const masD = (base, n) => { const d = new Date(base); d.setDate(d.getDate() + n); return d; };
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  for (let i = 0; i < marks.length; i++) {
    const wd = wdNorm(marks[i][1]);
    if (!wd) continue;
    // "hasta el sábado 27" es fecha FIN dentro del texto, no cabecera de día.
    if (/hasta(\s+el)?\s*$/.test(tn.slice(Math.max(0, marks[i].index - 12), marks[i].index))) continue;
    const head = t.slice(marks[i].index, marks[i].index + 80).replace(/\d{1,2}:\d{2}/g, ' ');
    const body = t.slice(marks[i].index, i + 1 < marks.length ? marks[i + 1].index : undefined);
    let fecha = null;
    const m = normD(head).match(/(\d{1,2})\s*(de\s+([a-z]+))?/);
    if (m) {
      const dd = Number(m[1]);
      let mes = (m[3] && MESES[m[3].slice(0, 3)] !== undefined) ? MESES[m[3].slice(0, 3)] : null;
      if (mes === null) {
        // Día sin mes (o mes ilegible: "depliembre"): se prueba el mes de ref
        // y vecinos, quedándose el primero en ventana (nunca se pesca un mes
        // suelto del cuerpo: suele pertenecer a otra sección).
        const enVentana = (d) => d >= masD(ref, -1) && d <= masD(ref, 62);
        const c0 = new Date(ref.getFullYear(), ref.getMonth(), dd, 12);
        const c1 = new Date(ref.getFullYear(), ref.getMonth() + 1, dd, 12);
        const c_1 = new Date(ref.getFullYear(), ref.getMonth() - 1, dd, 12);
        fecha = enVentana(c0) ? c0 : enVentana(c1) ? c1 : c_1;
      } else {
        fecha = new Date(ref.getFullYear(), mes, dd, 12);
      }
      if (!fecha) fecha = new Date(ref.getFullYear(), ref.getMonth(), dd, 12);
      if (fecha < masD(ref, -1)) fecha.setFullYear(fecha.getFullYear() + 1);
    } else {
      const diff = (((SEM_LUN[wd] - ((ref.getDay() + 6) % 7)) % 7) + 7) % 7;
      fecha = masD(ref, diff);
    }
    ref = fecha;
    const f0 = new Date(fecha); f0.setHours(0, 0, 0, 0);
    if (f0 < hoy) continue;
    for (const lin of body.split('\n')) {
      const s = lin.trim().replace(/^[•\-*·—|>↓]+\s*/, '');
      if (s.length < 10 || s.length > 160) continue;
      const esVerbena = /verbena|gran baile|baile popular|baile de |noche (latina|en blanco)|latinazo|concierto bailable/i.test(s);
      if (!esVerbena && !(/orquesta/i.test(s) && /\d{1,2}:\d{2}/.test(s))) continue;
      // La hora real que ponga el cartel (15:00 vale igual que 23:00: sirve
      // para ordenar y para distinguir tarde/noche de la misma orquesta).
      const h = (s.match(/\d{1,2}:\d{2}/) || [])[0] || '';
      const orq = orquestaEnLinea(s);
      actos.push({ day: dmyDe(fecha), hora: h,
        titulo: s.slice(0, 90), orquestas: orq ? [orq] : [] });
    }
  }
  return actos;
}
