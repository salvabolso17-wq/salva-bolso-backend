import Anthropic from "@anthropic-ai/sdk";
import { log } from "../../utils/logger";
import { listarLembretes, type LembreteRow } from "./lembretes";

export type LembreteAcao =
  | "criar"
  | "listar"
  | "pagar"
  | "cancelar"
  | "editar"
  | "ajuda_lembrete"
  | null;

export interface LembreteIntencao {
  acao: LembreteAcao;
  dados: {
    titulo?: string;
    valor?: number;
    dia?: number;
    fixa?: boolean;
    confianca: number;
  };
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function parseValorBR(raw: string): number | null {
  const m = raw.replace(/\s+/g, "").replace(/[r$]/gi, "").match(/^([\d.,]+)$/);
  if (!m) return null;
  let s = m[1];
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else if (/\.\d{1,2}$/.test(s) && !/,/.test(s)) {
    // fica como está
  } else {
    s = s.replace(/[.,]/g, "");
  }
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

function extractDia(t: string): number | undefined {
  const m = t.match(/\bdia\s+(\d{1,2})\b/i) || t.match(/\btodo\s+dia\s+(\d{1,2})\b/i) || t.match(/\b(?:no\s+)?dia\s+(\d{1,2})\b/i);
  if (m) {
    const d = parseInt(m[1], 10);
    if (d >= 1 && d <= 31) return d;
  }
  return undefined;
}

function extractValor(t: string): number | undefined {
  const m = t.match(/r\$\s*([\d.,]+)/i) || t.match(/\b([\d]{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?)\s*(?:reais?|conto[s]?)\b/i) || t.match(/\b(\d+[.,]?\d*)\b/);
  if (!m) return undefined;
  const v = parseValorBR(m[1]);
  return v && v > 0 ? v : undefined;
}

function extractFixa(t: string): boolean | undefined {
  if (/\b(todo\s+m[eê]s|mensal|fixo|fixa|sempre|recorrente|todo\s+dia\s+\d{1,2})\b/i.test(t)) return true;
  if (/\b(uma\s+vez|s[oó]\s+(esse|este)\s+m[eê]s|s[oó]\s+(esse|este)\s+ano|pontual|uma\s+[uú]nica\s+vez)\b/i.test(t)) return false;
  return undefined;
}

function extractTituloCriar(t: string): string | undefined {
  // "lembra/anota/registra/cria [o lembrete d]a luz dia 10 180 reais todo mês"
  const cleaned = t
    .replace(/\b(novo\s+lembrete|criar\s+lembrete|nova\s+conta|anota\s+(?:uma\s+)?conta|anota|anotar|lembra\s+de\s+pagar|lembra\s+de|me\s+lembra\s+de|registra|adiciona|cria(?:r)?\s+(?:um\s+)?lembrete)\b/gi, " ")
    .replace(/\b(dia\s+\d{1,2})\b/gi, " ")
    .replace(/\b(todo\s+m[eê]s|mensal|fixo|fixa|sempre|recorrente|uma\s+vez|s[oó]\s+(esse|este)\s+m[eê]s|s[oó]\s+(esse|este)\s+ano|pontual)\b/gi, " ")
    .replace(/\br\$\s*[\d.,]+/gi, " ")
    .replace(/\b\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?\s*(?:reais?|conto[s]?)?\b/gi, " ")
    .replace(/\b(de|do|da|a|o|os|as|que|pra|para|com|no|na)\b/gi, " ")
    .replace(/[,.]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return undefined;
  return cleaned.length > 60 ? cleaned.slice(0, 60) : cleaned;
}

function extractTituloAlvo(t: string): string | undefined {
  // "paguei a luz" / "cancela a netflix" / "muda a internet"
  const m = t.match(/\b(?:paguei|quitei|j[aá]\s+paguei|foi\s+pago|cancela(?:r)?|cancelei|tira(?:r)?|remove(?:r)?|deleta(?:r)?|apaga(?:r)?|muda(?:r)?|altera(?:r)?|atualiza(?:r)?|edita(?:r)?)\s+(?:o|a|os|as|um|uma|do|da|de|conta\s+(?:de|da|do)|lembrete\s+(?:de|da|do))?\s*([a-záéíóúâêôãõç0-9\s]+?)(?:\s+(?:pra|para|p\/|de\s+r?\$|dia|vence|agora|todo|esse|este|uma|valor)|[?!.,]|$)/i);
  if (m && m[1]) {
    const titulo = m[1].trim().replace(/\s+/g, " ");
    return titulo.length > 60 ? titulo.slice(0, 60) : titulo;
  }
  return undefined;
}

export function heuristicaNLU(texto: string): LembreteIntencao | null {
  const t = texto.trim();
  const tl = t.toLowerCase();

  // CRIAR
  if (/\b(novo\s+lembrete|criar?\s+(?:um\s+)?lembrete|nova\s+conta|anota\s+(?:uma\s+)?conta|anotar?\s+(?:uma\s+)?conta|lembra\s+de\s+pagar|me\s+lembra\s+de\s+pagar|cria\s+(?:um\s+)?lembrete|registra\s+(?:um\s+)?lembrete|adiciona\s+(?:uma\s+)?conta)\b/i.test(tl)) {
    const titulo = extractTituloCriar(t);
    const valor  = extractValor(t);
    const dia    = extractDia(t);
    const fixa   = extractFixa(t);
    const camposPreenchidos = [titulo, valor, dia].filter(v => v !== undefined && v !== "").length;
    return {
      acao: "criar",
      dados: { titulo, valor, dia, fixa, confianca: camposPreenchidos >= 3 ? 0.9 : 0.6 },
    };
  }

  // LISTAR
  if (/\b(minhas\s+contas|meus\s+lembretes|o\s+que\s+tenho\s+(?:pra|para)\s+pagar|quanto\s+vou\s+(?:gastar|pagar)\s+de\s+contas|lista(?:r)?\s+(?:meus?\s+)?lembretes|ver\s+(?:meus?\s+)?lembretes|contas\s+do\s+m[eê]s)\b/i.test(tl)) {
    return { acao: "listar", dados: { confianca: 0.9 } };
  }

  // PAGAR
  if (/\b(paguei|quitei|j[aá]\s+paguei|t[aá]\s+(?:pago|quitad[ao])|foi\s+pago|t[aá]\s+pago|est[aá]\s+pago)\b/i.test(tl)) {
    const titulo = extractTituloAlvo(t);
    return { acao: "pagar", dados: { titulo, confianca: titulo ? 0.85 : 0.5 } };
  }

  // CANCELAR
  if (/\b(cancela(?:r)?|cancelei|tira(?:r)?|remove(?:r)?|deleta(?:r)?|apaga(?:r)?|n[aã]o\s+tenho\s+mais)\b.*\b(lembrete|conta|netflix|spotify|aluguel|luz|[áéíóúâêôãõa-z]+)/i.test(tl)) {
    const titulo = extractTituloAlvo(t);
    return { acao: "cancelar", dados: { titulo, confianca: titulo ? 0.8 : 0.45 } };
  }

  // EDITAR
  if (/\b(muda(?:r)?|altera(?:r)?|atualiza(?:r)?|edita(?:r)?)\b/i.test(tl) && /\b(pra|para|p\/|agora\s+[eé]|dia\s+\d{1,2}|r?\$?\s*\d)/i.test(tl)) {
    const titulo = extractTituloAlvo(t);
    const valor  = extractValor(t);
    const dia    = extractDia(t);
    return { acao: "editar", dados: { titulo, valor, dia, confianca: 0.7 } };
  }

  return null;
}

const LLM_SYSTEM = `Você interpreta mensagens sobre lembretes de contas em português. Responda APENAS em JSON puro, sem texto antes ou depois.

Formato:
{"acao":"criar|listar|pagar|cancelar|editar|null","titulo":"string ou null","valor":número ou null,"dia":1-31 ou null,"fixa":true|false|null}

Sinônimos:
- fixa=true: "todo mês", "mensal", "fixo", "sempre", "recorrente", "todo dia X"
- fixa=false: "uma vez", "só esse mês", "só esse ano", "pontual"
- pagar: "paguei", "quitei", "tá pago", "foi", "já paguei", "luz foi"
- listar: "minhas contas", "meus lembretes", "o que tenho pra pagar"
- cancelar: "cancela", "tira", "remove", "deleta"
- editar: "muda", "altera", "atualiza"

Se não for sobre lembretes/contas, responda {"acao":"null","titulo":null,"valor":null,"dia":null,"fixa":null}.`;

interface LLMOut {
  acao: string;
  titulo: string | null;
  valor: number | null;
  dia: number | null;
  fixa: boolean | null;
}

async function llmNLU(texto: string): Promise<LembreteIntencao | null> {
  try {
    const resp = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      system: [{ type: "text", text: LLM_SYSTEM, cache_control: { type: "ephemeral" } }] as Anthropic.Messages.TextBlockParam[],
      messages: [{ role: "user", content: `Mensagem: "${texto}"` }],
    });
    const raw = resp.content[0]?.type === "text" ? resp.content[0].text.trim() : "";
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]) as LLMOut;
    const acoesValidas = ["criar", "listar", "pagar", "cancelar", "editar"];
    const acao: LembreteAcao = acoesValidas.includes(parsed.acao) ? (parsed.acao as LembreteAcao) : null;
    if (acao === null) return null;
    return {
      acao,
      dados: {
        titulo: parsed.titulo ?? undefined,
        valor: typeof parsed.valor === "number" && parsed.valor > 0 ? parsed.valor : undefined,
        dia: typeof parsed.dia === "number" && parsed.dia >= 1 && parsed.dia <= 31 ? parsed.dia : undefined,
        fixa: typeof parsed.fixa === "boolean" ? parsed.fixa : undefined,
        confianca: 0.75,
      },
    };
  } catch (err) {
    log.error("lembretesNLU LLM falhou", err);
    return null;
  }
}

export async function interpretarLembrete(texto: string): Promise<LembreteIntencao> {
  const heur = heuristicaNLU(texto);
  if (heur && heur.dados.confianca >= 0.85) return heur;

  const llm = await llmNLU(texto);
  if (llm) {
    if (heur) {
      return {
        acao: llm.acao ?? heur.acao,
        dados: {
          titulo: llm.dados.titulo ?? heur.dados.titulo,
          valor: llm.dados.valor ?? heur.dados.valor,
          dia: llm.dados.dia ?? heur.dados.dia,
          fixa: llm.dados.fixa ?? heur.dados.fixa,
          confianca: Math.max(llm.dados.confianca, heur.dados.confianca),
        },
      };
    }
    return llm;
  }

  if (heur) return heur;
  return { acao: null, dados: { confianca: 0 } };
}

const VERBOS_PAGAR = /\b(paguei|quitei|j[aá]\s+paguei|t[aá]\s+(?:pago|quitad[ao])|foi\s+pago|est[aá]\s+pago|foi|t[aá]\s+pago|pago)\b/i;
const VERBOS_CANCELAR = /\b(cancela(?:r)?|cancelei|tira(?:r)?|remove(?:r)?|deleta(?:r)?|apaga(?:r)?|n[aã]o\s+tenho\s+mais)\b/i;

function normTitulo(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
}

// Match contra lembretes pendentes do usuário. Usa antes da LLM porque é mais
// preciso: o título do lembrete real é a fonte de verdade.
function matchPendente(texto: string, lembretes: LembreteRow[]): LembreteRow | null {
  const t = normTitulo(texto);
  for (const l of lembretes) {
    const tit = normTitulo(l.titulo);
    if (!tit) continue;
    const re = new RegExp(`\\b${tit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(t)) return l;
  }
  // 2a passada: cada palavra do título com 4+ chars
  for (const l of lembretes) {
    const tokens = normTitulo(l.titulo).split(/\s+/).filter(w => w.length >= 4);
    for (const w of tokens) {
      const re = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      if (re.test(t)) return l;
    }
  }
  return null;
}

export async function interpretarLembreteComContexto(
  userId: number,
  texto: string,
): Promise<LembreteIntencao & { lembreteId?: number }> {
  // 1) Heurística com contexto: se texto tem verbo de pagar/cancelar E nome de
  //    lembrete pendente do user, resolve sem LLM (alta confiança).
  try {
    const pendentes = (await listarLembretes(userId)).filter(l => l.status === "pendente");
    if (pendentes.length > 0) {
      if (VERBOS_PAGAR.test(texto)) {
        const m = matchPendente(texto, pendentes);
        if (m) {
          log.webhook("lembrete: match pendente PAGAR", { userId, lembreteId: m.id, titulo: m.titulo });
          return { acao: "pagar", dados: { titulo: m.titulo, confianca: 0.98 }, lembreteId: m.id };
        }
      }
      if (VERBOS_CANCELAR.test(texto)) {
        const m = matchPendente(texto, pendentes);
        if (m) {
          log.webhook("lembrete: match pendente CANCELAR", { userId, lembreteId: m.id, titulo: m.titulo });
          return { acao: "cancelar", dados: { titulo: m.titulo, confianca: 0.95 }, lembreteId: m.id };
        }
      }
    }
  } catch (err) {
    log.error("interpretarLembreteComContexto: match pendentes falhou", err, { userId });
  }

  // 2) Fallback: NLU normal (heurística + LLM)
  return await interpretarLembrete(texto);
}
