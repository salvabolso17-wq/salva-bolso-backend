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

### Rotas Existentes

| Método | Rota         | Descrição              |
|--------|--------------|------------------------|
| GET    | /            | Health check da API    |
| GET    | /users       | Lista todos os usuários|
| POST   | /users       | Cria um novo usuário   |

### Rotas Planejadas

| Método | Rota                        | Descrição                        |
|--------|-----------------------------|----------------------------------|
| GET    | /users/:id                  | Busca usuário por ID             |
| PUT    | /users/:id                  | Atualiza dados do usuário        |
| POST   | /transactions               | Cria nova transação              |
| GET    | /transactions/:userId       | Lista transações do usuário      |
| DELETE | /transactions/:id           | Remove uma transação             |
| GET    | /transactions/:userId/resumo| Resumo financeiro (entradas, saídas, saldo, qtd, últimas 5) |

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
