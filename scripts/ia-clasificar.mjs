// Verificación de vigencia con IA gratuita.
// Cadena de proveedores (se usa el primero disponible):
//   1. Gemini directo (GEMINI_API_KEY, gratis ~1500/día, sin tarjeta)
//   2. Groq OpenAI-compatible (GROQ_API_KEY, gratis ~1000/día, rápido)
//   3. OpenRouter :free (OPENROUTER_API_KEY, gratis 50/día)
//   4. Endpoint OpenAI-compatible propio (IA_BASE_URL): Ollama en local
//      (gratis para siempre, sin cuotas ni red), NVIDIA NIM, Mistral, etc.
//   5. Pollinations (sin clave, anónimo 1 req/15s) — siempre disponible
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
  const s = String(txt || '').replace(/```json|```/g, '').trim();
  if (s === '[]') return []; // "nada relevante" explícito (respuesta exacta)
  // Subcadenas con corchetes balanceados que empiezan por `[{`, de mayor a
  // menor: el razonamiento trae corchetes en prosa ("[cuenta · ...]") y el
  // greedy simple los tragaba rompiendo el parse.
  const candidatos = [];
  const re = /\[\s*\{/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    let depth = 0, instr = false, esc = false;
    for (let i = m.index; i < s.length; i++) {
      const ch = s[i];
      if (instr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') instr = false;
      } else if (ch === '"') instr = true;
      else if (ch === '[') depth++;
      else if (ch === ']') {
        depth--;
        if (depth === 0) { candidatos.push(s.slice(m.index, i + 1)); break; }
      }
    }
  }
  candidatos.sort((a, b) => b.length - a.length);
  for (const c of candidatos) {
    try {
      const v = JSON.parse(c);
      if (Array.isArray(v) && v.some((x) => x && typeof x.indice === 'number')) return v;
    } catch { /* siguiente candidata */ }
  }
  throw new Error('sin JSON válido en la respuesta');
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

async function loteOpenAI(lote, hoy, base, apiKey, model, nombre, cuentaGasto) {
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
  if (cuentaGasto && j.usage) {
    cuentaGasto.tokens += (j.usage.prompt_tokens || 0) + (j.usage.completion_tokens || 0);
    cuentaGasto.costeUSD += (j.usage.prompt_tokens || 0) * PRECIO_DEEPSEEK.in
      + (j.usage.completion_tokens || 0) * PRECIO_DEEPSEEK.out;
  }
  const msg = j.choices?.[0]?.message || {};
  if (j.error && !msg.content && !msg.reasoning) throw new Error(`${nombre}: ${j.error.message || 'error'}`);
  // Modelos pequeños con prompt largo devuelven el JSON en `reasoning` y
  // dejan `content` vacío: se lee ambos.
  return extraerArray(msg.content || msg.reasoning || '');
}

/** posts: [{indice, cuenta, fechaPost, texto}]. Devuelve {veredictos, gasto}.
 *  gasto: {proveedor, tokens, costeUSD} aprox del proveedor de pago (si se usó).
 *  Precios DeepSeek (revisar si cambian): $0.27/1M input, $1.10/1M output. */
const PRECIO_DEEPSEEK = { in: 0.27 / 1e6, out: 1.1 / 1e6 };
export async function verificarConIA(posts, cfg = {}) {
  const out = new Map();
  const vistos = new Set(); // índices enviados en lotes con éxito (aunque un ítem no traiga veredicto = irrelevante implícito)
  const gasto = { proveedor: null, tokens: 0, costeUSD: 0 };
  if (!posts.length) return { veredictos: out, gasto, vistos: [] };
  const hoy = cfg.hoy;
  const proveedores = [];
  if (cfg.customBase) {
    proveedores.push({ nombre: 'Custom', fn: (l) => loteOpenAI(l, hoy, cfg.customBase, cfg.customKey || '', cfg.customModel || 'qwen3:8b', 'Custom') });
  }
  // DeepSeek (PAGO) solo si IA_PAGO=1: va el ÚLTIMO, solo gasta si todo lo
  // gratis falló. Cap de seguridad: MAX_IA_POSTS.
  const maxPosts = cfg.maxPosts || 120;
  const lista = posts.slice(0, maxPosts);
  if (posts.length > maxPosts) console.warn(`IA: cap ${maxPosts} posts (había ${posts.length})`);
  // (proveedores ya declarado arriba; Custom va primero si hay IA_BASE_URL)
  if (cfg.geminiKey) {
    const model = cfg.geminiModel || 'gemini-2.5-flash';
    proveedores.push({ nombre: 'Gemini', fn: (l) => loteGemini(l, hoy, cfg.geminiKey, model) });
  }
  if (cfg.groqKey) {
    proveedores.push({ nombre: 'Groq', fn: (l) => loteOpenAI(l, hoy, 'https://api.groq.com/openai/v1', cfg.groqKey, cfg.groqModel || 'llama-3.3-70b-versatile', 'Groq') });
  }
  if (cfg.openrouterKey) {
    // El roster :free rota; ver modelos gratis hoy en openrouter.ai/models?q=free.
    // 14-sep-2026: liquid/lfm-2.5-2.6b:free (JSON limpio y rápido; el
    // nemotron-3.5 razona en voz alta y agota max_tokens).
    // Lotes de 5: los modelos pequeños se pierden con prompts largos.
    proveedores.push({ nombre: 'OpenRouter', batch: 5, fn: (l) => loteOpenAI(l, hoy, 'https://openrouter.ai/api/v1', cfg.openrouterKey, cfg.openrouterModel || 'liquid/lfm-2.5-2.6b:free', 'OpenRouter') });
  }
  if (cfg.deepseekKey && cfg.pago) {
    proveedores.push({ nombre: 'DeepSeek*', pago: true,
      fn: (l) => loteOpenAI(l, hoy, 'https://api.deepseek.com', cfg.deepseekKey, cfg.deepseekModel || 'deepseek-chat', 'DeepSeek', gasto) });
  }
  // Siempre disponible, sin clave (anónimo: 1 req/15s).
  proveedores.push({ nombre: 'Pollinations', batch: 5, fn: (l) => loteOpenAI(l, hoy, 'https://text.pollinations.ai/openai', '', 'openai', 'Pollinations'), pausa: 16000 });

  for (const p of proveedores) p.batch = p.batch || BATCH;
  // Reparto por proveedor: cada uno procesa con su tamaño de lote.
  // Simple: se intenta en orden; el primero que resuelve un lote gana.
  const pendientes = [...lista];
  while (pendientes.length) {
    let avanzo = false;
    for (const p of proveedores) {
      if (!pendientes.length) break;
      const lote = pendientes.slice(0, p.batch);
      let ok = false;
      // Un reintento por proveedor (los tiers gratuitos estrangulan a ratos).
      for (let intento = 0; intento < 2 && !ok; intento++) {
        try {
          if (intento > 0) await new Promise((r) => setTimeout(r, 20000));
          const arr = await p.fn(lote);
          let validos = 0;
          for (const v of Array.isArray(arr) ? arr : []) {
            if (typeof v.indice === 'number') {
              const orig = lote[v.indice];
              if (orig) { out.set(orig.indice, v); validos++; }
            }
          }
          // Lote vacío en tier gratuito = respuesta inútil (rate-limit con
          // 200), no "todo irrelevante": se reintenta y si no, decide la regex.
          if (lote.length > 2 && validos === 0) throw new Error('lote vacío sin veredictos');
          ok = true;
        } catch (e) {
          console.warn(`IA ${p.nombre}: fallo lote (intento ${intento + 1}, ${lote.length} posts) (${String(e.message || e).split('\n')[0].slice(0, 100)})`);
        }
      }
      if (ok) {
        if (p.pago) gasto.proveedor = p.nombre;
        for (const it of lote) vistos.add(it.indice);
        pendientes.splice(0, lote.length);
        avanzo = true;
        if (p.pausa) await new Promise((r) => setTimeout(r, p.pausa));
        break;
      }
    }
    if (!avanzo) {
      console.warn(`IA: ${pendientes.length} posts sin veredicto, decide la regex`);
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (gasto.proveedor) {
    console.log(`IA gasto: ${gasto.tokens} tokens en ${gasto.proveedor} ≈ $${gasto.costeUSD.toFixed(4)}`);
  }
  return { veredictos: out, gasto, vistos: [...vistos] };
}
