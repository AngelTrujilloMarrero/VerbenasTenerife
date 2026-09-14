// Verificación de vigencia con IA (Gemini REST, sin SDK).
// La regex hace de pre-filtro barato; la IA decide los casos difíciles:
// listados del mes, "próximamente", crónicas que parecen anuncios, fechas
// implícitas. ~35 peticiones por pasada completa (lotes de 20 posts).
// Sin GEMINI_API_KEY no hace nada (el llamador usa la lógica regex).
const BATCH = 20;

function prompt(hoy, posts) {
  return `Eres un extractor de agenda de verbenas y bailes populares en Tenerife (Canarias).
Hoy es ${hoy} (dd-mm-yyyy).

Analiza cada post y devuelve SOLO un array JSON, un objeto por post:
[{"indice":N,"relevante":true|false,"fechaEvento":"dd-mm-yyyy"|null,"orquestas":[],"lugar":"","esCancelacion":false,"esRetomar":false,"motivo":"frase corta"}]

Reglas:
- relevante=true SOLO si anuncia un baile, verbena, tardeo, fiesta con música
  u orquesta que AÚN NO se ha celebrado (>= hoy). Incluye carteles/listados
  del mes con eventos pendientes y anuncios sin fecha explícita pero
  claramente venideros ("próximamente", "este año", "no faltes").
- relevante=false si es crónica en pasado ("así lo pasamos", "gracias por
  venir"), el evento ya pasó, o no hay nada musical (misa, deporte, avisos).
- fechaEvento: día del evento en dd-mm-yyyy. Si el texto da día+mes sin año,
  usa el año que tenga sentido respecto a hoy y a la fecha del post. Si no se
  puede determinar pero es venidero, null.
- orquestas: nombres de orquestas/grupos/DJs que actúan (no los que solo se
  mencionan de pasada). lugar: recinto/plaza/municipio si aparece.
- esCancelacion=true si se cancela/suspende/aplaza una actuación.
  esRetomar=true si se confirma que se celebra o se da nueva fecha.
- fechaPost es orientativa ("hace 4 días", "15 de ago."): el evento puede ser
  anterior o posterior a ella; fíate del TEXTO, no de la fecha del post.

Posts:
${posts.map((p) => `#${p.indice} [${p.cuenta} · post: ${p.fechaPost}] ${p.texto}`).join('\n---\n')}`;
}

/** posts: [{indice, cuenta, fechaPost, texto}]. Devuelve Map indice->veredicto. */
export async function verificarConIA(posts, { apiKey, model, hoy }) {
  const out = new Map();
  if (!apiKey || !posts.length) return out;
  for (let i = 0; i < posts.length; i += BATCH) {
    const lote = posts.slice(i, i + BATCH);
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(90000),
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt(hoy, lote) }] }],
            generationConfig: { responseMimeType: 'application/json', temperature: 0.1 }
          }) });
      if (!r.ok) {
        console.warn(`IA: HTTP ${r.status} en lote ${i / BATCH + 1}, se sigue con regex`);
        continue;
      }
      const j = await r.json();
      const txt = j.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '[]';
      const arr = JSON.parse(txt);
      for (const v of Array.isArray(arr) ? arr : []) {
        if (typeof v.indice === 'number') out.set(v.indice, v);
      }
    } catch (e) {
      console.warn('IA: fallo lote ' + (i / BATCH + 1) + ' (' + String(e.message || e).split('\n')[0] + '), se sigue con regex');
    }
    await new Promise((r) => setTimeout(r, 1000)); // ritmo educado con la API
  }
  return out;
}
