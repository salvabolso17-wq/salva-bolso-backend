import Anthropic from "@anthropic-ai/sdk";
import { log } from "../../utils/logger";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const VALID_COMMANDS = [
  "saldo", "resumo", "recorrentes", "hoje", "semana",
  "ranking", "metas", "extrato", "ajuda", "proximas",
  "comparar", "top_gastos", "desafio", "previsao", "categorias"
] as const;

type BotCommand = typeof VALID_COMMANDS[number];

const SYSTEM_PROMPT = `Você é um classificador de intenção para um assistente financeiro no WhatsApp chamado Salva Bolso.

Dado uma mensagem do usuário, responda APENAS com o nome do comando mais adequado, sem explicações.

Comandos:
- saldo: saldo do mês, quanto sobrou, quanto tenho disponível
- resumo: gastos por categoria, relatório do mês, quanto gastei
- recorrentes: contas fixas, assinaturas, recorrentes, contas mensais
- hoje: gastos de hoje
- semana: gastos da semana, últimos 7 dias
- ranking: onde gasto mais, maiores categorias
- metas: metas de poupança, objetivos, quanto juntei
- extrato: histórico, extrato, lançamentos do mês
- ajuda: como funciona, o que pode fazer, menu, comandos
- proximas: próximas contas, o que vence
- comparar: comparar com mês passado
- top_gastos: maiores gastos, top 5
- desafio: desafio de economia
- previsao: previsão do mês, estimativa
- categorias: listar categorias
- unknown: pedidos de lembrete, notificação, agendamento, funcionalidades inexistentes, perguntas fora do escopo financeiro

Responda APENAS com o nome do comando. Nada mais.`;

export async function classifyIntentWithAI(texto: string, lastCommand = ""): Promise<BotCommand | null> {
  try {
    const userContent = lastCommand
      ? `Último comando: ${lastCommand}\nMensagem: ${texto}`
      : texto;

    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 20,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }] as Anthropic.Messages.TextBlockParam[],
      messages: [{ role: "user", content: userContent }],
    });

    const text = response.content[0]?.type === "text"
      ? response.content[0].text.trim().toLowerCase()
      : "";

    if ((VALID_COMMANDS as readonly string[]).includes(text) && text !== "unknown") {
      return text as BotCommand;
    }
    return null;
  } catch (err) {
    log.error("classifyIntentWithAI falhou", err);
    return null;
  }
}
