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
│   ├── utils/
│   │   └── parseTransaction.ts # Parser de texto para transação
│   └── routes/
│       ├── auth.ts            # POST /auth/register, POST /auth/login
│       ├── users.ts           # Rotas de usuários
│       └── transactions.ts    # Rotas de transações (protegidas)
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
