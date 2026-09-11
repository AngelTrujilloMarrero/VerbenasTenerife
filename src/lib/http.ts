// Helper HTTP compartido (una sola UA para los 31 aytos).
export async function fetchText(url: string): Promise<string> {
  const r = await fetch(url, {
    headers: { 'User-Agent': 'VerbenasTenerife/0.1 (piloto; contacto admin)' }
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} en ${url}`);
  return r.text();
}
