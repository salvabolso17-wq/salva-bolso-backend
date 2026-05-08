export interface ParsedTransaction {
  valor: number;
  descricao: string;
  categoria: string;
  tipo: "entrada" | "saida";
}

const CATEGORIAS: Record<string, { keywords: string[]; tipo: "entrada" | "saida" }> = {
  Alimentação: {
    keywords: [
      "mercado", "supermercado", "ifood", "pizza", "hamburguer", "lanche",
      "restaurante", "comida", "almoço", "jantar", "café", "padaria",
      "açougue", "hortifruti", "burger", "sushi", "delivery", "refeição",
    ],
    tipo: "saida",
  },
  Transporte: {
    keywords: [
      "gasolina", "uber", "combustível", "ônibus", "metrô", "estacionamento",
      "pedágio", "táxi", "99", "passagem", "moto", "etanol", "diesel",
    ],
    tipo: "saida",
  },
  Moradia: {
    keywords: [
      "aluguel", "condomínio", "água", "luz", "energia", "internet",
      "gás", "iptu", "boleto", "conta",
    ],
    tipo: "saida",
  },
  Lazer: {
    keywords: [
      "cinema", "netflix", "spotify", "jogo", "viagem", "bar", "show",
      "festa", "streaming", "teatro", "disney", "amazon prime",
    ],
    tipo: "saida",
  },
  Saúde: {
    keywords: [
      "farmácia", "remédio", "médico", "consulta", "academia", "dentista",
      "hospital", "plano de saúde", "farmacia",
    ],
    tipo: "saida",
  },
  Educação: {
    keywords: [
      "curso", "faculdade", "livro", "escola", "material", "inglês",
      "idioma", "udemy", "alura", "mensalidade",
    ],
    tipo: "saida",
  },
  Investimentos: {
    keywords: [
      "investimento", "poupança", "tesouro", "ação", "cripto",
      "bitcoin", "fundo", "renda fixa",
    ],
    tipo: "saida",
  },
  "Receita Extra": {
    keywords: [
      "freelance", "salário", "pagamento", "renda", "bônus", "gorjeta",
      "venda", "recebi", "depósito", "pix recebido", "comissão",
    ],
    tipo: "entrada",
  },
};

export function parseTransaction(texto: string): ParsedTransaction | null {
  const textoNorm  = texto.trim();
  const isEntrada  = textoNorm.startsWith("+");
  const textoParse = isEntrada ? textoNorm.slice(1).trim() : textoNorm;

  // Extrai valor: suporta 120, 120.50, 120,50, R$120, R$ 120
  const valorMatch = textoParse.match(/R?\$?\s*(\d+(?:[.,]\d{1,2})?)/i);
  if (!valorMatch) return null;

  const valor = parseFloat(valorMatch[1].replace(",", "."));
  if (isNaN(valor) || valor <= 0) return null;

  const descricao  = textoParse.replace(valorMatch[0], "").trim() || "Sem descrição";
  const textoLower = textoParse.toLowerCase();

  for (const [categoria, config] of Object.entries(CATEGORIAS)) {
    for (const keyword of config.keywords) {
      if (textoLower.includes(keyword)) {
        // + prefix força entrada independente da categoria detectada
        if (isEntrada) {
          return { valor, descricao, categoria: "Receita Extra", tipo: "entrada" };
        }
        return { valor, descricao, categoria, tipo: config.tipo };
      }
    }
  }

  // Sem keyword: + prefix força entrada; caso contrário default saida
  if (isEntrada) {
    return { valor, descricao, categoria: "Receita Extra", tipo: "entrada" };
  }
  return { valor, descricao, categoria: "Outros", tipo: "saida" };
}
