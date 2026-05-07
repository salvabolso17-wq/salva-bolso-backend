# Regras do Projeto

## Padrão de Rotas

### Convenções

- Todas as rotas usam **kebab-case** em minúsculo (ex: `/transactions`, `/users`)
- Rotas agrupadas por recurso em arquivos separados dentro de `src/routes/`
- Cada arquivo de rota é registrado no `index.ts` com `app.use("/recurso", rotaRecurso)`
- Respostas sempre em JSON

### Estrutura de Resposta

**Sucesso:**
```json
{
  "message": "Descrição do sucesso",
  "data": { }
}
```

**Erro:**
```json
{
  "error": "Descrição do erro"
}
```

### Métodos HTTP

| Método | Uso                        |
|--------|----------------------------|
| GET    | Buscar/listar recursos     |
| POST   | Criar novo recurso         |
| PUT    | Atualizar recurso completo |
| PATCH  | Atualizar campo específico |
| DELETE | Remover recurso            |

### Rotas Públicas

| Método | Rota                     | Descrição                                          |
|--------|--------------------------|----------------------------------------------------|
| GET    | /                        | Health check da API                                |
| POST   | /auth/register           | Registra usuário com senha                         |
| POST   | /auth/login              | Login, retorna JWT                                 |
| GET    | /users                   | Lista todos os usuários                            |
| POST   | /users                   | Cria usuário (sem senha)                           |
| GET    | /webhooks/whatsapp       | Verificação do webhook (Meta hub.challenge)        |
| POST   | /webhooks/whatsapp       | Recebe mensagem WhatsApp (?provider=meta\|evolution\|360dialog) |

### Rotas Protegidas (requerem Bearer JWT)

| Método | Rota                              | Descrição                                        |
|--------|-----------------------------------|--------------------------------------------------|
| POST   | /transactions/quick-add           | Cria transação a partir de texto simples         |
| POST   | /financial-goals                  | Cria meta mensal por categoria                   |
| GET    | /financial-goals/:userId          | Lista metas do usuário                           |
| GET    | /financial-goals/:userId/resumo   | Resumo de progresso com status e alertas         |
| PUT    | /financial-goals/:id              | Atualiza meta                                    |
| DELETE | /financial-goals/:id              | Remove meta                                      |
| GET    | /insights/:userId                 | Insights automáticos, score e alertas financeiros|
| GET    | /reports/:userId/monthly          | Relatório mensal com comparativo e gráfico       |
| GET    | /reports/:userId/weekly           | Relatório semanal com comparativo e gráfico      |



| Método | Rota                          | Descrição                                             |
|--------|-------------------------------|-------------------------------------------------------|
| GET    | /users/:id                    | Busca usuário por ID                                  |
| PUT    | /users/:id                    | Atualiza dados do usuário                             |
| POST   | /transactions                 | Cria nova transação                                   |
| GET    | /transactions/:userId         | Lista transações do usuário                           |
| DELETE | /transactions/:id             | Remove uma transação                                  |
| GET    | /transactions/:userId/resumo  | Resumo financeiro (entradas, saídas, saldo, qtd, últimas 5) |

---

## Padrão de Banco de Dados

### Convenções

- Nomes de tabelas em **snake_case** e no **plural** (ex: `users`, `transactions`)
- Nomes de colunas em **snake_case** (ex: `criado_em`, `renda_extra`)
- Toda tabela tem `id SERIAL PRIMARY KEY`
- Toda tabela tem `criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP`
- Chaves estrangeiras com `ON DELETE CASCADE` quando o registro filho não faz sentido sem o pai
- Valores monetários usam `NUMERIC(10,2)` — nunca `FLOAT` ou `REAL`

### Queries

- Usar sempre **queries parametrizadas** (`$1`, `$2`...) para evitar SQL injection
- Nunca concatenar strings diretamente em queries SQL
- Usar `pool.query()` do `node-postgres` diretamente (sem ORM)

### Migrações

- As tabelas são criadas via `createTables()` em `src/database.ts` usando `CREATE TABLE IF NOT EXISTS`
- Alterações de schema devem ser adicionadas nesse arquivo ou em scripts de migração separados

---

## Padrão de Código

- TypeScript estrito — sem `any` sem justificativa
- Cada rota em seu próprio arquivo dentro de `src/routes/`
- Erros tratados com `try/catch` em todo handler de rota
- Status HTTP corretos: `200` OK, `201` Created, `400` Bad Request, `404` Not Found, `500` Internal Server Error
