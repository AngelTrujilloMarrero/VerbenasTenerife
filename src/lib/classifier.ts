// Patrones descubiertos en arona.org para distinguir verbenas de otros actos.
// Fase 1 barata (regex + diccionario), sin gastar cuota de IA.

export interface ScoredEvent {
  titulo: string;
  url: string;
  fechaLista: string;
  score: number;
  motivos: string[];
  esVerbena: boolean;
}

const TITULO_POS = /\b(baile|gran baile|verbena|verbenazo|megaverbena|tardeo|noche latina|noche boricua|baile de magos|romer[ií]a|orquesta|tributo|studio 54)\b/i;
const DESC_POS = /amenizado por|amenizan|orquestas?\s*:|orquestas?\s+[A-ZÁÉÍÓÚÑ]|gran baile|noche latina/i;
const HORA_NOCTURNA = /(2[0-3]|21):\d{2}/;

const ANTI_PATRON = /\b(beb[ée]cuento|exposici[óo]n|teatro|cuentos?|taller|flamenco.*poes[íi]a|misa|rosario|procesi[óo]n|rezo|bono comercio|filos[óo]fico|cuenta-?cuentos?)\b/i;

// Filtro histórico: 167 orquestas con >=2 actuaciones en 2024-25,
// generadas con scripts/extraer-orquestas.mjs desde los archives de DeBelingo.
import HIST from './data/orquestas.json';
const ORQ_HIST: { nombre: string; n: number }[] = (HIST as { orquestas: { nombre: string; n: number }[] }).orquestas;

const normHay = (s: string): string =>
  ' ' + s.toLowerCase().replace(/[.,;:()"'“”‘’¡!¿?]/g, ' ').replace(/\s+/g, ' ') + ' ';

/** ¿Menciona el texto alguna orquesta histórica? Devuelve "nombre (n)". */
function historicoEn(texto: string): string | null {
  const hay = normHay(texto);
  for (const { nombre, n } of ORQ_HIST) {
    const low = nombre.toLowerCase();
    // Nombre compuesto: inclusión directa; token único: con bordes.
    if (low.includes(' ') ? hay.includes(low) : hay.includes(' ' + low + ' ')) {
      return `${nombre} (${n})`;
    }
  }
  return null;
}

const ORQUESTAS_MANO = [
  'ruta salsera', 'toque latino', 'amanecer', 'shaila', 'falete',
  'wamampy', 'sabrosa', 'sensaci', 'caracas', 'tropin', 'malib',
  'ideales', 'maquinaria', 'frankie ruiz'
  // OJO: no meter genéricos tipo "tributo" (falso positivo en
  // "tributo a la película ENCANTO"); el contexto "Orquesta: Tributo" ya puntúa.
  // Ni "calle"/"plaza" sueltos (falsos positivos con callejero).
];

export function clasificarTitulo(titulo: string, fechaLista = ''): ScoredEvent {
  let score = 0;
  const motivos: string[] = [];

  if (TITULO_POS.test(titulo)) {
    score += 3;
    motivos.push(`título match: ${titulo.match(TITULO_POS)?.[0]}`);
  }
  // Una verbena real nunca es infantil/familiar: evita que "Feria infantil
  // con música, baile y..." cuele por la palabra baile.
  if (/\binfantil\b|\bfamiliar\b|beb[ée]cuento|hinchables?/i.test(titulo)) {
    score -= 4;
    motivos.push('penalización infantil/familiar');
  }
  if (ANTI_PATRON.test(titulo)) {
    score -= 5;
    motivos.push(`anti-patrón título: ${titulo.match(ANTI_PATRON)?.[0]}`);
  }
  const t = titulo.toLowerCase();
  const hist = historicoEn(titulo);
  if (hist) {
    score += 5;
    motivos.push(`orquesta histórica 2024-25 en título: ${hist}`);
  } else {
    for (const o of ORQUESTAS_MANO) {
      if (t.includes(o)) {
        score += 5;
        motivos.push(`orquesta conocida en título: ${o}`);
        break;
      }
    }
  }
  return { titulo, url: '', fechaLista, score, motivos, esVerbena: score >= 4 };
}

export function clasificarDetalle(titulo: string, descripcion: string, hora = '', lugar = ''): ScoredEvent {
  const base = clasificarTitulo(titulo);
  let { score, motivos } = base;

  if (DESC_POS.test(descripcion)) {
    score += 3;
    motivos.push(`descripción match: ${descripcion.match(DESC_POS)?.[0]}`);
  }
  if (ANTI_PATRON.test(descripcion.slice(0, 500))) {
    // Solo penaliza si el inicio es religioso/cultural puro; los programas
    // mixtos (Fiestas Mayores) mezclan misa+baile y se resuelven por línea.
    if (!/gran baile|amenizado/i.test(descripcion)) {
      score -= 3;
      motivos.push('descripción cultural/religiosa sin baile');
    }
  }
  const descLow = descripcion.toLowerCase();
  const histD = historicoEn(descripcion);
  if (histD && !motivos.some((m) => m.includes(histD.split(' (')[0]))) {
    score += 5;
    motivos.push(`orquesta histórica 2024-25 en detalle: ${histD}`);
  } else {
    for (const o of ORQUESTAS_MANO) {
      if (descLow.includes(o) && !motivos.some((m) => m.includes(o))) {
        score += 5;
        motivos.push(`orquesta conocida en detalle: ${o}`);
        break;
      }
    }
  }
  // La hora nocturna SOLO vale la del propio acto: mirar en el texto vecino
  // cuela el 21:00 de otro evento (caso Feria Infantil + Noche de Humor).
  // Sin hora propia se admite el texto cercano como último recurso.
  const horaNocturna = hora
    ? HORA_NOCTURNA.test(hora)
    : HORA_NOCTURNA.test(descripcion.slice(0, 500));
  if (horaNocturna) {
    score += 1;
    motivos.push('hora nocturna 20-23h');
  }
  if (/plaza|parque|recinto|casco/i.test(lugar)) {
    score += 1;
    motivos.push(`lugar verbena: ${lugar.slice(0, 60)}`);
  }
  return { titulo, url: base.url, fechaLista: '', score, motivos, esVerbena: score >= 4 };
}

// Los eventos "Grupo" (ej. Fiestas Mayores) traen N verbenas en un solo texto.
// Cada línea "HH:MM horas: Gran baile amenizado por Orquestas X e Y. Lugar: Z"
// se convierte en un candidato independiente.
export interface SubEvento {
  day: string;
  hora: string;
  titulo: string;
  orquestas: string[];
  lugar: string;
}

// Admite prefijo de lugar ("A las 16:00 horas En la Plaza del Cristo. TARDEO...")
// acotado a 1-3 palabras con mayúscula inicial para no comerse el título.
const LUGAR_PREVIO = String.raw`(?:en\s+la\s+(?:plaza|parque|cancha|calle|teatro|recinto|casa|auditorio)(?:\s+(?:del?|de\s+la))?(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){1,3}\s*\.?\s*)?`;
const LINEA_BAILE = new RegExp(
  String.raw`(\d{1,2}:\d{2})\s*(?:horas?|h)\b\s*\.?:?\s*` + LUGAR_PREVIO +
  String.raw`[–-]?\s*([^.\n]*?(?:gran baile|baile|verbena|verbenazo|tardeo|noche latina|noche boricua)[^.\n]*)\.?\s*(?:lugar:\s*([^.\n]+))?`,
  'gi'
);

export function extraerSubEventos(programaTexto: string): SubEvento[] {
  const out: SubEvento[] = [];
  let m: RegExpExecArray | null;
  // Resetea lastIndex por si se reutiliza la regex global
  LINEA_BAILE.lastIndex = 0;
  while ((m = LINEA_BAILE.exec(programaTexto)) !== null) {
    const [, hora, tituloRaw, lugarRaw] = m;
    const titulo = tituloRaw.trim();
    // Extrae "Orquestas X y Y" / "orquesta Los Ideales",
    // más fallback PDF: "Verbena con ... Grupo Pati, Atenia y la Orquesta Olimpia".
    // Se combinan ambos patrones sin duplicados.
    const orq: string[] = [];
    const patrones: { re: RegExp; coma: boolean }[] = [
      { re: /orquestas?\s*:?\s*([^.,;]+(?:y[^.,;]+)?)/i, coma: false },
      // "Verbena con ... Grupo Pati, Atenia y la Orquesta Olimpia" y
      // "MEGAVERBENAZO ... con ARMONÍA SHOW ..., LEDES DÍAZ, ...".
      // Estos SÍ admiten comas (luego se parte por coma/y).
      // El genérico exige mayúscula inicial SIN /i para no tragar frases.
      { re: /verbena\s+con\s+(?:la\s+actuaci[oó]n(?:es)?\s+de\s+|las\s+actuaciones\s+de\s+)?([^.;]{3,160})/i, coma: true },
      { re: /\bcon\s+(?:la\s+actuaci[oó]n(?:es)?\s+de\s+|las\s+actuaciones\s+de\s+)?([A-ZÁÉÍÓÚÑ][^.;]{3,160})/, coma: true }
    ];
    const limpia = (s: string): string => {
      let n = s.trim();
      for (let i = 0; i < 3; i++) {
        const pre = n.match(/^(la|las|los|el|orquesta|orquestas|grupo|grupos)\b\s*/i);
        if (!pre) break;
        n = n.slice(pre[0].length).trim();
      }
      return n;
    };
    const add = (raw: string): void => {
      const n = limpia(raw);
      if (n.length < 3) return;
      const dup = orq.some((o) => {
        const a = o.toLowerCase(), b = n.toLowerCase();
        return a === b || a.includes(b) || b.includes(a);
      });
      if (!dup) orq.push(n);
    };
    for (const { re, coma } of patrones) {
      const mo = titulo.match(re);
      if (!mo) continue;
      // Sin comas en la captura (patrón preciso): partir solo por "y".
      mo[1].split(coma ? /\s+y\s+|\s*,\s*/ : /\s+y\s+/).forEach(add);
    }
    out.push({ day: '', hora, titulo, orquestas: orq, lugar: (lugarRaw || '').trim() });
  }
  return out;
}

export const MESES: Record<string, string> = {
  enero: '01', febrero: '02', marzo: '03', abril: '04', mayo: '05', junio: '06',
  julio: '07', agosto: '08', septiembre: '09', setiembre: '09', octubre: '10',
  noviembre: '11', diciembre: '12'
};

export function mesANum(mes: string): string {
  const k = mes.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return MESES[k] || MESES[mes.toLowerCase()] || '';
}

// Programas multi-día ("Viernes 11 de septiembre ... Sábado 12 ..."):
// parte el texto por encabezado de día para heredar la fecha en cada baile.
// Pensado para escalar a los 31 aytos (Arona migrará a esto y jubilará su parche).
export interface SeccionDia {
  dia: number;
  mes: string;
  texto: string;
}

const HEADER_DIA = /(viernes|s[aá]bado|domingo|lunes|martes|mi[eé]rcoles|jueves)\s+(\d{1,2})\s+de\s+([a-záéíóúñ]+)/gi;

export function partirPorDias(programa: string): SeccionDia[] {
  const out: SeccionDia[] = [];
  const headers: { dia: number; mes: string; index: number }[] = [];
  let m: RegExpExecArray | null;
  HEADER_DIA.lastIndex = 0;
  while ((m = HEADER_DIA.exec(programa)) !== null) {
    headers.push({ dia: parseInt(m[2], 10), mes: m[3], index: m.index });
  }
  headers.forEach((h, i) => {
    const fin = i + 1 < headers.length ? headers[i + 1].index : programa.length;
    out.push({ dia: h.dia, mes: h.mes, texto: programa.slice(h.index, fin) });
  });
  return out;
}

// Contenedor probable de verbenas ("Fiestas de X", "Programa de actos"...):
// el título solo no puntúa pero hay que entrar al detalle a buscar bailes.
export function esContenedor(titulo: string): boolean {
  return /fiestas?|festejos|patronales|programa de actos|romer[ií]a/i.test(titulo);
}

export function tipoDeEvento(titulo: string): string {
  if (/baile de magos/i.test(titulo)) return 'Baile Magos';
  if (/romer[ií]a/i.test(titulo)) return 'Romería';
  if (/inclusiva/i.test(titulo)) return 'Inclusiva';
  if (/noche latina|noche boricua|tributo|studio 54|concierto|festival/i.test(titulo)) return 'Concierto';
  if (/baile|tardeo|verbena|verbenazo/i.test(titulo)) return 'Baile Normal';
  if (/fiestas mayores|fiestas de/i.test(titulo)) return 'Fiestas';
  return 'Otro';
}
