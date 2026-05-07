import pool from "../db/client";
import { parseTransaction } from "../utils/parseTransaction";
import { whatsapp } from "./whatsapp";
import type { NormalizedMessage } from "../adapters/whatsappAdapters";

interface UserRow {
  id: number;
  telefone: string;
  nome: string | null;
}

type ProcessResult =
  | { success: true;  userId: number; transacao: Record<string, unknown>; interpretado: Record<string, unknown> }
  | { success: false; userId?: number; erro: string };

async function findUserByTelefone(telefone: string): Promise<UserRow | null> {
  const normalized = telefone.replace(/[^0-9]/g, "");

  const result = await pool.query<UserRow>(
    `SELECT id, telefone, nome FROM users
     WHERE REGEXP_REPLACE(telefone, '[^0-9]', '', 'g') = $1
        OR RIGHT(REGEXP_REPLACE(telefone, '[^0-9]', '', 'g'), 11) = RIGHT($1, 11)
        OR RIGHT(REGEXP_REPLACE(telefone, '[^0-9]', '', 'g'), 8) = RIGHT($1, 8)
     LIMIT 1`,
    [normalized]
  );

  return result.rows[0] ?? null;
}

export async function processWhatsAppMessage(message: NormalizedMessage): Promise<ProcessResult> {
  const user = await findUserByTelefone(message.telefone);

  if (!user) {
    return {
      success: false,
      erro: `Nenhum usuário cadastrado com o telefone ${message.telefone}`,
    };
  }

  const parsed = parseTransaction(message.texto);

  if (!parsed) {
    await whatsapp.sendText({
      to: message.telefone,
      text: "Não entendi. Tente: '120 mercado', '35 gasolina' ou '500 freelance'",
    });
    return {
      success: false,
      userId: user.id,
      erro: "Não foi possível interpretar a mensagem",
    };
  }

  const result = await pool.query(
    `INSERT INTO transactions (user_id, tipo, valor, categoria, descricao)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [user.id, parsed.tipo, parsed.valor, parsed.categoria, parsed.descricao]
  );

  const emoji  = parsed.tipo === "entrada" ? "+" : "-";
  const sinal  = parsed.tipo === "entrada" ? "Entrada" : "Saída";
  const confirmacao = [
    `Registrado!`,
    `${emoji} R$ ${parsed.valor.toFixed(2)} | ${sinal}`,
    `Categoria: ${parsed.categoria}`,
    `Desc: ${parsed.descricao}`,
  ].join("\n");

  await whatsapp.sendText({ to: message.telefone, text: confirmacao });

  return {
    success: true,
    userId: user.id,
    transacao: result.rows[0] as Record<string, unknown>,
    interpretado: {
      valor: parsed.valor,
      descricao: parsed.descricao,
      categoria: parsed.categoria,
      tipo: parsed.tipo,
    },
  };
}
