# Evolution API — Guia Completo de Instalação no EasyPanel

## O que é a Evolution API

Evolution API é uma solução **self-hosted** que conecta o WhatsApp via protocolo WhatsApp Web,
expondo uma API REST para envio e recebimento de mensagens.
Não exige conta WhatsApp Business — funciona com qualquer número pessoal ou comercial.

- Repositório: https://github.com/EvolutionAPI/evolution-api
- Docs: https://doc.evolution-api.com

---

## Arquitetura no Salva Bolso

```
┌──────────────────────────────────────────────────────────────┐
│                         EasyPanel / VPS                       │
│                                                               │
│  ┌─────────────────┐   webhook POST   ┌──────────────────┐   │
│  │  Evolution API  │ ───────────────► │  salva-bolso-    │   │
│  │  :8080          │                  │  backend  :80    │   │
│  └────────┬────────┘                  └────────┬─────────┘   │
│           │ sendText()                          │             │
│           └─────────────────────────────────────┘             │
│                                                               │
│  ┌──────────────┐     ┌────────────────────────────────────┐  │
│  │  Redis :6379 │     │  PostgreSQL (compartilhado)        │  │
│  │  (sessões)   │     │  salva-bolso_postgres-salvabolso   │  │
│  └──────────────┘     └────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
         ▲
         │ WhatsApp Web (QR Code)
         │
  ┌──────┴──────┐
  │  Celular    │
  │  WhatsApp   │
  └─────────────┘
```

**Fluxo completo de uma mensagem:**
1. Usuário envia `"120 mercado"` pelo WhatsApp
2. Evolution API recebe e dispara `POST /webhooks/whatsapp?provider=evolution`
3. Backend identifica o usuário pelo telefone no banco
4. `parseTransaction()` interpreta: valor=120, categoria=Alimentação, tipo=saida
5. Transação é salva no PostgreSQL
6. Backend chama `whatsapp.sendText()` → Evolution API envia confirmação

---

## Arquivos de Configuração

Os arquivos estão em `evolution/` na raiz do projeto:

```
evolution/
├── docker-compose.yml   # Evolution API + Redis
└── .env.example         # Template de variáveis (copie para .env)
```

---

## Opção A — Instalação via EasyPanel (Recomendado)

Esta opção usa o painel para criar os serviços, mantendo tudo no mesmo projeto
e aproveitando a rede interna do EasyPanel.

### Passo 1 — Criar banco `evolution` no PostgreSQL existente

Acesse o serviço PostgreSQL no EasyPanel e execute:

```sql
CREATE DATABASE evolution;
```

Ou via terminal na VPS (substitua os valores):
```bash
docker exec -it CONTAINER_POSTGRES psql -U postgres -c "CREATE DATABASE evolution;"
```

> O container do PostgreSQL pode ter um nome diferente — use `docker ps` para encontrá-lo.

### Passo 2 — Criar serviço Redis

1. No EasyPanel, dentro do projeto `salva-bolso`, clique em **+ Create Service**
2. Escolha **Docker Image**
3. Preencha:
   - Nome: `redis`
   - Imagem: `redis:7-alpine`
   - Porta: `6379`
4. Em **Command**, adicione:
   ```
   redis-server --save 60 1 --loglevel warning --requirepass SUA_SENHA_REDIS
   ```
5. Em **Volumes**, adicione:
   - Origem: `redis_data` (volume)
   - Destino: `/data`
6. Salve e faça deploy

### Passo 3 — Criar serviço Evolution API

1. No EasyPanel, clique em **+ Create Service**
2. Escolha **Docker Image**
3. Preencha:
   - Nome: `evolution-api`
   - Imagem: `atendai/evolution-api:latest`
   - Porta: `8080`
4. Em **Volumes**, adicione:
   - Origem: `evolution_instances` (volume)
   - Destino: `/evolution/instances`
5. Em **Environment Variables**, adicione todas as variáveis da seção abaixo
6. Salve e faça deploy

### Passo 4 — Configurar domínio com HTTPS

1. No serviço `evolution-api`, vá em **Domains**
2. Adicione: `evolution.seu-dominio.com`
3. Ative HTTPS (Let's Encrypt automático do EasyPanel)

Aguarde o certificado ser emitido (geralmente < 2 minutos).

---

## Opção B — Instalação via SSH + Docker Compose

Use esta opção se preferir gerenciar fora do painel.

```bash
# Acesse a VPS
ssh root@ip-da-sua-vps

# Crie a pasta e copie os arquivos do repositório
mkdir -p /opt/evolution
cd /opt/evolution

# Copie docker-compose.yml e .env.example do repositório
# (ou crie manualmente com o conteúdo dos arquivos em evolution/)

cp .env.example .env
nano .env  # edite as variáveis

# Suba os serviços
docker compose up -d

# Verifique os logs
docker compose logs -f evolution-api
```

---

## Variáveis de Ambiente

Cole estas variáveis no serviço `evolution-api` do EasyPanel.
Substitua todos os valores em `MAIÚSCULAS`:

```env
# Servidor
SERVER_TYPE=http
SERVER_PORT=8080
SERVER_URL=https://evolution.seu-dominio.com

CORS_ORIGIN=*
CORS_METHODS=POST,GET,PUT,DELETE
CORS_CREDENTIALS=true

# Autenticação — gere com: openssl rand -hex 32
AUTHENTICATION_TYPE=apikey
AUTHENTICATION_API_KEY=CHAVE_FORTE_GERADA_AQUI
AUTHENTICATION_EXPOSE_IN_FETCH_INSTANCES=true

# Banco — hostname interno do EasyPanel
DATABASE_ENABLED=true
DATABASE_PROVIDER=postgresql
DATABASE_CONNECTION_URI=postgresql://USUARIO:SENHA@salva-bolso_postgres-salvabolso:5432/evolution
DATABASE_CONNECTION_CLIENT_NAME=evolution_api
DATABASE_SAVE_DATA_INSTANCE=true
DATABASE_SAVE_DATA_NEW_MESSAGE=true
DATABASE_SAVE_MESSAGE_UPDATE=true
DATABASE_SAVE_DATA_CONTACTS=true
DATABASE_SAVE_DATA_CHATS=true
DATABASE_SAVE_DATA_LABELS=true
DATABASE_SAVE_DATA_HISTORIC=true

# Redis — hostname interno do EasyPanel (nome do serviço)
CACHE_REDIS_ENABLED=true
CACHE_REDIS_URI=redis://:SUA_SENHA_REDIS@redis:6379/6
CACHE_REDIS_PREFIX_KEY=evolution
CACHE_REDIS_SAVE_INSTANCES=false
CACHE_LOCAL_ENABLED=false

# Webhook global → backend Salva Bolso
WEBHOOK_GLOBAL_ENABLED=true
WEBHOOK_GLOBAL_URL=https://api.seu-dominio.com/webhooks/whatsapp?provider=evolution
WEBHOOK_GLOBAL_WEBHOOK_BY_EVENTS=false
WEBHOOK_EVENTS_MESSAGES_UPSERT=true
WEBHOOK_EVENTS_APPLICATION_STARTUP=false
WEBHOOK_EVENTS_QRCODE_UPDATED=false
WEBHOOK_EVENTS_MESSAGES_SET=false
WEBHOOK_EVENTS_MESSAGES_UPDATE=false
WEBHOOK_EVENTS_MESSAGES_DELETE=false
WEBHOOK_EVENTS_CONNECTION_UPDATE=false
WEBHOOK_EVENTS_CONTACTS_SET=false
WEBHOOK_EVENTS_CONTACTS_UPSERT=false
WEBHOOK_EVENTS_CONTACTS_UPDATE=false
WEBHOOK_EVENTS_CHATS_SET=false
WEBHOOK_EVENTS_CHATS_UPSERT=false
WEBHOOK_EVENTS_CHATS_UPDATE=false
WEBHOOK_EVENTS_CHATS_DELETE=false
WEBHOOK_EVENTS_GROUPS_UPSERT=false
WEBHOOK_EVENTS_GROUP_UPDATE=false
WEBHOOK_EVENTS_GROUPS_PARTICIPANTS_UPDATE=false
WEBHOOK_EVENTS_CALL=false

# Logs
LOG_LEVEL=ERROR
LOG_COLOR=true
LOG_BAILEYS=error
NODE_ENV=production
DEL_INSTANCE=false
```

---

## Variáveis no Backend Salva Bolso

Adicione estas variáveis ao serviço `salva-bolso-backend` no EasyPanel:

```env
WHATSAPP_PROVIDER=evolution
WHATSAPP_EVOLUTION_URL=https://evolution.seu-dominio.com
WHATSAPP_EVOLUTION_KEY=CHAVE_FORTE_GERADA_AQUI
WHATSAPP_EVOLUTION_INSTANCE=salva-bolso
```

> A `WHATSAPP_EVOLUTION_KEY` deve ser **idêntica** ao `AUTHENTICATION_API_KEY` da Evolution API.

---

## Criando a Instância WhatsApp

Com o serviço rodando, crie a instância pelo terminal ou qualquer cliente HTTP:

### 1. Verificar se a API está no ar

```bash
curl https://evolution.seu-dominio.com/
# Esperado: {"status": 200, "message": "..."}
```

### 2. Criar instância

```bash
curl -X POST https://evolution.seu-dominio.com/instance/create \
  -H "Content-Type: application/json" \
  -H "apikey: CHAVE_FORTE_GERADA_AQUI" \
  -d '{
    "instanceName": "salva-bolso",
    "qrcode": true,
    "integration": "WHATSAPP-BAILEYS"
  }'
```

### 3. Obter QR Code

```bash
curl https://evolution.seu-dominio.com/instance/connect/salva-bolso \
  -H "apikey: CHAVE_FORTE_GERADA_AQUI"
```

A resposta inclui `base64` com o QR Code. Para visualizá-lo:
- Cole o valor de `base64` em https://base64.guru/converter/decode/image
- Ou acesse diretamente o painel da Evolution API em `https://evolution.seu-dominio.com`

### 4. Escanear com o celular

1. Abra o **WhatsApp** no celular
2. Vá em **Configurações → Aparelhos conectados → Conectar aparelho**
3. Escaneie o QR Code
4. Aguarde a mensagem de confirmação

> O QR Code expira em ~60 segundos. Se expirar, repita o passo 3.

### 5. Verificar conexão

```bash
curl https://evolution.seu-dominio.com/instance/connectionState/salva-bolso \
  -H "apikey: CHAVE_FORTE_GERADA_AQUI"
```

Resposta esperada:
```json
{ "instance": { "instanceName": "salva-bolso", "state": "open" } }
```

`"state": "open"` = conectado com sucesso.

---

## Configurando o Webhook

### Configurar webhook na instância (específico por instância)

```bash
curl -X POST https://evolution.seu-dominio.com/webhook/set/salva-bolso \
  -H "Content-Type: application/json" \
  -H "apikey: CHAVE_FORTE_GERADA_AQUI" \
  -d '{
    "url": "https://api.seu-dominio.com/webhooks/whatsapp?provider=evolution",
    "webhook_by_events": false,
    "webhook_base64": false,
    "events": ["MESSAGES_UPSERT"]
  }'
```

### Verificar configuração do webhook

```bash
curl https://evolution.seu-dominio.com/webhook/find/salva-bolso \
  -H "apikey: CHAVE_FORTE_GERADA_AQUI"
```

---

## Ativando o Provider no Backend

O código já está pronto em `src/services/whatsapp/providers/EvolutionProvider.ts`.
Basta descomentar:

```typescript
// Abra o arquivo e substitua o bloco stub pelo código real:

async sendText({ to, text }: SendTextParams): Promise<SendResult> {
  const response = await fetch(this.baseUrl, {
    method: "POST",
    headers: {
      apikey: process.env.WHATSAPP_EVOLUTION_KEY!,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ number: to, text }),
  });
  const data = await response.json() as { key?: { id: string } };
  return { success: response.ok, messageId: data.key?.id, provider: this.name };
}
```

Após editar, faça commit e push — o EasyPanel fará o redeploy automaticamente.

---

## Teste End-to-End

### 1. Simular webhook manualmente

```bash
curl -X POST "https://api.seu-dominio.com/webhooks/whatsapp?provider=evolution" \
  -H "Content-Type: application/json" \
  -d '{
    "event": "messages.upsert",
    "instance": "salva-bolso",
    "data": {
      "key": {
        "remoteJid": "5511999999999@s.whatsapp.net",
        "fromMe": false,
        "id": "TEST_001"
      },
      "message": { "conversation": "120 mercado" }
    }
  }'
```

Resposta esperada:
```json
{
  "received": true,
  "processed": true,
  "provider": "evolution",
  "data": {
    "usuario_id": 1,
    "interpretado": {
      "valor": 120,
      "descricao": "mercado",
      "categoria": "Alimentação",
      "tipo": "saida"
    }
  }
}
```

### 2. Teste real pelo WhatsApp

Envie do número conectado para si mesmo (ou de outro número para o conectado):
```
120 mercado
35 gasolina
500 freelance
```

Verifique no banco:
```sql
SELECT * FROM transactions ORDER BY criado_em DESC LIMIT 5;
```

---

## Checklist de Ativação

- [ ] Banco `evolution` criado no PostgreSQL
- [ ] Serviço `redis` criado e rodando no EasyPanel
- [ ] Serviço `evolution-api` criado no EasyPanel
- [ ] Variáveis de ambiente configuradas em `evolution-api`
- [ ] Domínio `evolution.seu-dominio.com` com HTTPS ativo
- [ ] Variáveis `WHATSAPP_PROVIDER`, `WHATSAPP_EVOLUTION_URL`, `WHATSAPP_EVOLUTION_KEY`, `WHATSAPP_EVOLUTION_INSTANCE` adicionadas ao backend
- [ ] `GET /` da Evolution API retorna 200
- [ ] Instância `salva-bolso` criada
- [ ] QR Code escaneado — `state: open`
- [ ] Webhook configurado na instância
- [ ] `EvolutionProvider.ts` com código descomentado
- [ ] Commit + push + redeploy do backend
- [ ] Teste manual do webhook retorna `processed: true`
- [ ] Teste real: enviar mensagem pelo WhatsApp e verificar transação no banco

---

## Manutenção

### Reconectar após desconexão

```bash
# 1. Deletar instância atual
curl -X DELETE https://evolution.seu-dominio.com/instance/logout/salva-bolso \
  -H "apikey: CHAVE_FORTE_GERADA_AQUI"

# 2. Recriar
curl -X POST https://evolution.seu-dominio.com/instance/create \
  -H "Content-Type: application/json" \
  -H "apikey: CHAVE_FORTE_GERADA_AQUI" \
  -d '{ "instanceName": "salva-bolso", "qrcode": true, "integration": "WHATSAPP-BAILEYS" }'

# 3. Novo QR Code
curl https://evolution.seu-dominio.com/instance/connect/salva-bolso \
  -H "apikey: CHAVE_FORTE_GERADA_AQUI"
```

### Ver logs

```bash
# No EasyPanel: aba "Logs" do serviço evolution-api
# Via SSH:
docker logs salva_bolso_evolution --tail 100 -f
```

### Listar instâncias ativas

```bash
curl https://evolution.seu-dominio.com/instance/fetchInstances \
  -H "apikey: CHAVE_FORTE_GERADA_AQUI"
```

---

## Segurança

- Nunca commite `AUTHENTICATION_API_KEY` ou `.env` no repositório
- O `.env.example` em `evolution/` só contém placeholders — sem valores reais
- Use HTTPS em todos os endpoints (EasyPanel gera automaticamente)
- Considere restringir o acesso à porta 8080 no firewall da VPS — apenas o EasyPanel precisa
- Monitore `connectionState` periodicamente para detectar desconexões

---

## Troubleshooting

| Problema | Causa provável | Solução |
|----------|---------------|---------|
| Serviço não sobe | Var de ambiente faltando | Verificar `DATABASE_CONNECTION_URI` e `CACHE_REDIS_URI` |
| QR Code expirou | Timeout de ~60s | Repetir `GET /instance/connect/salva-bolso` |
| `state: close` | Celular desconectou | Seguir fluxo de reconexão acima |
| Webhook não chega | URL errada ou HTTP (não HTTPS) | Verificar `WEBHOOK_GLOBAL_URL` e certificado SSL |
| `processed: false` — usuário não encontrado | Telefone não cadastrado | Cadastrar usuário via `POST /auth/register` com o telefone correto |
| Mensagem não interpretada | Texto fora do padrão | Usar formato `"VALOR DESCRICAO"`, ex: `"50 pizza"` |
| Redis connection refused | Senha errada | Confirmar que `CACHE_REDIS_URI` usa a mesma senha do `--requirepass` |
| Banco `evolution` não existe | Não foi criado | Executar `CREATE DATABASE evolution;` no PostgreSQL |
