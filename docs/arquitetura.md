# Arquitetura do Salva Bolso

## Stack Tecnológica

| Camada      | Tecnologia                  |
|-------------|----------------------------|
| Runtime     | Node.js 20                 |
| Linguagem   | TypeScript 5               |
| Framework   | Express 5                  |
| Banco       | PostgreSQL 15              |
| ORM/Query   | pg (node-postgres)         |
| Deploy      | Docker + EasyPanel         |
| Porta       | 80                         |

## Estrutura de Pastas

```
salva-bolso-backend/
├── src/
│   ├── index.ts               # Entry point, setup do Express
│   ├── database.ts            # Criação/migração das tabelas
│   ├── db/
│   │   └── client.ts          # Configuração do pool PostgreSQL
│   ├── middleware/
│   │   └── auth.ts            # Middleware JWT
│   ├── adapters/
│   │   └── whatsappAdapters.ts # Normaliza payloads Meta / Evolution / 360dialog
│   ├── utils/
│   │   └── parseTransaction.ts # Parser de texto para transação
│   ├── services/
│   │   ├── insightService.ts   # Análise comportamental, score e insights automáticos
│   │   ├── reportService.ts    # Lógica reutilizável de relatórios
│   │   ├── whatsappService.ts  # Busca usuário por telefone e processa mensagem
│   │   └── whatsapp/           # Abstração de envio WhatsApp
│   │       ├── index.ts        # Factory: seleciona provider via WHATSAPP_PROVIDER
│   │       ├── types.ts        # IWhatsAppProvider, SendTextParams, SendResult
│   │       └── providers/
│   │           ├── MockProvider.ts       # Log local (padrão dev)
│   │           ├── MetaProvider.ts       # Stub Meta Cloud API
│   │           ├── EvolutionProvider.ts  # Stub Evolution API
│   │           └── Dialog360Provider.ts  # Stub 360dialog
│   └── routes/
│       ├── auth.ts            # POST /auth/register, POST /auth/login
│       ├── users.ts           # Rotas de usuários
│       ├── transactions.ts    # Rotas de transações (protegidas)
│       ├── financial-goals.ts # CRUD de metas financeiras (protegido)
│       ├── insights.ts        # GET /insights/:userId (protegido)
│       ├── reports.ts         # GET /reports/:userId/monthly|weekly (protegido)
│       └── webhooks.ts        # GET|POST /webhooks/whatsapp (público)
├── dist/                      # Código compilado (gerado pelo tsc)
├── docs/                      # Documentação do projeto
├── Dockerfile
├── package.json
└── tsconfig.json
```

## Banco de Dados

### Tabela: `users`

| Coluna      | Tipo           | Descrição                        |
|-------------|----------------|----------------------------------|
| id          | SERIAL PK      | Identificador único              |
| telefone    | VARCHAR(20)    | Telefone único do usuário        |
| nome        | VARCHAR(100)   | Nome do usuário                  |
| senha       | VARCHAR(255)   | Hash bcrypt da senha             |
| renda       | NUMERIC(10,2)  | Renda mensal principal           |
| renda_extra | NUMERIC(10,2)  | Renda extra mensal               |
| criado_em   | TIMESTAMP      | Data de criação                  |

### Tabela: `financial_goals`

| Coluna          | Tipo           | Descrição                                    |
|-----------------|----------------|----------------------------------------------|
| id              | SERIAL PK      | Identificador único                          |
| user_id         | INTEGER FK     | Referência ao usuário (CASCADE DELETE)       |
| categoria       | VARCHAR(100)   | Categoria da meta (ex: Alimentação)          |
| valor_meta      | NUMERIC(10,2)  | Valor limite mensal                          |
| mes_referencia  | DATE           | Primeiro dia do mês (ex: 2026-05-01)         |
| criado_em       | TIMESTAMP      | Data de criação                              |

> Constraint UNIQUE em (user_id, categoria, mes_referencia)

### Tabela: `transactions`

| Coluna     | Tipo           | Descrição                              |
|------------|----------------|----------------------------------------|
| id         | SERIAL PK      | Identificador único                    |
| user_id    | INTEGER FK     | Referência ao usuário (CASCADE DELETE) |
| tipo       | VARCHAR(20)    | `entrada` ou `saida`                   |
| valor      | NUMERIC(10,2)  | Valor da transação                     |
| categoria  | VARCHAR(100)   | Categoria (alimentação, transporte...) |
| descricao  | TEXT           | Descrição livre                        |
| criado_em  | TIMESTAMP      | Data da transação                      |

## Infraestrutura (EasyPanel)

- A aplicação roda em container Docker gerenciado pelo **EasyPanel**
- O banco PostgreSQL é provisionado como serviço interno no EasyPanel
- A conexão com o banco usa o hostname interno do container: `salva-bolso_postgres-salvabolso`
- Variáveis de ambiente são configuradas no EasyPanel (host, porta, nome, usuário e senha do banco)

## Fluxo de Inicialização

1. Container sobe via `npm start` (roda `dist/index.js`)
2. `createTables()` é chamado e garante que as tabelas existem
3. Express escuta na porta 80
4. Requisições chegam e são roteadas para os handlers correspondentes
