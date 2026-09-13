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

const TITULO_POS = /\b(baile|gran baile|gran verbena|verbena|verbenas|verbenazo|megaverbena|tardeo|concierto bailable|noche latina|noche boricua|noche en blanco|noche de kiosc?os|latinazo|baile de magos|baile de taifas?|baile de tarde|romer[ií]a|orquesta|tributo|studio 54)\b/i;
const DESC_POS = /amenizado por|amenizan|orquestas?\s*:|orquestas?\s+[A-ZÁÉÍÓÚÑ]|gran baile|noche latina/i;
const HORA_NOCTURNA = /(19|2[0-3]|21):\d{2}/;

const ANTI_PATRON = /\b(beb[ée]cuento|exposici[óo]n|teatro|cuentos?|taller|flamenco.*poes[íi]a|misa|rosario|procesi[óo]n|rezo|bono comercio|filos[óo]fico|cuenta-?cuentos?)\b/i;

// Trozos de JS/CSS colados ("function mostrarEventosPasados(){ $('#boto...").
export const RE_LUGAR_CODIGO = /[{}$#;]|function\s|=>|\bvar\s|\bconst\s|\blet\s/;

/** "Lugar: X" del texto, o fallback si está vacío o trae código colado. */
export function extraerLugar(cuerpo: string, fallback = ''): string {
  const m = cuerpo.match(/Lugar:\s*([^.]{3,80})/i)?.[1]?.trim() || '';
  if (!m || RE_LUGAR_CODIGO.test(m)) return fallback;
  return m;
}

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
  'ruta salsera', 'toque latino', 'toke latino', 'amanecer', 'shaila', 'falete',
  'wamampy', 'sabrosa', 'sensaci', 'caracas', 'tropin', 'malib',
  'ideales', 'maquinaria', 'frankie ruiz', 'kdtes'
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
  // Una verbena real nunca es infantil/familiar/mayores: evita que "Feria infantil
  // con música, baile y..." o "Baile de la tercera juventud" cuelen.
  if (/\binfantil\b|\bfamiliar\b|beb[ée]cuento|hinchables?|tercera edad|tercera juventud|\bmayores\b/i.test(titulo)) {
    score -= 4;
    motivos.push('penalización infantil/familiar/mayores');
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

export function clasificarDetalle(titulo: string, descripcion: string, hora = '', lugar = '', extra = 0): ScoredEvent {
  const base = clasificarTitulo(titulo);
  let { score, motivos } = base;
  if (extra) {
    score += extra;
    motivos.push(`mención explícita en programa (+${extra})`);
  }

  if (DESC_POS.test(descripcion)) {
    score += 3;
    motivos.push(`descripción match: ${descripcion.match(DESC_POS)?.[0]}`);
  }
  if (ANTI_PATRON.test(descripcion.slice(0, 500))) {
    // Solo penaliza si el inicio es religioso/cultural puro; los programas
    // mixtos (Fiestas Mayores) mezclan misa+baile y se resuelven por línea.
    // Y nunca veta menciones explícitas (extra>0): "Fiesta Joven y Verbena"
    // en un día con rosario a otra hora sigue siendo verbena.
    if (extra === 0 && !/gran baile|amenizado/i.test(descripcion)) {
      score -= 3;
      motivos.push('descripción cultural/religiosa sin baile');
    }
  }
  // Acto tradicional-religioso ("Baile de la Virgen y canto del Aleluya"):
  // aunque mencione "baile", sin música (orquesta/grupo/dj/parranda/amenizado)
  // en la línea no es verbena de orquesta.
  if (/virgen|aleluya|eucarist[íi]a|misa del pueblo/i.test(titulo) &&
      !/amenizado|orquesta|grupo|dj|parranda|tributo/i.test(titulo + ' ' + descripcion.slice(0, 300))) {
    score -= 6;
    motivos.push('penalización acto religioso-tradicional sin música');
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
    motivos.push('hora tarde-noche 19-23h');
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

// La hora puede venir sin "horas" ("23:00 - Gran Baile", lagenda).
// Sigue exigiendo keyword pegada a la hora para no tragar prosa.
// Admite prefijo de lugar ("A las 16:00 horas En la Plaza del Cristo. TARDEO...")
// acotado a 1-3 palabras con mayúscula inicial para no comerse el título.
const LUGAR_PREVIO = String.raw`(?:en\s+la\s+(?:plaza|parque|cancha|calle|teatro|recinto|casa|auditorio)(?:\s+(?:del?|de\s+la))?(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){1,3}\s*\.?\s*)?`;
const LINEA_BAILE = new RegExp(
  String.raw`(\d{1,2}:\d{2})\s*(?:(?:horas?|h)\b\s*\.?:?\s*)?` + LUGAR_PREVIO +
  String.raw`[–-]?\s*([^.\n]*?(?:gran baile|baile|verbena|verbenazo|tardeo|noche latina|noche boricua|noche en blanco|latinazo)[^.\n]*)\.?\s*(?:lugar:\s*([^.\n]+))?`,
  'gi'
);

export function extraerSubEventos(programaTexto: string): SubEvento[] {
  const out: SubEvento[] = [];
  // Viñetas de orquestas en líneas aparte ("orquestas:\n* Kimbara\n* ..."):
  // se unen con comas para que el extractor las vea en la misma línea.
  // Saltos en mitad de frase del OCR ("Magos\namenizado"): se unen solo
  // entre letras para no pegar líneas independientes.
  const texto = programaTexto
    .replace(/([A-Za-zÁÉÍÓÚÜÑáéíóúüñ])\n([a-záéíóúüñ])/g, '$1 $2')
    .replace(/\n\s*[*\-•]\s*/g, ', ');
  let m: RegExpExecArray | null;
  // Resetea lastIndex por si se reutiliza la regex global
  LINEA_BAILE.lastIndex = 0;
  while ((m = LINEA_BAILE.exec(texto)) !== null) {
    const [, horaRaw, tituloRaw, lugarRaw] = m;
    let hora = horaRaw;
    // El título puede arrastrar preámbulo ("con una verbena...", "se celebrará
    // una verbena..."): recortar hasta el primer keyword.
    let titulo = tituloRaw.trim().replace(/^[,\s:;·•\-–—]+/, '');
    // Mismo conjunto que LINEA_BAILE (incluido "baile" a secas), si no el
    // recorte no encontraba el keyword ("...se celebrará el baile de la Pamela").
    const ki = titulo.search(/gran baile|baile|verbena|verbenazo|tardeo|noche latina|noche boricua|noche en blanco|latinazo/i);
    if (ki > 0) {
      const prev = titulo.slice(0, ki);
      // El preámbulo suele traer la hora propia del acto ("...a las 15:00 horas
      // se celebrará el baile..."); prevalece sobre la hora de arranque (13:00).
      const horaPropia = [...prev.matchAll(/(\d{1,2}:\d{2})/g)].pop()?.[1];
      if (horaPropia) hora = horaPropia;
      // Conservar "Fiesta Joven y Verbena" entero (si no, duplicaría con el
      // path timeless que sí guarda el prefijo).
      const mF = prev.match(/fiesta(?:\s+\w+){0,2}\s+y\s*$/i);
      titulo = ((mF ? prev.slice(mF.index) : '') + titulo.slice(ki)).trim();
    }
    // "gala ... Escuela de Baile Kanachined": mención de escuela, no verbena.
    if (/(?:escuela|clase|clases|taller|exhibici[oó]n|concurso|academia|gimnasio)\s+de\s+baile/i.test(tituloRaw)) continue;
    // Feria infantil ("hinchables, juegos, música, baile y encuentro mágico").
    if (/hinchables|juegos infantiles|atracciones infantiles|parque infantil/i.test(tituloRaw) &&
        !/orquesta|verbena/i.test(tituloRaw)) continue;
    // Lista de actividades ("...combinará música, gastronomía, baile, ocio..."):
    // un título que empieza por "baile," no es un acto.
    if (/^baile\s*[,:]/i.test(titulo)) continue;
    out.push({ day: '', hora, titulo, orquestas: extraerOrquestas(titulo), lugar: (lugarRaw || '').trim() });
  }
  return out;
}

/** Nombres de orquestas/artistas dentro de un título ("...con X, Y y Z").
 *  Combina patrón preciso ("Orquestas X") + fallbacks con comas, sin duplicados. */
export function extraerOrquestas(titulo: string): string[] {
    // Extrae "Orquestas X y Y" / "orquesta Los Ideales",
    // más fallback PDF: "Verbena con ... Grupo Pati, Atenia y la Orquesta Olimpia".
    // Se combinan ambos patrones sin duplicados.
    const orq: string[] = [];
    // coma=true parte por coma+y; coma='solo-coma' parte por comas y ·/•
    // ("Orquesta La Sabrosa y Nueva Línea" es UNA orquesta, no dos).
    const patrones: { re: RegExp; coma: boolean | 'solo-coma' }[] = [
      // Preciso: "Orquesta(s) X..." + resto ("Orquestas Kimbara, The Boys
      // Machine y Samady"). Exige minúscula/marca tras el nombre para no
      // tragar la hora ("Orquesta Revelación. 23:00 + resto").
      // SIN /i a propósito: con insensible, `\s+[a-z]` casa " Palabra" y
      // el nombre se corta a la primera ("Swing Latinos" -> "Swing").
      // El genérico (mayúscula) cubre el resto.
      { re: /[Oo][Rr][Qq][Uu][Ee][Ss][Tt][Aa]s?\s+((?:la\s+|el\s+|los\s+|las\s+)?[A-ZÁÉÍÓÚÑ][^.,;]{2,120}?)(?=\s+[a-záéíóúñ(,]|\s*,\s*|\s*\.\s|\s*$|\s+y\s+[A-ZÁÉÍÓÚÑ])/, coma: 'solo-coma' },
      // "Verbena con/a cargo de ... Grupo Pati, Atenia y la Orquesta Olimpia" y
      // "MEGAVERBENAZO ... con ARMONÍA SHOW ..., LEDES DÍAZ, ...".
      // Estos SÍ admiten comas (luego se parte por coma/y).
      // El genérico exige mayúscula inicial SIN /i para no tragar frases.
      { re: /verbena\s+(?:con|a\s+cargo\s+de)\s+(?:la\s+actuaci[oó]n(?:es)?\s+de\s+|las\s+actuaciones\s+de\s+)?([^.;]{3,160})/i, coma: true },
      { re: /(?:ameniza|anima)(?:do|da|dos|das)\s+por\s+([^.;]{3,160})/i, coma: true },
      // "Noche de kioscos con las actuaciones de (la) ORQUESTA TEYMAR, ...":
      // con artículo intercalado ("de la ORQUESTA") o solo DJs ("de la DJ
      // BELÉN JURADO, ..."). Exige marca musical en la captura para no traer
      // escuelas/talleres ("actuación de la Escuela de Folclore").
      { re: /actuaciones?\s+de\s*:?\s*(?:la\s+|las\s+|los\s+|el\s+)?(?=[^.;]{0,60}(?:orquesta|grupo|banda|\bdj\b|parranda|tributo))([^.;]{3,160})/i, coma: true },
      { re: /\bcon\s+(?:las?\s+|los\s+|el\s+|la\s+)?(?:la\s+actuaci[oó]n(?:es)?\s+de\s+|las\s+actuaciones\s+de\s+)?(?:(?:la\s+|las\s+|los\s+|el\s+)?orquestas?\s*:?\s*)?([A-ZÁÉÍÓÚÑ][^.;]{3,160})/, coma: true }
    ];
    const limpia = (s: string): string => {
      // Fuera paréntesis ("(taller de salsa...)", "(tributo a ...)") y comillas
      // y prefijos de tanda ("00:00-1:30 Orquesta Tropin" -> "Orquesta Tropin")
      // y puntuación inicial (", con una gran verbena..." -> "con una gran...")
      let n = s.replace(/\([^()]*\)/g, ' ').trim()
        .replace(/^\d{1,2}:\d{2}\s*(-\s*\d{1,2}:\d{2})?\s*/, '')
        .replace(/^[¿¡"'“”‘’(\[:;,·•\-–—\]]+|[?!"'“”‘’)\].:;]+$/g, '').trim();
      for (let i = 0; i < 3; i++) {
        const pre = n.match(/^(la|las|los|el|orquesta|orquestas|grupo|grupos)\b\s*/i);
        if (!pre) break;
        const rest = n.slice(pre[0].length).trim();
        // No dejar "Grupo La Calle" en "Calle" a secas (luego parece callejero)
        if (!rest.includes(' ') && /^(calle|plaza|parque|avenida|teatro)$/i.test(rest)) break;
        n = rest;
      }
      return n;
    };
    // Lugares colados como "orquesta" ("Plaza de San Marcos", "Calle") y
    // topónimos sueltos ("Tenerife") y frases administrativas, no artistas.
    const ES_LUGAR = /plaza|plazola|parque|cancha|calle|callej[oó]n|teatro|iglesia|plazoleta|avenida|polideportivo|recinto|campo|pabell[oó]n|auditorio|ermita|parroquia|^(tenerife|canaria|canarias|isla|islas|sur|norte)$/i;
    const ES_ADMIN = /entrega|premios?|nombramiento|comisi[oó]n|sorteo|rifa|descanso|trofeo|homenaje/i;
    const add = (raw: string): void => {
      // Si venía de contexto musical ("Grupo La Calle") se conserva aunque
      // parezca callejero; sin contexto ("Plaza de San Marcos" suelta) fuera.
      const musicCtx = /orquesta|grupo|parranda|tributo|banda|d[uú]o|\bdj\b/i.test(raw);
      const n = limpia(raw);
      if (n.length < 3 || ES_ADMIN.test(n)) return;
      // Colas subordinadas coladas al partir ("...que pondrán ritmo..."):
      // no son nombres. Y sin una mayúscula no es nombre propio.
      if (/^(que|para|porque|donde|cuando|como|sin)\b/i.test(n)) return;
      if (!/[A-ZÁÉÍÓÚÑ]/.test(n)) return;
      // Fragmentos horarios colados al partir ("... Dorada Band, a las 22:00h")
      if (/^(?:a\s+las?\s+|de\s+|desde\s+las?\s+|a\s+partir\s+de\s+las?\s+)?\d{1,2}(?::\d{2})?\s*h(?:oras)?\.?$/i.test(n)) return;
      if (/^(?:a\s+las?\s+|de\s+|desde\s+las?\s+)\d/i.test(n)) return;
      if (!musicCtx && ES_LUGAR.test(n)) return;
      // Comparación sin acentos: "Pati" y "Patí" son el mismo grupo
      const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const dup = orq.some((o) => {
        const a = norm(o), b = norm(n);
        return a === b || a.includes(b) || b.includes(a);
      });
      if (!dup) orq.push(n);
    };
    for (const { re, coma } of patrones) {
      const mo = titulo.match(re);
      if (!mo) continue;
      // Con comas: pelar paréntesis ANTES de partir, si no el split por "y"
      // los rompe ("(taller de salsa Academia Ada y Belén)" -> fragmentos).
      const base = coma ? mo[1].replace(/\([^()]*\)/g, ' ') : mo[1];
      // Sin comas en la captura (patrón preciso): partir solo por "y".
      // También se parte por ·/• ("00:00-1:30 Orquesta Tropin · 1:30 Pepe...")
      // y por "además de" ("...Revelación, además de DJ Fabrizio" -> DJ aparte).
      const partes = coma === 'solo-coma'
        ? base.split(/\s*,\s*|\s*[·•]\s*/)
        : base.split(coma ? /\s+y\s+|\s*,\s*(?:y\s+)?|\s*[·•]\s*|\s*,?\s*adem[aá]s\s+(?:de\s+)?/i : /\s+y\s+/);
      partes.forEach(add);
    }
    return orq;
}

// Bailes sin hora ("...y a su finalización una verbena a cargo de Grupo La Calle"):
// dos niveles: CON música (orquesta/grupo/banda/dj...) y mención EXPLÍCITA
// ("Fiesta Joven y Verbena") aunque no nombre artista. Se excluyen crónicas
// en pasado ("la verbena fue un éxito").
// Ampliado con marcas locales verificadas: "tardeo" (genérico), "fiesta
// canaria" (Icod: cierra con orquestas), "noche de kioscos" (Icod: noches
// de verbena con orquesta+DJs), "fiesta joven" y "baile con" (Güímar: "Baile
// con la Orquesta X", "Fiesta Joven con ... Renzzo El Selector y Dj").
// La extracción solo propone; el clasificador (>=4) sigue filtrando.
const TIENE_MUSICA = /orquesta|grupo|banda|dj|parranda|\bson\b|tributo|latin|band\b/i;
// OJO \b no casa tras vocal acentuada ("reunió\b" nunca matchea en JS):
// se testea sobre el título normalizado (sin acentos).
const EN_PASADO_NORM = /\b(fue|fueron|tuvo|hubo|han sido|se celebro|fueron un exito|reunio|reunieron|disfruto|disfrutaron|acogio|congrego|congregaron)\b/;
const LINEA_SIN_HORA = /(?:((?:fiesta|gran fiesta|fiesta joven)\s+y\s+))?(gran baile|gran verbena|gran verbenazo|baile popular|verbena|verbenas|verbenazo|megaverbena|baile de magos|baile de taifas?|baile de tarde|concierto bailable|tardeo|fiesta canaria|fiesta joven|noche de kioscos|noche en blanco|latinazo|baile\s+(?:al ritmo|amenizad[oa]s?|a cargo|con))\b([^.\n]{0,180}?)(?=[.]|$|\n)/gi;
const DIAS_CORTE = /\s+(?:el\s+)?(?:lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo)\b/i;

export interface BaileSinHora {
  titulo: string;
  orquestas: string[];
  explicita: boolean;
  hora: string;
}

/** Hora del baile sin hora explícita:
 *  1) si el propio título la trae ("a partir de las 22:30"), esa;
 *  2) si no, ÚLTIMO rango previo ("...21:30... 23:00 a 05:00..." -> 23:00);
 *  3) si no, última hora suelta previa; 4) primera hora posterior cercana. */
export function horaPrevia(texto: string, titulo: string, radio = 400): string {
  const enTitulo = titulo.match(/(\d{1,2}:\d{2})/);
  if (enTitulo) return enTitulo[1];
  const idx = posEn(texto, titulo);
  const prev = idx === -1 ? texto.slice(0, radio) : texto.slice(Math.max(0, idx - radio), idx);
  const rangos = [...prev.matchAll(/(\d{1,2}:\d{2})\s*a(?:\s*las)?\s*\d{1,2}:\d{2}/gi)].map((x) => x[1]);
  if (rangos.length) return rangos[rangos.length - 1];
  const sueltas = [...prev.matchAll(/(\d{1,2}:\d{2})/g)].map((x) => x[1]);
  if (sueltas.length) return sueltas[sueltas.length - 1];
  const post = idx === -1 ? '' : texto.slice(idx, idx + 120);
  return post.match(/(\d{1,2}:\d{2})/)?.[1] || '';
}

export function extraerBailesSinHora(textoOriginal: string): BaileSinHora[] {
  const out: BaileSinHora[] = [];
  // El punto de una abreviatura ("St. Pedro") cortaba el título en seco;
  // se elimina solo el punto (la abreviatura se conserva).
  // Viñetas de orquestas en líneas aparte ("orquestas:\n* Kimbara\n* ..."):
  // se unen con comas para que el extractor las vea en la misma línea.
  const texto = textoOriginal
    .replace(/\b(St|Sta|Sr|Sra|Srt|Dr|Dra|D|Ntra|Ntro|Gral|Cnel|Avda)\.(?=\s)/gi, '$1')
    .replace(/([A-Za-zÁÉÍÓÚÜÑáéíóúüñ])\n([a-záéíóúüñ])/g, '$1 $2')
    .replace(/\n\s*[*\-•]\s*/g, ', ');
  let m: RegExpExecArray | null;
  LINEA_SIN_HORA.lastIndex = 0;
  while ((m = LINEA_SIN_HORA.exec(texto)) !== null) {
    let titulo = ((m[1] || '') + ' ' + m[2] + ' ' + (m[3] || '')).trim().replace(/\s+/g, ' ')
      .replace(/^[,\s:;·•\-–—]+/, '');
    // Corta si cruza al día siguiente ("Verbena y el domingo con...") y
    // conectores colgando ("Verbena y" -> "Verbena")
    titulo = titulo.split(DIAS_CORTE)[0].replace(/\s+(y|con|de|del|el|la|los|las|e)\s*$/i, '').trim();
    if (EN_PASADO_NORM.test(normSin(titulo))) continue;
    const orquestas = extraerOrquestas(titulo);
    // Mención vaga sin música ni desarrollo ("Verbena" a secas): fuera
    if (titulo.length < 12 && !orquestas.length) continue;
    out.push({ titulo, orquestas, explicita: !TIENE_MUSICA.test(titulo), hora: horaPrevia(texto, titulo) });
  }
  // Bailes ofuscados: sin keyword de baile pero con ORQUESTA HISTÓRICA
  // (2024-25) en contexto musical ("Actuaciones de las orquestas Pasión
  // Gomera..."). La extracción solo propone; el clasificador (>=4) filtra.
  for (const propuesta of extraerBailesPorOrquesta(texto)) {
    if (!out.some((x) => x.titulo === propuesta.titulo)) out.push(propuesta);
  }
  return out;
}

const escRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface NombreOrquesta { nombre: string; re: RegExp }

let NOMBRES_ORQ: NombreOrquesta[] | null = null;

/** Nombres históricos compilados una vez (misma semántica que su
 *  consumidor: HIST como historicoEn —compuesto inclusión, token bordes—;
 *  lista manual por inclusión como el `includes` de clasificarDetalle,
 *  para que los stems (`malib`, `sensaci`) sigan cazando). */
function nombresOrquesta(): NombreOrquesta[] {
  if (NOMBRES_ORQ) return NOMBRES_ORQ;
  NOMBRES_ORQ = [];
  const mete = (nombre: string, bordes: boolean): void => {
    const low = normSin(nombre);
    const re = !bordes
      ? new RegExp(escRe(low), 'i')
      : new RegExp(`(^|[\\s"“”'(\\[]+)${escRe(low)}(?=$|[\\s"”').,;:!?])`, 'i');
    NOMBRES_ORQ!.push({ nombre, re });
  };
  for (const { nombre } of ORQ_HIST) mete(nombre, !nombre.includes(' '));
  for (const o of ORQUESTAS_MANO) {
    if (!NOMBRES_ORQ.some((x) => x.nombre.toLowerCase() === o)) mete(o, false);
  }
  return NOMBRES_ORQ;
}

const normSin = (s: string): string =>
  s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

// Contexto musical mínimo para que el nombre no sea prosa ("al amanecer").
// Rescate religioso solo con baile explícito; escuelas/talleres e
// infantil/mayores nunca son verbena aunque toquen históricos.
const CTX_MUSICA = /orquesta|grupo|parran|banda|\bdj\b|tributo|actuaci|ameniz|concierto|festival|verbena|baile|m[uú]sica|musical|\bnoche\b|\btarde\b/i;
const CTX_RELIGIOSO = /misa|eucarist|procesi|rosario|funeral|entierro|parroquia|capilla|vigilia/i;
const CTX_BAILE = /baile|verbena|verbenazo|tardeo|tributo|concierto|festival/i;
const CTX_DESCARTE = /escuela|academia|taller|concurso|exhibici|certamen|infantil|ni[nñ]os?|beb[eé]s?|tercera edad|mayores|jubilados?|electr[oó]genos/i;
// Titulares deportivos ("MILLA EN PISTA • 18:00 ... Orquesta X" en la misma
// línea del programa): la carrera no es verbena aunque cite orquestas.
const CTX_DEPORTE = /^(milla|marat[oó]n|media marat[oó]n|carrera|torneo|campeonato|partido|trail|cross|ciclismo|cicloturista|senderismo|regata|nataci[oó]n|triatl[oó]n|baloncesto|futbol|f[uú]tbol|lucha canaria)\b/i;

/** Frases con orquesta histórica en contexto musical, aunque no nombren
 *  ningún baile. Devuelve la frase como título para que puntúe. */
export function extraerBailesPorOrquesta(texto: string): BaileSinHora[] {
  const out: BaileSinHora[] = [];
  const frases = texto.split(/(?<=[.\n!?])\s+/);
  for (const f of frases) {
    const frase = f.trim().replace(/\s+/g, ' ');
    if (frase.length < 20) continue;
    if (!CTX_MUSICA.test(frase)) continue;
    if (EN_PASADO_NORM.test(normSin(frase))) continue;
    if (CTX_RELIGIOSO.test(frase) && !CTX_BAILE.test(frase)) continue;
    if (CTX_DESCARTE.test(frase)) continue;
    const norm = normSin;
    // Todos los históricos de la frase (lineup completo), no solo el primero.
    const hallados = nombresOrquesta().filter(({ re }) => re.test(normSin(frase)));
    if (!hallados.length) continue;
    // Fuera número de página pegado ("8 17:30 horas - Plaza..." -> "17:30...").
    const titulo0 = frase.length > 180 ? frase.slice(0, 180).replace(/\s+\S*$/, '').trim() : frase;
    const titulo = titulo0.replace(/^\d{1,3}\s+(?=\d{1,2}:\d{2})/, '').trim();
    if (CTX_DEPORTE.test(titulo)) continue;
    const vistos = new Set<string>();
    const orq: string[] = [];
    for (const { nombre } of hallados) {
      const nn = norm(nombre);
      if ([...vistos].some((v) => v === nn || v.includes(nn) || nn.includes(v))) continue;
      vistos.add(nn);
      orq.push(nombre);
    }
    for (const o of extraerOrquestas(frase)) {
      const no = norm(o);
      if ([...vistos].some((v) => v === no || v.includes(no) || no.includes(v))) continue;
      vistos.add(no);
      orq.push(o);
    }
    out.push({ titulo, orquestas: orq, explicita: false, hora: horaPrevia(texto, titulo) });
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

/** "21.30h" -> "21:30", "09.00 horas" -> "09:00". Solo con h/horas detrás
 *  para no tocar versiones ni decimales ("v2.0", "3.50 €" quedan igual). */
export function normalizarHoras(texto: string): string {
  return texto.replace(/(\b\d{1,2})\.(\d{2})(?=\s*h\b|\s*horas\b)/gi, '$1:$2');
}

/** Mes+año del contexto del documento ("TACORONTE · SEPTIEMBRE 2026"). */
export function mesContexto(texto: string): { mes: string; anyo: string } {
  const m = texto.match(/\b(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\b\s*(20\d{2})/i);
  if (!m) return { mes: '', anyo: '' };
  return { mes: mesANum(m[1]), anyo: m[2] };
}

/** Posición aproximada del título en el texto: prueba prefijos cada vez más
 *  cortos porque el join de grupos regex mete espacios ("baile , a"). */
export function posEn(texto: string, titulo: string): number {
  for (const n of [30, 22, 14, 10]) {
    const idx = texto.indexOf(titulo.slice(0, n));
    if (idx !== -1) return idx;
  }
  return -1;
}

/** Ventana de contexto alrededor de la línea: evita que puntúen datos
 *  de otros actos del mismo programa (orquestas, horas vecinas). */
export function ventana(texto: string, titulo: string, radio = 600): string {
  const idx = posEn(texto, titulo);
  if (idx === -1) return texto.slice(0, 1200);
  return texto.slice(Math.max(0, idx - radio), idx + titulo.length + radio);
}

// Recintos con nombre propio ("Plaza de San Marcos", "Cancha El Lomo").
// Sin "Calle" a secas: suele ser callejero ("Calle Tordo"), no recinto.
// [ \t] y no \s: un salto de línea NO puede formar parte del nombre.
// Añadidos Atrio/Caserío/Ermita-parroquia (Güímar: "Atrio de San Pedro",
// "Caserío de El Socorro") y variantes con "de" para Escenario/Campo/Calle/Casa.
const RE_LUGAR = /(Plaza[ \t]+(?:de[ \t]+|del[ \t]+)?[^.\n,]{2,40}|Parque[ \t]+[^.\n,]{2,40}|Cancha[ \t]+[^.\n,]{2,40}|Recinto[ \t]+[^.\n,]{2,40}|Auditorio[ \t]+[^.\n,]{2,40}|Teatro[ \t]+[^.\n,]{2,40}|Pabell[oó]n[ \t]+[^.\n,]{2,40}|Polideportivo[ \t]+[^.\n,]{2,40}|Mercado[ \t]+[^.\n,]{2,40}|Iglesia[ \t]+[^.\n,]{2,40}|Ermita[ \t]+[^.\n,]{2,40}|Escenario[ \t]*(?:de[ \t]+|del[ \t]+)?[^.\n,]{0,40}|Campo[ \t]+(?:de[ \t]+|del[ \t]+)?[^.\n,]{2,40}|Calle[ \t]+[^.\n,]{2,40}|Casa[ \t]+[^.\n,]{2,40}|Atrio[ \t]+(?:de[ \t]+|del[ \t]+)?[^.\n,]{2,40}|Caser[ií]o[ \t]+(?:de[ \t]+|del[ \t]+)?[^.\n,]{2,40})/gi;
// "Casco" aparte y SIN /i: con insensible cazaría "casco histórico con la
// participación..." (minúsculas). Solo vale con nombre propio en mayúscula.
const RE_LUGAR_CASCO = /(Casco[ \t]+(?:de\s+|del\s+)?[A-ZÁÉÍÓÚÑ][^.\n,]{0,30})/g;

// Rutas, no recintos ("procesión desde la iglesia hasta el muelle").
const RE_LUGAR_MALO = /\b(hasta|desde|hacia|recorrido|trayecto|salida|llegada|acompa\w*|itinerario|recorrido)\b/i;

// El recinto debe llevar nombre propio en mayúscula ("Plaza Andrés", "Plaza
// de la Pila"); si no caza prosa ("llenar la plaza de carcajadas").
const RE_LUGAR_PROPIO = /^\S+\s+(?:de\s+|del\s+)?(?:la\s+|el\s+|los\s+|las\s+)?[A-ZÁÉÍÓÚÑ]/;

/** Recinto mencionado JUSTO DESPUÉS del título ("...verbena, que se
 *  celebrará en la plaza X..."): lugarCercano solo mira hacia atrás. */
export function lugarPosterior(seccion: string, titulo: string, radio = 200): string {
  const idx = seccion.lastIndexOf(titulo.slice(0, 30));
  if (idx === -1) return '';
  const post = seccion.slice(idx + titulo.length, idx + titulo.length + radio);
  const m = post.match(/(Recinto|Parque|Plaza|Pabell[oó]n|Auditorio|Teatro|Terrero|Casa|Cancha|Mercado|Iglesia|Ermita)[ \t]+[^.\n,]{2,50}/);
  if (!m) return '';
  const cand = m[0].trim();
  if (!/^\S+\s+(?:de\s+|del\s+)?(?:la\s+|el\s+|los\s+|las\s+)?[A-ZÁÉÍÓÚÑ]/.test(cand)) return '';
  return recortarProsa(cand);
}

/** Último recinto válido mencionado antes del título (el más cercano a la línea). */
export function lugarCercano(seccion: string, titulo: string, radio = 400): string {
  const idx = posEn(seccion, titulo);
  const prev = idx === -1 ? seccion.slice(0, 600) : seccion.slice(Math.max(0, idx - radio), idx);
  let m: RegExpExecArray | null;
  let ultimo = '';
  let ultimoIdx = -1;
  const considera = (re: RegExp) => {
    re.lastIndex = 0;
    while ((m = re.exec(prev)) !== null) {
      const cand = m[1].trim();
      if (!RE_LUGAR_MALO.test(cand) && RE_LUGAR_PROPIO.test(cand) && m.index >= ultimoIdx) {
        ultimo = cand;
        ultimoIdx = m.index;
      }
    }
  };
  considera(RE_LUGAR);
  considera(RE_LUGAR_CASCO);
  if (ultimo) {
    // Corta la hora pegada del stream del PDF ("Plaza Andrés de Lorenzo
    // Cáceres 13:30h – ..."): un recinto nunca termina en hora.
    ultimo = ultimo.replace(/\s+\d{1,2}:\d{2}h?\b.*$/, '').trim();
    // Corta la prosa pegada ("...Cáceres Gran concierto del cantante..."):
    // a partir de 20 caracteres, "Mayúscula minúscula" ya no es el nombre.
    ultimo = recortarProsa(ultimo);
    // Colapsa cabeceras repetidas del PDF ("Plaza del Cristo de Tacoronte
    // Plaza del Cristo de" -> "Plaza del Cristo de Tacoronte").
    const head = ultimo.match(/^\w+/)?.[0] || '';
    if (head) {
      const rep = ultimo.search(new RegExp(`\\b${head}\\b`, 'i'));
      const second = rep >= 0 ? ultimo.slice(rep + head.length).search(new RegExp(`\\b${head}\\b`, 'i')) : -1;
      if (second >= 0) ultimo = ultimo.slice(0, rep + head.length + second).trim();
    }
  }
  return ultimo;
}

/** Recorta la prosa pegada tras un recinto ("Plaza Andrés de Lorenzo Cáceres
 *  Gran concierto del cantante" -> "Plaza Andrés de Lorenzo Cáceres").
 *  Regla: pasado el carácter 12, una palabra en mayúscula seguida de
 *  minúscula (no artículo) ya es otro sintagma. Los nombres con artículos
 *  interiores ("Plaza de la Pila", "Cancha El Lomo", "Auditorio Municipal
 *  de Santa Cruz") no disparan la regla. */
export function recortarProsa(lugar: string): string {
  const m = lugar.slice(12).search(/\s+(?:[A-ZÁÉÍÓÚÑ][a-záéíóúñ]*|[A-ZÁÉÍÓÚÑ]{2,})\s+(?!de\b|del\b|la\b|el\b|los\b|las\b|y\b|e\b)[a-záéíóúñ]{2,}/);
  return (m >= 0 ? lugar.slice(0, 12 + m) : lugar).trim();
}

// Programas multi-día ("Viernes 11 de septiembre ... Sábado 12 ..."):
// parte el texto por encabezado de día para heredar la fecha en cada baile.
// Pensado para escalar a los 31 aytos (Arona migrará a esto y jubilará su parche).
export interface SeccionDia {
  dia: number;
  mes: string;
  anyo: string;
  texto: string;
}

const HEADER_DIA = /(viernes|s[aá]bado|domingo|lunes|martes|mi[eé]rcoles|jueves)\s*,?\s*(\d{1,2})\b(?!\s*[:.]\d)(?:\s+de\s+([a-záéíóúñ]+)|\s+([a-záéíóúñ]+))?(?:\s+de\s+(20\d{2}))?/gi;
// Día primero ("18 Viernes", "26 Sábado", "Lunes 09."): algunos programas
// (Tacoronte) ordenan al revés y sin mes (lo pone el contexto del doc).
const HEADER_DIA_INV = /(?<!\d)(\d{1,2})\b(?!\s*[:.]\d)\s+(viernes|s[aá]bado|domingo|lunes|martes|mi[eé]rcoles|jueves)\b/gi;
// Fecha a inicio de línea ("7 de agosto: ...", "14-15 de agosto: ...").
// Con ^ anclado: evita tragar rangos y horas en mitad de frase.
// Admite resto del encabezado en la misma línea ("Domingo 30 de agosto 18:30 ...").
const HEADER_DIA_LINEA = /^(\d{1,2})(?:\s*[–-]\s*(\d{1,2}))?\s+de\s+([a-záéíóúñ]+)(?=[\s:.,–-]|$)/gim;
// "...hasta el 24 de septiembre" (sin día de semana, con mes obligatorio;
// \bel\b no traga "del" ni "al ... de"). "El día 25 de abril" (con "día"
// intercalado, prosa de El Tanque) también parte.
// NO parte si es un plazo ("hasta el 10 de septiembre", "inscripción antes del...").
const DIA_EL_MES = /\bel\s+(?:d[ií]a\s+)?(\d{1,2})\s+de\s+([a-záéíóúñ]+)(?:\s+de\s+(20\d{2}))?/gi;
const NO_ES_DIA = /(hasta|antes\s+del?|desde\s+el|plazo|inscripci[oó]n|cierra?|cierre)\s*$/i;

const WD_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const normWd = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/** ¿Es coherente la cabecera de la sección con el calendario? Sin día de
 *  semana explícito se acepta; con él, debe cuadrar (tumbar "Sábado 21"
 *  de un marzo leído como julio por el OCR auto). */
export function diaSemanaValido(texto: string, dia: number, mes: string, anyo: string): boolean {
  const m = texto.slice(0, 60).match(/(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)/i);
  if (!m) return true;
  if (dia < 1 || dia > 31) return false;
  return diaValido(dia, mes, anyo, m[1]);
}
/** ¿Cae `dia` en `weekday` dentro de (mes, anyo)? Para descartar artefactos
 *  de paginación ("24 25 Jueves", "13 14 Domingo") en cabeceras día-primero. */
export function diaValido(dia: number, mes: string, anyo: string, weekday: string): boolean {
  const m = parseInt(mes, 10), y = parseInt(anyo, 10);
  if (!m || !y || dia < 1 || dia > 31) return false;
  return normWd(WD_ES[new Date(Date.UTC(y, m - 1, dia)).getUTCDay()]) === normWd(weekday);
}

export function partirPorDias(programa: string, ref?: { mes: string; anyo: string }): SeccionDia[] {
  const out: SeccionDia[] = [];
  const headers: { dia: number; mes: string; anyo: string; index: number }[] = [];
  let m: RegExpExecArray | null;
  HEADER_DIA.lastIndex = 0;
  while ((m = HEADER_DIA.exec(programa)) !== null) {
    // "Jueves 3 septiembre 18:00": la palabra tras el día SOLO es mes si es
    // un mes válido (no "Domingo 30 aniversario"). Va en m[4] (sin "de").
    const mesCand = m[4] || '';
    const mesOk = !mesCand || mesANum(mesCand) !== '';
    headers.push({ dia: parseInt(m[2], 10), mes: mesOk ? (m[3] || m[4] || '') : '', anyo: mesOk ? (m[5] || '') : '', index: m.index });
  }
  HEADER_DIA_INV.lastIndex = 0;
  while ((m = HEADER_DIA_INV.exec(programa)) !== null) {
    if (headers.some((h) => Math.abs(h.index - m.index) < 12)) continue;
    // Con contexto de mes/año se valida día-semana y caen restos de
    // paginación ("24 25 Jueves", "13 14 Domingo"); sin contexto se acepta.
    const mm = ref?.mes || '', yy = ref?.anyo || '';
    if (mm && yy && !diaValido(parseInt(m[1], 10), mm, yy, m[2])) continue;
    headers.push({ dia: parseInt(m[1], 10), mes: '', anyo: '', index: m.index });
  }
  HEADER_DIA_LINEA.lastIndex = 0;
  while ((m = HEADER_DIA_LINEA.exec(programa)) !== null) {
    // El stream del PDF pega cabeceras ("...Domingo 30 de agosto 18:30...");
    // se busca el inicio real (día de semana previo) hasta 40 chars atrás.
    let ini = m.index;
    const pre = programa.slice(Math.max(0, m.index - 40), m.index);
    const wd = pre.match(/(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\s*,?\s*$/i);
    if (wd && wd.index !== undefined) ini = Math.max(0, m.index - 40) + wd.index;
    if (headers.some((h) => Math.abs(h.index - ini) < 12)) continue;
    // Con mes explícito ("30 de agosto") basta 1 mención; sin mes ("Lunes 09")
    // se evita tragar horas ("13:00 de la tarde" no es día, pero "9 de mayo" sí).
    if (!m[3] && !pre.match(/(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\s*,?\s*$/i)) continue;
    headers.push({ dia: parseInt(m[1], 10), mes: m[3] || '', anyo: '', index: ini });
  }
  DIA_EL_MES.lastIndex = 0;
  while ((m = DIA_EL_MES.exec(programa)) !== null) {
    // Evita duplicar un encabezado ya capturado en la misma posición
    if (headers.some((h) => Math.abs(h.index - m.index) < 12)) continue;
    // Evita partir por plazos ("...inscripción (hasta el 10 de septiembre)",
    // "(desde el 9 de septiembre hasta el 17...)"). Se comprueba con y sin
    // el "el" inicial del match, que forma parte de DIA_EL_MES.
    const previo = programa.slice(Math.max(0, m.index - 28), m.index);
    if (NO_ES_DIA.test(previo) || NO_ES_DIA.test(previo + 'el')) continue;
    headers.push({ dia: parseInt(m[1], 10), mes: m[2], anyo: m[3] || '', index: m.index });
  }
  headers.sort((a, b) => a.index - b.index);
  // "A su término / A continuación" suele ir en un recuadro ANTES del encabezado
  // del día al que pertenece (Tacoronte: "A su término BAILE POPULAR…" justo
  // antes de "26 Sábado"). Se arrastra esa cláusula al día siguiente.
  const CONECTOR = /(?:A su término)\b[^.]*\.\s*$/i;
  const limites = headers.map((h) => {
    const prev = programa.slice(Math.max(0, h.index - 320), h.index);
    const m = prev.match(CONECTOR);
    return m ? h.index - (prev.length - m.index) : h.index;
  });
  headers.forEach((h, i) => {
    const fin = i + 1 < headers.length ? limites[i + 1] : programa.length;
    out.push({ dia: h.dia, mes: h.mes, anyo: h.anyo, texto: programa.slice(limites[i], fin) });
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
  if (/baile de taifa/i.test(titulo)) return 'Taifa';
  if (/romer[ií]a/i.test(titulo)) return 'Romería';
  if (/inclusiva/i.test(titulo)) return 'Inclusiva';
  if (/noche latina|noche boricua|noche en blanco|latinazo|tributo|studio 54|concierto|festival/i.test(titulo)) return 'Concierto';
  if (/baile|tardeo|verbena|verbenazo/i.test(titulo)) return 'Baile Normal';
  if (/fiestas mayores|fiestas de/i.test(titulo)) return 'Fiestas';
  return 'Otro';
}
