export interface ParsedTransaction {
  valor: number;
  descricao: string;
  categoria: string;
  tipo: "entrada" | "saida";
}

// Keywords escritas com grafia natural; removerAcentos cuida do matching sem acento
function removerAcentos(str: string): string {
  return str.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const CATEGORIAS: Record<string, { keywords: string[]; tipo: "entrada" | "saida" }> = {
  Alimentação: {
    keywords: [
      // Delivery apps
      "uber eats", "ubereats", "ifood", "rappi", "james delivery", "aiqfome",
      // Redes e marcas
      "mcdonald's", "mcdonalds", "mcdonald", "mc donald",
      "burger king", "burguer king",
      "kfc", "subway", "bob's", "bobs", "habib's", "habibs",
      "giraffas", "spoleto", "outback", "pizza hut", "dominos",
      "frango assado", "jerônimo", "jeronimo",
      // Supermercados
      "pão de açúcar", "pao de acucar",
      "carrefour", "atacadão", "atacadao", "assaí", "assai",
      "atakarejo", "supermercado", "minimercado", "mercadinho",
      "sacolão", "sacaolao", "hortifruti", "verdurão", "feirinha",
      "feira livre", "açougue", "acougue", "mercado",
      // Estabelecimentos
      "restaurante", "lanchonete", "cantina", "bistrô", "bistro",
      "padaria", "confeitaria",
      // Comidas
      "pizza", "hamburguer", "hamburger", "lanche", "lanches",
      "refeição", "refeicao", "almoço", "almoco", "jantar",
      "café da manhã", "cafe da manha",
      "açaí", "acai", "sorvete", "gelato",
      "pastel", "coxinha", "salgado", "salgados",
      "carne", "carne bovina", "picanha", "fraldinha", "linguiça", "linguica",
      "espetinho", "churrasco", "tapioca", "crepe", "waffle", "churros",
      "esfiha", "esfira", "quibe", "kibbeh",
      "sushi", "temaki", "yakisoba",
      "pão", "sanduiche", "sanduíche", "wrap", "salada",
      "bolo", "torta", "doce", "sobremesa",
      // Bebidas não alcoólicas
      "suco", "vitamina", "smoothie", "refrigerante", "água mineral",
      // Refeição informal
      "marmita", "marmitex", "quentinha", "prato feito", "self service",
      "buffet", "rodízio", "rodizio",
      // Genérico
      "delivery", "comida", "café", "cafe", "burger", "burguer",
    ],
    tipo: "saida",
  },
  Transporte: {
    keywords: [
      // Apps
      "uber", "99taxi", "99pop", "cabify", "indriver", "indrive",
      "bolt", "lady driver",
      // Combustível
      "gasolina", "etanol", "álcool", "alcool", "diesel",
      "combustível", "combustivel", "abastecimento", "gnv",
      // Transporte público
      "ônibus", "onibus", "metrô", "metro", "trem",
      "passagem", "bilhete único", "bilhete unico",
      "cartão transporte", "cartao transporte",
      "brt", "vlt", "barca", "balsa", "ferry",
      "sptrans",
      // Veículos e manutenção
      "estacionamento", "pedágio", "pedagio",
      "oficina", "mecânico", "mecanico", "funilaria",
      "pneu", "revisão", "revisao",
      "troca de óleo", "troca de oleo",
      "lava rápido", "lava rapido", "lavagem",
      "seguro veicular", "seguro do carro",
      "ipva", "multa", "despachante",
      // Veículos
      "carro", "detran",
      // Outros
      "táxi", "taxi", "van", "moto", "lotação",
      "patinete", "bicicleta", "posto",
      // Short — word-boundary garante sem falso positivo
      "99",
    ],
    tipo: "saida",
  },
  Moradia: {
    keywords: [
      // Aluguel e taxas
      "aluguel", "alguel", "alugel", "condomínio", "condominio", "iptu", "boleto",
      // Água
      "conta de água", "conta de agua", "água", "agua",
      "sabesp", "copasa", "saneamento",
      // Energia
      "conta de luz", "energia elétrica", "energia eletrica", "energia",
      "enel", "cemig", "copel", "cpfl", "light",
      "luz",
      // Gás
      "conta de gás", "conta de gas", "gás encanado", "gas encanado",
      "gás", "gas",
      // Internet
      "internet", "banda larga", "fibra",
      "wifi", "wi-fi",
      "oi fibra", "claro internet", "vivo fibra", "tim internet",
      // Telefone fixo
      "telefone fixo", "linha fixa",
      // Serviços domésticos
      "diarista", "faxina", "empregada doméstica", "empregada domesica",
      "empregada", "faxineira",
      // Manutenção
      "manutenção", "manutencao", "reparo", "reforma",
      "encanador", "eletricista", "pintura", "marido de aluguel",
      // Construção e reforma
      "sofá", "sofa", "cama", "colchão", "colchao",
      "pedreiro", "madeira", "tinta", "construção", "construcao",
      "material de construção", "material de construcao",
      // Mobília
      "móveis", "moveis", "mobília", "mobilia",
      "decoração", "decoracao",
      // Genérico
      "conta",
    ],
    tipo: "saida",
  },
  Lazer: {
    keywords: [
      // Streaming vídeo
      "netflix", "disney plus", "disney+", "disney",
      "hbo max", "hbomax", "hbo",
      "amazon prime", "prime video", "prime",
      "globoplay", "telecine",
      "star plus", "star+",
      "paramount plus", "paramount+",
      "crunchyroll", "apple tv",
      "youtube premium", "youtube",
      "chatgpt", "openai", "anthropic", "canva",
      "xbox game pass", "playstation plus", "ps plus",
      // Streaming música
      "spotify", "deezer", "tidal", "apple music",
      // Entretenimento físico
      "cinema", "teatro", "show", "concerto",
      "ingresso", "sympla", "eventbrite",
      "boliche", "karting", "parque", "aquário", "aquario",
      "zoológico", "zoo", "museu",
      // Viagens
      "passagem aérea", "passagem aerea",
      "hotel", "pousada", "hostel", "airbnb", "booking",
      "resort", "cruzeiro", "viagem",
      // Festas e social
      "festa", "balada", "aniversário", "aniversario",
      "ingresso jogo",
      // Bar e bebidas alcoólicas
      "cerveja", "chopp", "vinho", "caipirinha", "drinque",
      "bar", "pub", "botequim", "happy hour",
      // Jogos
      "steam", "playstation", "xbox", "nintendo",
      "jogo", "game",
      // Esportes lazer
      "futebol", "basquete", "vôlei", "volei", "tênis de quadra",
      // Outros
      "presente", "streaming",
    ],
    tipo: "saida",
  },
  Saúde: {
    keywords: [
      // Farmácias
      "farmácia", "farmacia", "drogaria", "drogasil",
      "ultrafarma", "pacheco", "panvel",
      // Medicamentos
      "remédio", "remedio", "medicamento", "medicamentos",
      "antibiótico", "antibiotico",
      // Suplementos
      "vitamina", "suplemento", "whey", "creatina",
      "colágeno", "colageno", "proteína", "proteina", "ômega", "omega",
      // Profissionais
      "médico", "medico", "médica", "medica",
      "dentista", "ortodontista",
      "psicólogo", "psicologo", "psicóloga", "psicologa",
      "terapeuta", "nutricionista", "fisioterapeuta",
      "fonoaudiólogo", "fonoaudiologo",
      // Locais
      "hospital", "clínica", "clinica", "pronto socorro",
      // Exames e consultas
      "consulta", "exame",
      "laboratório", "laboratorio",
      "ultrassom", "tomografia",
      "ressonância", "ressonancia",
      "check up", "checkup",
      // Plano de saúde
      "plano de saúde", "plano de saude",
      "convênio", "convenio", "amil", "unimed",
      // Fitness
      "academia", "personal trainer", "personal",
      "pilates", "yoga", "crossfit",
      "natação", "natacao", "musculação", "musculacao",
      "spinning", "funcional",
    ],
    tipo: "saida",
  },
  Educação: {
    keywords: [
      // Plataformas
      "udemy", "alura", "coursera", "rocketseat",
      "skillshare", "domestika", "pluralsight",
      "linkedin learning", "duolingo", "babbel", "busuu",
      // Idiomas
      "cultura inglesa", "wizard", "ccaa", "fisk",
      "inglês", "ingles", "espanhol",
      // Instituições
      "faculdade", "universidade", "escola",
      "colégio", "colegio", "creche", "berçário", "bercario",
      // Cursos e materiais
      "curso", "mensalidade", "matrícula", "matricula",
      "livro", "livros", "apostila",
      "material escolar", "papelaria", "caderno",
      // Cursos intensivos
      "treinamento", "workshop", "bootcamp",
      // Concursos
      "vestibular", "enem", "concurso público", "concurso",
    ],
    tipo: "saida",
  },
  Vestuário: {
    keywords: [
      // Roupas
      "roupa", "roupas", "vestido", "calça", "calca",
      "camiseta", "camisa", "blusa", "jaqueta", "casaco",
      "bermuda", "shorts", "saia",
      "cueca", "sutiã", "sutia", "meia", "meias",
      // Calçados
      "sapato", "sandália", "sandalia",
      "chinelo", "bota", "sapatilha", "scarpin",
      // Lojas
      "zara", "renner", "riachuelo", "hering",
      "arezzo", "shein", "nike", "adidas", "puma", "mizuno",
      "new balance",
      // Acessórios
      "bolsa", "cinto", "relógio", "relogio",
      "óculos", "oculos", "boné", "bone",
      // Tênis separado (calçado) — não conflita com esporte
      "tênis", "tenis",
    ],
    tipo: "saida",
  },
  Investimentos: {
    keywords: [
      "investimento", "poupança", "poupanca",
      "tesouro direto", "tesouro",
      "cdb", "lci", "lca", "renda fixa",
      "debênture", "debenture",
      "ação", "acao", "ações", "acoes",
      "fundo", "etf", "fii",
      "cripto", "bitcoin", "btc", "ethereum", "eth",
      "previdência", "previdencia", "pgbl", "vgbl",
      "nuinvest", "rico",
    ],
    tipo: "saida",
  },
  "Receita Extra": {
    keywords: [
      "freelance", "salário", "salario",
      "bônus", "bonus", "gorjeta", "venda",
      "depósito", "deposito", "comissão", "comissao",
      "décimo terceiro", "decimo terceiro",
      "férias", "ferias", "fgts",
      "rescisão", "rescisao",
      "reembolso", "restituição", "restituicao",
      "dividendo", "cashback",
      "autônomo", "autonomo",
      "recebi", "recebimento", "pagamento", "renda",
    ],
    tipo: "entrada",
  },
};

const NOME_CORRECTIONS: [RegExp, string][] = [
  [/^i\s*food$/i,           "iFood"],
  [/^spotif[yi]$/i,         "Spotify"],
  [/^net[if]lix$/i,         "Netflix"],
  [/^netiflix$/i,           "Netflix"],
  [/^netfix$/i,             "Netflix"],
  [/^disney(\+|plus)?$/i,   "Disney+"],
  [/^amazon\s*prime$/i,     "Amazon Prime"],
  [/^prime\s*video$/i,      "Prime Video"],
  [/^uber\s*eats$/i,        "Uber Eats"],
  [/^alguel?$/i,            "Aluguel"],
  [/^alugel$/i,             "Aluguel"],
  [/^mercdo$/i,             "Mercado"],
  [/^mercaddo$/i,           "Mercado"],
  [/^nubank$/i,             "Nubank"],
  [/^academia$/i,           "Academia"],
  [/^internet$/i,           "Internet"],
  [/^celular$/i,            "Celular"],
  [/^energia$/i,            "Energia"],
  [/^luz$/i,                "Conta de Luz"],
  [/^agua$/i,               "Conta de Água"],
  [/^gas$/i,                "Gás"],
  [/^condomin?io$/i,        "Condomínio"],
];

// Strip verbo + preposição de frases naturais: "gastei 60 com uber" → "uber"
const VERB_PREFIX_RE   = /^(gastei|gastou|gastamos|gasto|gasta|paguei|pagou|pagamos|pago|paga|foi|fui|saiu|custou|custa|comprei|comprou|compramos|tomei|tomou|tomamos|usei|usou|usamos|rodei|tirei|tirou|tiramos|fiz|fez|fizemos|botei|botou|botamos|coloquei|devolvi|transferi)\s+/i;
const PREP_PREFIX_RE   = /^(com|no|na|nos|nas|de|da|do|em|pro|pra|pras|pros|para|num|numa|ao|aos|pelo|pela|pelos|pelas|um|uma|o|a)\s+/i;
const MODIFIER_PREP_RE = /^(comida|refeição|refeicao|bebida|lanche|produto|serviço|servico|gasto|compra|conta|coisa)\s+(no|na|nos|nas|de|da|do|em|pro|pra|para|com|ao)\s+/i;

// Strip marcadores temporais no final da frase: "Uber ontem", "Mercado hoje de manhã"
const TEMPORAL_SUFFIX_RE = /\s+(ontem|hoje|agora|agora\s+pouco|a\s+pouco|essa\s+semana|esta\s+semana|nessa\s+semana|no\s+fim\s+de\s+semana|fim\s+de\s+semana|de\s+manh[aã]|de\s+tarde|de\s+noite|[àa]\s+noite|cedo|tarde|semana\s+passada|m[eê]s\s+passado|mais\s+cedo|mais\s+tarde|agora\s+mesmo|hoje\s+cedo|hoje\s+de\s+manh[aã]|hoje\s+de\s+tarde|ontem\s+[àa]\s+noite|hoje\s+[àa]\s+noite)$/i;

// Strip sufixos de canal irrelevantes: "pelo app", "no site", "online"
const CHANNEL_SUFFIX_RE = /\s+(pelo\s+app|no\s+app|via\s+app|pelo\s+celular|no\s+celular|online|pelo\s+site|no\s+site|via\s+site|pelo\s+whatsapp)$/i;

function cleanDescricao(raw: string): string {
  let d = raw.trim();
  d = d.replace(VERB_PREFIX_RE, "").trim();
  d = d.replace(PREP_PREFIX_RE, "").trim();
  d = d.replace(MODIFIER_PREP_RE, "").trim();
  d = d.replace(TEMPORAL_SUFFIX_RE, "").trim();
  d = d.replace(CHANNEL_SUFFIX_RE, "").trim();
  return d || raw.trim();
}

function normalizeDescricao(descricao: string): string {
  const trimmed = descricao.trim();
  for (const [pattern, normalized] of NOME_CORRECTIONS) {
    if (pattern.test(trimmed)) return normalized;
  }
  return trimmed;
}

export function parseTransaction(texto: string): ParsedTransaction | null {
  const textoNorm  = texto.trim();
  const isEntrada  = textoNorm.startsWith("+");
  const textoParse = isEntrada ? textoNorm.slice(1).trim() : textoNorm;

  // Extrai valor: suporta 120, 120.50, 120,50, R$120, R$ 120
  const valorMatch = textoParse.match(/R?\$?\s*(\d+(?:[.,]\d{1,2})?)/i);
  if (!valorMatch) return null;

  const valor = parseFloat(valorMatch[1].replace(",", "."));
  if (isNaN(valor) || valor <= 0) return null;

  const descricao  = normalizeDescricao(cleanDescricao(
    textoParse.replace(valorMatch[0], "").replace(/\+/g, "").trim() || "Sem descrição"
  ));

  // Texto normalizado (sem acentos, minúsculo) para matching consistente
  const textoLower = removerAcentos(textoParse.toLowerCase());

  // Longest-match: a keyword mais longa que bate vence
  // (ex: "uber eats" ganha de "uber" → categoria correta)
  let bestCategoria: string | null = null;
  let bestTipo: "entrada" | "saida" = "saida";
  let bestLen = 0;

  for (const [categoria, config] of Object.entries(CATEGORIAS)) {
    for (const keyword of config.keywords) {
      const kw = removerAcentos(keyword.toLowerCase());
      if (kw.length <= bestLen) continue; // só processa se puder melhorar

      // Keywords curtas (≤4): word-boundary para evitar falsos positivos
      // Longas: substring suficiente
      const matched = kw.length <= 4
        ? new RegExp(`(?<![a-z0-9])${escapeRegex(kw)}(?![a-z0-9])`).test(textoLower)
        : textoLower.includes(kw);

      if (matched) {
        bestCategoria = categoria;
        bestTipo      = config.tipo;
        bestLen       = kw.length;
      }
    }
  }

  // + forçado sempre entra como Receita Extra independente de keyword
  if (isEntrada) {
    return { valor, descricao, categoria: "Receita Extra", tipo: "entrada" };
  }

  if (bestCategoria) {
    return { valor, descricao, categoria: bestCategoria, tipo: bestTipo };
  }

  return { valor, descricao, categoria: "Outros", tipo: "saida" };
}
