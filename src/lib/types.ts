// Tipos compartidos por los 31 adaptadores municipales.
export interface Verbena {
  id: string;
  titulo: string;
  day: string; // dd-mm-yyyy
  hora: string;
  municipio: string;
  lugar: string;
  orquestas: string[];
  tipo: string;
  url: string;
  score: number;
  motivos: string[];
}

export interface Fuente {
  id: string;
  nombre: string;
  agendaUrl: string;
  obtener: () => Promise<Verbena[]>;
}

/** Orden cronológico sobre day dd-mm-yyyy. */
export function porFecha(a: Verbena, b: Verbena): number {
  const k = (v: Verbena) => {
    const [d, m, y] = v.day.split('-');
    return `${y || '9999'}-${m || '99'}-${d || '99'} ${v.hora || '99:99'}`;
  };
  return k(a).localeCompare(k(b));
}
