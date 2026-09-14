// Verificación de vigencia con IA gratuita.
// Cadena de proveedores (se usa el primero disponible):
//   1. Gemini directo (GEMINI_API_KEY, gratis ~1500/día, sin tarjeta)
//   2. Groq OpenAI-compatible (GROQ_API_KEY, gratis ~1000/día, rápido)
//   3. OpenRouter :free (OPENROUTER_API_KEY, gratis 50/día)
//   4. Pollinations (sin clave, anónimo 1 req/15s) — siempre disponible
// La regex hace de pre-filtro barato; la IA decide los casos difíciles.
// Sin ningún proveedor (imposible: Pollinations no necesita clave) o si todo
// falla, el llamador usa la lógica regex.
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

function extraerArray(txt) {
  const m = String(txt || '').match(/\[[\s\S]*\]/);
  return JSON.parse(m ? m[0] : '[]');
}

async function loteGemini(lote, hoy, apiKey, model) {
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(90000),
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt(hoy, lote) }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.1 }
      }) });
  if (!r.ok) throw new Error(`Gemini HTTP ${r.status}`);
  const j = await r.json();
  const txt = j.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '[]';
  return extraerArray(txt);
}

async function loteOpenAI(lote, hoy, base, apiKey, model, nombre) {
  const r = await fetch(`${base}/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    signal: AbortSignal.timeout(90000),
    body: JSON.stringify({
      model, temperature: 0.1, max_tokens: 4000,
      messages: [
        { role: 'system', content: 'Devuelves SOLO JSON válido, sin explicaciones.' },
        { role: 'user', content: prompt(hoy, lote) }
      ]
    }) });
  if (!r.ok) throw new Error(`${nombre} HTTP ${r.status}`);
  const j = await r.json();
  return extraerArray(j.choices?.[0]?.message?.content);
}

/** posts: [{indice, cuenta, fechaPost, texto}]. Devuelve Map indice->veredicto. */
export async function verificarConIA(posts, cfg = {}) {
  const out = new Map();
  if (!posts.length) return out;
  const hoy = cfg.hoy;
  const proveedores = [];
  if (cfg.geminiKey) {
    const model = cfg.geminiModel || 'gemini-2.5-flash';
    proveedores.push({ nombre: 'Gemini', fn: (l) => loteGemini(l, hoy, cfg.geminiKey, model) });
  }
  if (cfg.groqKey) {
    proveedores.push({ nombre: 'Groq', fn: (l) => loteOpenAI(l, hoy, 'https://api.groq.com/openai/v1', cfg.groqKey, cfg.groqModel || 'llama-3.3-70b-versatile', 'Groq') });
  }
  if (cfg.openrouterKey) {
    proveedores.push({ nombre: 'OpenRouter', fn: (l) => loteOpenAI(l, hoy, 'https://openrouter.ai/api/v1', cfg.openrouterKey, cfg.openrouterModel || 'meta-llama/llama-3.3-70b-instruct:free', 'OpenRouter') });
  }
  // Siempre disponible, sin clave (anónimo: 1 req/15s).
  proveedores.push({ nombre: 'Pollinations', fn: (l) => loteOpenAI(l, hoy, 'https://text.pollinations.ai/openai', '', 'openai', 'Pollinations'), pausa: 16000 });

  for (let i = 0; i < posts.length; i += BATCH) {
    const lote = posts.slice(i, i + BATCH);
    let ok = false;
    for (const p of proveedores) {
      // Un reintento por proveedor (los tiers gratuitos estrangulan a ratos).
      for (let intento = 0; intento < 2 && !ok; intento++) {
        try {
          if (intento > 0) await new Promise((r) => setTimeout(r, 20000));
          const arr = await p.fn(lote);
          for (const v of Array.isArray(arr) ? arr : []) {
            if (typeof v.indice === 'number') out.set(v.indice, v);
          }
          ok = true;
        } catch (e) {
          console.warn(`IA ${p.nombre}: fallo lote ${i / BATCH + 1} intento ${intento + 1} (${String(e.message || e).split('\n')[0].slice(0, 100)})`);
        }
      }
      if (ok) break;
    }
    if (!ok) console.warn(`IA: lote ${i / BATCH + 1} sin veredicto, decide la regex`);
    else await new Promise((r) => setTimeout(r, 1000));
  }
  return out;
}
