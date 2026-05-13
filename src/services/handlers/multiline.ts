import pool from "../../db/client";
import { whatsapp } from "../whatsapp";
import { log } from "../../utils/logger";
import { fmtValor, capitalizeFirst } from "../../utils/formatting";
import { parseTransaction } from "../../utils/parseTransaction";
import { recordAction, setLastInstallment, recordInsightSent } from "../conversationEngine";
import { checkAndSuggestRecorrente, checkRecorrenteDuplicado, NEVER_RECURRING } from "../modules/recurringDetection";
import { handleInstallmentRegistration, detectInstallment } from "./installments";
import type { UserRow, ProcessResult } from "../types";

export function looksLikeTransactionLine(linha: string): boolean {
  const t = linha.trim();
  if (!t || t.length < 2) return false;
  // Starts with a digit: "40 netflix", "30,50 mercado"
  if (/^[\d]/.test(t)) return true;
  // Income: "+3000" or "+ 500"
  if (/^\+\s*[\d]/.test(t)) return true;
  // Common expense/income verbs
  if (/^(gastei|paguei|pago|comprei|tomei|saiu|custou|recebi|salario|salário|renda|entrada|freelance|bonus|bônus)\s/i.test(t)) return true;
  // Installment: "item Nx de valor" or "item N parcelas de valor"
  if (/^.+\s+\d{1,2}[xX]\s+[\d,.]+$/i.test(t)) return true;
  if (/^.+\s+\d{1,2}\s+parcelas?\s+de\s+[\d,.]+$/i.test(t)) return true;
  // Description before value: "Mercado 120", "Sorvete 38", "Disney Plus 34"
  if (/^[a-zA-ZÀ-ÿ][\w\sÀ-ÿ]+\s+[\d,.]+$/.test(t)) return true;
  return false;
}

export function detectMultiLine(texto: string): string[] | null {
  const linhas = texto
    .split(/\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0);
  if (linhas.length < 2) return null;
  if (!linhas.every(looksLikeTransactionLine)) return null;
  return linhas;
}

export async function handleMultiLineTransactions(
  user: UserRow,
  telefone: string,
  linhas: string[],
): Promise<ProcessResult> {
  type Resultado = { descricao: string; valor: number; tipo: string; categoria: string; textoOriginal?: string };
  const resultados: Resultado[] = [];
  const falhas: string[]        = [];

  for (const linha of linhas) {
    try {
      // Installment line: "iphone 12x de 345"
      const inst = detectInstallment(linha);
      if (inst && !inst.needsParcela) {
        const { item, valor, totalParcelas } = inst;
        const total      = valor * totalParcelas;
        const tempParsed = parseTransaction(`${valor} ${item}`);
        const categoria  = tempParsed?.categoria ?? "Outros";
        const descricao  = capitalizeFirst(item);
        await pool.query(
          `INSERT INTO transactions (user_id, tipo, valor, categoria, descricao) VALUES ($1, 'saida', $2, $3, $4)`,
          [user.id, valor, categoria, descricao]
        );
        const instResult = await pool.query<{ id: number }>(
          `INSERT INTO installments (user_id, nome, valor_total, valor_parcela, total_parcelas, parcelas_pagas, categoria)
           VALUES ($1, $2, $3, $4, $5, 1, $6) RETURNING id`,
          [user.id, descricao, total, valor, totalParcelas, categoria]
        );
        const dbId = instResult.rows[0].id;
        setLastInstallment(user.id, { item: descricao, valor, totalParcelas, parcelaAtual: 1, dbId, valorTotal: total });
        recordAction(user.id, "registered_transaction");
        resultados.push({ descricao: `${descricao} (${totalParcelas}×)`, valor, tipo: "saida", categoria });
        continue;
      }

      // Regular expense / income
      const parsed = parseTransaction(linha);
      if (!parsed) { falhas.push(linha); continue; }

      // Skip if matches a recurring expense (same check as single-line path)
      if (parsed.tipo === "saida") {
        const recMatch = await checkRecorrenteDuplicado(user.id, parsed.descricao, parsed.valor);
        if (recMatch !== null) {
          resultados.push({ descricao: `${recMatch.nome} (recorrente)`, valor: parsed.valor, tipo: "saida", categoria: parsed.categoria });
          continue;
        }
      }

      await pool.query(
        `INSERT INTO transactions (user_id, tipo, valor, categoria, descricao) VALUES ($1, $2, $3, $4, $5)`,
        [user.id, parsed.tipo, parsed.valor, parsed.categoria, parsed.descricao]
      );
      recordAction(user.id, "registered_transaction");
      resultados.push({ descricao: parsed.descricao, valor: parsed.valor, tipo: parsed.tipo, categoria: parsed.categoria, textoOriginal: linha });
    } catch (err) {
      log.error("falha ao processar linha multilinha", err, { linha, userId: user.id });
      falhas.push(linha);
    }
  }

  if (resultados.length === 0) {
    await whatsapp.sendText({ to: telefone, text: "Não consegui interpretar. Tenta uma linha por vez?" });
    return { success: false, userId: user.id, erro: "multilinha: nenhuma linha processada" };
  }

  const itens = resultados.map(r => {
    const sinal = r.tipo === "entrada" ? "+" : "";
    return `• ${sinal}${fmtValor(r.valor)} — ${r.descricao}`;
  });

  const header = resultados.length === 1
    ? "✅ Anotado!"
    : `✅ ${resultados.length} anotados:`;

  const partes = [header, "", ...itens];
  if (falhas.length > 0) {
    partes.push("", `Não entendi: ${falhas.join(", ")}`);
  }

  try {
    await whatsapp.sendText({ to: telefone, text: partes.join("\n") });
  } catch (err) {
    log.error("falha ao enviar confirmação multilinha", err, { to: telefone });
  }

  // Notifica itens já salvos como recorrentes
  const jaFixos = resultados.filter(r => r.descricao.toLowerCase().includes("(recorrente)"));
  if (jaFixos.length > 0) {
    try {
      const nomes = jaFixos.map(r => capitalizeFirst(r.descricao.replace(/\s*\(recorrente\)/i, "")));
      const lista = nomes.length === 1 ? nomes[0] : nomes.slice(0, -1).join(", ") + " e " + nomes[nomes.length - 1];
      await whatsapp.sendText({ to: telefone, text: `${lista} já está${nomes.length > 1 ? "m" : ""} nas suas contas fixas 🙂` });
    } catch (err) {
      log.error("falha ao notificar recorrentes já salvos", err, { userId: user.id });
    }
  }

  // Verifica recorrentes nos itens de saída — sem gate de cooldown (lista é sinal explícito)
  const saidas = resultados.filter(r => r.tipo === "saida");
  log.webhook("multilinha: saidas detectadas", { userId: user.id, count: saidas.length, descricoes: saidas.map(r => r.descricao) });
  if (saidas.length >= 1) {
    setTimeout(async () => {
      try {
        // Coleta todos os candidatos a recorrente: passam no score e ainda não estão cadastrados
        const candidatos: Resultado[] = [];
        for (const r of saidas) {
          if (r.descricao.toLowerCase().includes("(recorrente)")) {
            log.webhook("multilinha: skip recorrente conhecido", { userId: user.id, desc: r.descricao });
            continue;
          }
          if (NEVER_RECURRING.some(w => r.descricao.toLowerCase().includes(w))) {
            log.webhook("multilinha: skip never recurring", { userId: user.id, desc: r.descricao });
            continue;
          }
          const jaRec = await pool.query(
            `SELECT 1 FROM recurring_expenses WHERE user_id = $1 AND LOWER(TRIM(nome)) = $2 LIMIT 1`,
            [user.id, r.descricao.toLowerCase().trim()]
          );
          if (jaRec.rows.length > 0) {
            log.webhook("multilinha: skip ja recorrente no db", { userId: user.id, desc: r.descricao });
            continue;
          }
          candidatos.push(r);
        }

        log.webhook("multilinha: candidatos", { userId: user.id, count: candidatos.length, nomes: candidatos.map(r => r.descricao) });

        if (candidatos.length === 1) {
          // Um candidato — pergunta direta, sem gate de sentinel (lista é sinal explícito)
          const r        = candidatos[0];
          const descNorm = r.descricao.toLowerCase().trim();
          const jaRecDB  = await pool.query(
            `SELECT 1 FROM recurring_expenses WHERE user_id = $1 AND LOWER(TRIM(nome)) = $2 LIMIT 1`,
            [user.id, descNorm]
          );
          if (jaRecDB.rows.length === 0) {
            await pool.query(
              `INSERT INTO pending_actions (user_id, action, step, tx_ids)
               VALUES ($1, 'confirmar_recorrente', 'waiting_confirmation', $2::jsonb)
               ON CONFLICT (user_id) DO UPDATE
                 SET action = 'confirmar_recorrente', step = 'waiting_confirmation', tx_ids = $2::jsonb,
                     selected_tx_id = NULL, expires_at = NOW() + INTERVAL '48 hours'`,
              [user.id, JSON.stringify({ nome: r.descricao, valor: r.valor, frequencia: "mensal" })]
            );
            await whatsapp.sendText({
              to: telefone,
              text: `${capitalizeFirst(r.descricao)} aparece todo mês? 🔁`,
            });
            recordInsightSent(user.id);
          }
        } else if (candidatos.length >= 2) {
          // Múltiplos candidatos — insere pending e envia pergunta
          const payload = candidatos.map(r => ({ nome: r.descricao, valor: r.valor, frequencia: "mensal" }));
          const lista   = candidatos.map((r, i) => `${i + 1}. ${capitalizeFirst(r.descricao)} — ${fmtValor(r.valor)}`).join("\n");
          try {
            await pool.query(
              `INSERT INTO pending_actions (user_id, action, step, tx_ids)
               VALUES ($1, 'confirmar_recorrente_multi', 'waiting_selection_multi', $2::jsonb)
               ON CONFLICT (user_id) DO UPDATE
                 SET action = 'confirmar_recorrente_multi', step = 'waiting_selection_multi', tx_ids = $2::jsonb,
                     selected_tx_id = NULL, expires_at = NOW() + INTERVAL '48 hours'`,
              [user.id, JSON.stringify(payload)]
            );
            await whatsapp.sendText({
              to: telefone,
              text: `Algum desses acontece todo mês? 🔁\n\n${lista}\n\n(diz os números ou "todos")`,
            });
            recordInsightSent(user.id);
          } catch (multiErr) {
            log.error("falha ao inserir pending recorrente multi — tentando fallback", multiErr, { userId: user.id });
            // Fallback: pergunta sobre o primeiro candidato individualmente
            const r        = candidatos[0];
            const descNorm = r.descricao.toLowerCase().trim();
            const jaRecDB  = await pool.query(
              `SELECT 1 FROM recurring_expenses WHERE user_id = $1 AND LOWER(TRIM(nome)) = $2 LIMIT 1`,
              [user.id, descNorm]
            );
            if (jaRecDB.rows.length === 0) {
              await pool.query(
                `INSERT INTO pending_actions (user_id, action, step, tx_ids)
                 VALUES ($1, 'confirmar_recorrente', 'waiting_confirmation', $2::jsonb)
                 ON CONFLICT (user_id) DO UPDATE
                   SET action = 'confirmar_recorrente', step = 'waiting_confirmation', tx_ids = $2::jsonb,
                       selected_tx_id = NULL, expires_at = NOW() + INTERVAL '48 hours'`,
                [user.id, JSON.stringify({ nome: r.descricao, valor: r.valor, frequencia: "mensal" })]
              );
              await whatsapp.sendText({
                to: telefone,
                text: `${capitalizeFirst(r.descricao)} aparece todo mês? 🔁`,
              });
              recordInsightSent(user.id);
            }
          }
        } else {
          // Nenhum candidato novo → tenta padrão histórico, mas só para itens sem "(recorrente)"
          const novasSaidas = saidas.filter(r => !r.descricao.toLowerCase().includes("(recorrente)"));
          for (const r of novasSaidas) {
            if (await checkAndSuggestRecorrente(user.id, telefone, r.descricao, r.valor, r.categoria, r.textoOriginal)) {
              recordInsightSent(user.id);
              break;
            }
          }
        }
      } catch (err) {
        log.error("falha ao verificar recorrentes multilinha", err, { userId: user.id });
      }
    }, 1200);
  }

  return {
    success:      true,
    userId:       user.id,
    transacao:    {},
    interpretado: { comando: "multilinha", count: resultados.length },
  };
}
