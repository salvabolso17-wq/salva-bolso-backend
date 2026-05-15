import pool from "../../db/client";
import { log } from "../../utils/logger";

export interface LembreteRow {
  id: number;
  user_id: number;
  titulo: string;
  valor: string;
  dia_vencimento: number;
  fixa: boolean;
  proxima_data: string | Date;
  status: string;
  ultimo_aviso_em: string | Date | null;
  criado_em: Date;
  atualizado_em: Date;
}

function pad2(n: number): string { return String(n).padStart(2, "0"); }

export function dataToISO(d: string | Date): string {
  if (d instanceof Date) {
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  }
  // pg pode mandar "YYYY-MM-DD" ou ISO completo; pegamos só os 10 primeiros chars válidos
  const s = String(d);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : s;
}

function nowBRT(): Date {
  return new Date(Date.now() - 3 * 60 * 60 * 1000);
}

function ultimoDiaDoMes(ano: number, mes: number): number {
  return new Date(ano, mes, 0).getDate();
}

function proximaDataParaDia(dia: number, base?: Date): string {
  const ref = base ?? nowBRT();
  const anoRef = ref.getUTCFullYear();
  const mesRef = ref.getUTCMonth() + 1;
  const diaHoje = ref.getUTCDate();

  let ano = anoRef;
  let mes = mesRef;
  if (dia < diaHoje) {
    mes += 1;
    if (mes > 12) { mes = 1; ano += 1; }
  }
  const ultDia = ultimoDiaDoMes(ano, mes);
  const diaFinal = Math.min(dia, ultDia);
  return `${ano}-${String(mes).padStart(2, "0")}-${String(diaFinal).padStart(2, "0")}`;
}

function proxMesParaDia(dia: number, dataAtual: string | Date): string {
  const iso = dataToISO(dataAtual);
  const [a, m] = iso.split("-").map(n => parseInt(n, 10));
  let ano = a;
  let mes = m + 1;
  if (mes > 12) { mes = 1; ano += 1; }
  const ultDia = ultimoDiaDoMes(ano, mes);
  const diaFinal = Math.min(dia, ultDia);
  return `${ano}-${String(mes).padStart(2, "0")}-${String(diaFinal).padStart(2, "0")}`;
}

function normalizeTitulo(s: string): string {
  return s.trim().replace(/\s+/g, " ").slice(0, 120);
}

export async function criarLembrete(
  userId: number,
  titulo: string,
  valor: number,
  dia: number,
  fixa: boolean,
): Promise<LembreteRow> {
  const tituloNorm = normalizeTitulo(titulo);
  const proxima = proximaDataParaDia(dia);

  log.db("criarLembrete chamado", { userId, titulo: tituloNorm, valor, dia, fixa, proxima, stack: (new Error().stack ?? "").split("\n").slice(2, 5).join(" ← ") });

  // Dedup: se já há um lembrete pendente igual (case-insensitive) criado nos últimos 60s,
  // retorna o existente em vez de criar duplicado. Cobre dupla chamada do handler ou
  // dedupe de webhook que escapou.
  const dup = await pool.query<LembreteRow>(
    `SELECT * FROM lembretes
     WHERE user_id = $1
       AND LOWER(titulo) = LOWER($2)
       AND dia_vencimento = $3
       AND status = 'pendente'
       AND criado_em >= NOW() - INTERVAL '60 seconds'
     ORDER BY criado_em DESC
     LIMIT 1`,
    [userId, tituloNorm, dia],
  );
  if (dup.rows[0]) {
    log.db("criarLembrete dedup — retornando existente", { userId, lembreteId: dup.rows[0].id, titulo: tituloNorm });
    return dup.rows[0];
  }

  const r = await pool.query<LembreteRow>(
    `INSERT INTO lembretes (user_id, titulo, valor, dia_vencimento, fixa, proxima_data, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'pendente')
     RETURNING *`,
    [userId, tituloNorm, valor, dia, fixa, proxima],
  );
  log.db("criarLembrete INSERT ok", { userId, lembreteId: r.rows[0].id, titulo: tituloNorm });
  return r.rows[0];
}

export async function listarLembretes(userId: number): Promise<LembreteRow[]> {
  log.db("listarLembretes chamado", { userId });
  const r = await pool.query<LembreteRow>(
    `SELECT * FROM lembretes
     WHERE user_id = $1 AND status = 'pendente'
     ORDER BY proxima_data ASC, id ASC`,
    [userId],
  );
  log.db("listarLembretes resultado", { userId, total: r.rows.length, ids: r.rows.map(x => x.id) });
  return r.rows;
}

export async function buscarLembretesPorTitulo(userId: number, titulo: string): Promise<LembreteRow[]> {
  const termo = `%${titulo.trim().toLowerCase()}%`;
  const r = await pool.query<LembreteRow>(
    `SELECT * FROM lembretes
     WHERE user_id = $1 AND status IN ('pendente','pago')
       AND LOWER(titulo) LIKE $2
     ORDER BY proxima_data ASC`,
    [userId, termo],
  );
  return r.rows;
}

export async function getLembrete(userId: number, id: number): Promise<LembreteRow | null> {
  const r = await pool.query<LembreteRow>(
    `SELECT * FROM lembretes WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return r.rows[0] ?? null;
}

export interface MarcarPagoResult {
  pago: LembreteRow;
  proximo: LembreteRow | null;
}

export async function marcarPago(userId: number, id: number): Promise<MarcarPagoResult | null> {
  // 1) UPDATE atômico pendente → pago (condicionado a status='pendente' pra evitar dupla marcação)
  const upd = await pool.query<LembreteRow>(
    `UPDATE lembretes
     SET status = 'pago', atualizado_em = NOW()
     WHERE id = $1 AND user_id = $2 AND status = 'pendente'
     RETURNING *`,
    [id, userId],
  );
  if ((upd.rowCount ?? 0) === 0) {
    log.db("marcarPago — nenhum row pendente alterado", { userId, id });
    return null;
  }
  const pago = upd.rows[0];
  log.db("marcarPago — pendente→pago", { userId, id, titulo: pago.titulo });

  // 2) Se fixa, cria novo lembrete pendente para o próximo mês
  let proximo: LembreteRow | null = null;
  if (pago.fixa) {
    const novaData = proxMesParaDia(pago.dia_vencimento, pago.proxima_data);
    const ins = await pool.query<LembreteRow>(
      `INSERT INTO lembretes (user_id, titulo, valor, dia_vencimento, fixa, proxima_data, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pendente')
       RETURNING *`,
      [userId, pago.titulo, pago.valor, pago.dia_vencimento, pago.fixa, novaData],
    );
    proximo = ins.rows[0] ?? null;
    log.db("marcarPago — proximo mes criado", { userId, proximoId: proximo?.id, proximaData: novaData });
  }

  return { pago, proximo };
}

export async function cancelarLembrete(userId: number, id: number): Promise<boolean> {
  const r = await pool.query(
    `UPDATE lembretes SET status = 'cancelado', atualizado_em = NOW()
     WHERE id = $1 AND user_id = $2 AND status <> 'cancelado'`,
    [id, userId],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function editarLembrete(
  userId: number,
  id: number,
  patch: { titulo?: string; valor?: number; dia?: number; fixa?: boolean },
): Promise<LembreteRow | null> {
  const cur = await getLembrete(userId, id);
  if (!cur) return null;

  const titulo = patch.titulo !== undefined ? normalizeTitulo(patch.titulo) : cur.titulo;
  const valor  = patch.valor !== undefined ? patch.valor : Number(cur.valor);
  const dia    = patch.dia !== undefined ? patch.dia : cur.dia_vencimento;
  const fixa   = patch.fixa !== undefined ? patch.fixa : cur.fixa;

  const proxima = patch.dia !== undefined ? proximaDataParaDia(dia) : cur.proxima_data;

  const r = await pool.query<LembreteRow>(
    `UPDATE lembretes
     SET titulo = $1, valor = $2, dia_vencimento = $3, fixa = $4, proxima_data = $5, atualizado_em = NOW()
     WHERE id = $6 AND user_id = $7
     RETURNING *`,
    [titulo, valor, dia, fixa, proxima, id, userId],
  );
  return r.rows[0] ?? null;
}

export async function proximosVencimentos(diasAFrente: number): Promise<LembreteRow[]> {
  const r = await pool.query<LembreteRow>(
    `SELECT l.*
     FROM lembretes l
     WHERE l.status = 'pendente'
       AND l.proxima_data <= ((NOW() AT TIME ZONE 'America/Sao_Paulo')::date + $1::int)
     ORDER BY l.proxima_data ASC`,
    [diasAFrente],
  );
  return r.rows;
}

export async function marcarAvisoEnviado(id: number, marco: string): Promise<void> {
  await pool.query(
    `UPDATE lembretes SET ultimo_aviso_em = (NOW() AT TIME ZONE 'America/Sao_Paulo')::date,
                          atualizado_em = NOW()
     WHERE id = $1`,
    [id],
  );
  // marco fica implícito na proxima_data; ultimo_aviso_em = hoje evita re-envio no mesmo dia
  void marco;
}

export function diasAteVencimento(proxima_data: string | Date): number {
  const hoje = nowBRT();
  const hojeStr = `${hoje.getUTCFullYear()}-${pad2(hoje.getUTCMonth() + 1)}-${pad2(hoje.getUTCDate())}`;
  const isoData = dataToISO(proxima_data);
  const a = new Date(hojeStr + "T00:00:00Z").getTime();
  const b = new Date(isoData  + "T00:00:00Z").getTime();
  if (isNaN(a) || isNaN(b)) return 0;
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
}
