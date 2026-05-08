# Salva Bolso — Status Completo da Infraestrutura
**Última atualização:** 2026-05-08
**Sessão encerrada em:** 01:15 (horário de Brasília)
**Próxima sessão:** retomar a partir dos próximos passos listados no final

---

## Resumo Executivo

| Componente | Status | Observação |
|---|---|---|
| Backend (Node.js/Express) | ✅ OK | Funcionando, resposta < 1s confirmada |
| PostgreSQL | ✅ OK | Rodando, dados preservados |
| Redis | ✅ OK | Rodando |
| Evolution API (container) | ✅ Rodando | Imagem ok, API responde internamente |
| Evolution API (instância WhatsApp) | ❌ NÃO CRIADA | Precisa criar instância `salva-bolso` |
| Evolution API (manager público) | ⚠️ INSTÁVEL | Bad Gateway intermitente por ghost DNS |
| WhatsApp QR | ❌ NÃO ESCANEADO | Depende da instância ser criada |
| Webhook backend ← Evolution | ❌ INATIVO | Depende do QR escaneado |
| Docker Swarm IPVS/VIP | ❌ QUEBRADO | Corrigido com dnsrr nos dois serviços |

---

## Histórico: O que Chegou a Funcionar

- **Fluxo completo funcionou em 2026-05-07** — webhook recebia mensagem, bot respondia em < 1s
- Commit estável: `c30408e` (tag `v1.0-stable`)
- Problema começou após adição de features (anti-duplicidade + monitoring) que causaram instabilidade
- Backend foi revertido para versão estável — **o backend em si está OK**
- O problema migrou 100% para infraestrutura: Swarm, Evolution API, Traefik, DNS

---

## Arquitetura Atual

```
Internet
    │
    ▼
Traefik (reverse proxy, EasyPanel)
    │  config: /etc/easypanel/traefik/config/main.yaml
    │
    ├──► salva-bolso-backend-salvabolso.h5prml.easypanel.host
    │       └─► salva-bolso_backend-salvabolso:80  (dnsrr)
    │
    └──► salva-bolso-evolution-api.h5prml.easypanel.host
            └─► salva-bolso_evolution-api:8080  (dnsrr)

Docker Swarm (overlay networks)
    ├── easypanel (rede compartilhada com Traefik)
    └── easypanel-salva-bolso (rede interna do projeto)

Serviços Swarm:
    ├── salva-bolso_backend-salvabolso   (endpoint_mode=dnsrr) ✅
    ├── salva-bolso_evolution-api        (endpoint_mode=dnsrr) ✅ (sem instância)
    ├── salva-bolso_postgres-salvabolso  (padrão)              ✅
    └── salva-bolso_redis                (padrão)              ✅
```

---

## VPS / Servidor

- **Hostname:** `salva-bolso`
- **Painel:** EasyPanel em `https://h5prml.easypanel.host`
- **Traefik config:** `/etc/easypanel/traefik/config/main.yaml`
- **Código do backend:** `/etc/easypanel/projects/salva-bolso/backend-salvabolso/code/`
- **Repositório GitHub:** `git@github.com:salvabolso17-wq/salva-bolso-backend.git`
- **Volume Evolution:** `salva-bolso_evolution_instances` → `/evolution/instances`

---

## URLs

| Serviço | URL |
|---|---|
| EasyPanel | `https://h5prml.easypanel.host` |
| Backend | `https://salva-bolso-backend-salvabolso.h5prml.easypanel.host` |
| Evolution API | `https://salva-bolso-evolution-api.h5prml.easypanel.host` |
| Evolution Manager | `https://salva-bolso-evolution-api.h5prml.easypanel.host/manager` |
| Traefik Dashboard | `https://traefik.h5prml.easypanel.host` |

---

## Variáveis de Ambiente — Evolution API

```
AUTHENTICATION_TYPE=apikey
AUTHENTICATION_API_KEY=salvabolsoevolution123456
AUTHENTICATION_EXPOSE_IN_FETCH_INSTANCES=true

DATABASE_ENABLED=true
DATABASE_PROVIDER=postgresql
DATABASE_CONNECTION_URI=postgresql://admin:adminaccess007@salva-bolso_postgres-salvabolso:5432/evolution
DATABASE_URL=postgresql://admin:adminaccess007@salva-bolso_postgres-salvabolso:5432/evolution
DATABASE_CONNECTION_CLIENT_NAME=evolution_api
DATABASE_SAVE_DATA_INSTANCE=true
DATABASE_SAVE_DATA_NEW_MESSAGE=true
DATABASE_SAVE_MESSAGE_UPDATE=true
DATABASE_SAVE_DATA_CONTACTS=true
DATABASE_SAVE_DATA_CHATS=true
DATABASE_SAVE_DATA_LABELS=true
DATABASE_SAVE_DATA_HISTORIC=true

CACHE_REDIS_ENABLED=true
CACHE_REDIS_URI=redis://default:r3d1sSalvaBolso123@redis:6379
CACHE_REDIS_PREFIX_KEY=evolution
CACHE_REDIS_SAVE_INSTANCES=false
CACHE_LOCAL_ENABLED=true

SERVER_TYPE=http
SERVER_PORT=8080
SERVER_URL=https://salva-bolso-evolution-api.h5prml.easypanel.host
CORS_ORIGIN=*

WEBHOOK_GLOBAL_ENABLED=false
LOG_LEVEL=DEBUG
DEL_INSTANCE=false
CONFIG_SESSION_PHONE_CLIENT=Chrome
QRCODE_LIMIT=30

TZ=America/Sao_Paulo
NODE_ENV=production
```

---

## Variáveis de Ambiente — Backend

```
WHATSAPP_PROVIDER=evolution
WHATSAPP_EVOLUTION_URL=https://salva-bolso-evolution-api.h5prml.easypanel.host
WHATSAPP_EVOLUTION_KEY=salvabolsoevolution123456
WHATSAPP_EVOLUTION_INSTANCE=salva-bolso
```

---

## Redes Docker

| Rede | Driver | Tipo |
|---|---|---|
| `easypanel` | overlay | Swarm — compartilhada com Traefik |
| `easypanel-salva-bolso` | overlay | Swarm — interna do projeto |
| `ingress` | overlay | Swarm padrão |

**Aliases configurados para Evolution:**
- Na rede `easypanel`: alias `salva-bolso-evolution-api`
- Na rede `easypanel-salva-bolso`: alias `salva-bolso-evolution-api`

---

## Problema Raiz: Docker Swarm IPVS Vazio

O Docker Swarm usa IPVS (kernel) para roteamento VIP. No servidor, `ipvsadm -Ln` está vazio — o VIP fica unreachable. Isso afeta TODOS os serviços em VIP mode (padrão).

**Fix aplicado:** `endpoint_mode=dnsrr` nos serviços backend e evolution-api.
Com dnsrr, o DNS resolve diretamente para o IP do container, sem passar pelo IPVS.

```bash
# Já aplicado — não precisa repetir:
docker service update --endpoint-mode dnsrr salva-bolso_backend-salvabolso
docker service update --endpoint-mode dnsrr salva-bolso_evolution-api
```

---

## Problema Secundário: Ghost DNS Endpoints

**Sintoma:** `nslookup salva-bolso_evolution-api` retorna 2-3 IPs, sendo 1 ou 2 fantasmas (containers mortos).

**Causa:** Após múltiplos redeploys e remoções manuais de containers, o Docker Swarm mantém registros DNS de tasks antigas. Traefik alterna entre os IPs em round-robin — quando cai em um IP morto, dá Bad Gateway.

**Tentativas de fix:**
- `docker service update --force` → não limpou
- `docker service scale 0 → 1` → não limpou
- `docker rm` dos containers mortos → não limpou
- Remover e recriar o serviço → ainda persiste por alguns minutos

**Estado atual:** DNS tinha 3 IPs na última verificação. Pode limpar sozinho com o tempo após a recriação do serviço durante `fix-evolution.sh`.

---

## Estado Atual da Evolution API

- Container: **rodando** (1/1 replicas, endpoint_mode=dnsrr)
- Instância `salva-bolso`: **NÃO CRIADA** (script falhou porque container não tem `curl`)
- Sessão Baileys: **limpa** (volume foi limpo pelo script)
- Webhook: **não configurado** (depende da instância)
- QR code: **não gerado**

### Por que o script falhou na criação da instância

O container da Evolution API usa imagem baseada em Node.js que **não tem `curl` instalado**.
O script `fix-evolution.sh` usa `docker exec $CID curl ...` — isso falha com:
```
OCI runtime exec failed: exec: "curl": executable file not found in $PATH
```

**Solução:** usar `wget` dentro do container para todas as chamadas API.
BusyBox wget suporta POST (`--post-data`) e GET. Para DELETE/PUT é necessário workaround.

---

## Próximos Passos (Retomar Aqui)

### Passo 1 — Criar instância manualmente (agora funcional)

A API key é `salvabolsoevolution123456`. Usar `wget` dentro do container:

```bash
cat > /tmp/create-instance.sh << 'EOF'
CID=$(docker ps -q --filter "name=evolution" | head -1)

# Criar instância com webhook embutido
docker exec $CID wget -qO- -T10 \
  --post-data='{"instanceName":"salva-bolso","qrcode":true,"integration":"WHATSAPP-BAILEYS","webhook":{"url":"http://salva-bolso_backend-salvabolso/webhooks/whatsapp?provider=evolution","enabled":true,"events":["MESSAGES_UPSERT"]}}' \
  --header="apikey: salvabolsoevolution123456" \
  --header="Content-Type: application/json" \
  http://localhost:8080/instance/create 2>&1

echo ""
echo "=== Aguardando 5s ==="
sleep 5

# Obter QR code
QR=$(docker exec $CID wget -qO- -T10 \
  --header="apikey: salvabolsoevolution123456" \
  http://localhost:8080/instance/connect/salva-bolso 2>&1)

echo "$QR" | python3 -c "
import sys, json, base64
d = json.load(sys.stdin)
b64 = d.get('base64','')
if b64:
    b64data = b64.split(',')[-1]
    open('/tmp/qr.png','wb').write(base64.b64decode(b64data))
    print('QR salvo em /tmp/qr.png')
else:
    print('QR nao disponivel:', d)
"
EOF
bash /tmp/create-instance.sh
```

### Passo 2 — Servir QR via HTTP para escanear

```bash
python3 -m http.server 9191 --directory /tmp &
# Abrir no navegador: http://IP_DA_VPS:9191/qr.png
```

### Passo 3 — Escanear QR com WhatsApp

Abrir WhatsApp → Dispositivos conectados → Conectar dispositivo → Escanear QR.

### Passo 4 — Validar envio

```bash
cat > /tmp/test-send.sh << 'EOF'
CID=$(docker ps -q --filter "name=evolution" | head -1)
docker exec $CID wget -qO- -T10 \
  --post-data='{"number":"5568992383325","text":"Bot online! Envie 50 uber para testar."}' \
  --header="apikey: salvabolsoevolution123456" \
  --header="Content-Type: application/json" \
  http://localhost:8080/message/sendText/salva-bolso 2>&1
EOF
bash /tmp/test-send.sh
```

---

## Scripts Disponíveis no Repositório

| Script | Descrição |
|---|---|
| `fix-evolution.sh` | Recovery completo — recria serviço, limpa ghost DNS, cria instância, gera QR. **ATENÇÃO: usa curl (não funciona no container atual). Precisa ser atualizado para usar wget.** |
| `recover-evolution.sh` | Recovery de sessão Baileys corrompida (usa curl no host via localhost:8080 — só funciona se porta estiver publicada) |

### fix-evolution.sh — Bug Conhecido

Linha 120 e seguintes usam `docker exec $CID curl` — curl não existe no container.
**Fix necessário:** substituir todas as chamadas `curl` dentro do container por `wget` equivalente.

---

## Hipóteses Descartadas

| Hipótese | Status |
|---|---|
| Backend com bug de código | ❌ Descartada — backend funciona, problema é infra |
| Sessão Baileys corrompida (causa raiz) | ✅ Confirmada e limpa — mas não é mais o bloqueador |
| VIP/IPVS do Swarm (causa raiz) | ✅ Confirmada — fix dnsrr aplicado em ambos serviços |
| Traefik sem labels no container | ✅ Confirmada — Traefik usa main.yaml (file provider), não labels |
| Evolution API inacessível por porta não publicada | ✅ Confirmada — porta 8080 não publicada, acesso só via `docker exec` |

---

## Diagnósticos Confirmados

### Docker Swarm
- `ipvsadm -Ln` vazio → VIP unreachable em todos os serviços
- Fix: `endpoint_mode=dnsrr` nos serviços que precisam de acesso externo via Traefik
- Ghost DNS: task IPs antigas persistem no DNS após remoção — comportamento de bug do Swarm

### Traefik
- EasyPanel usa **file provider** para Traefik (não labels de container)
- Config em: `/etc/easypanel/traefik/config/main.yaml`
- Backend para Evolution: `http://salva-bolso_evolution-api:8080/` (service name DNS)
- Backend para backend: `http://salva-bolso_backend-salvabolso:80/`
- Bad Gateway ocorre quando Traefik acerta um ghost IP no round-robin DNS

### Evolution API
- Imagem: `evoapicloud/evolution-api:v2.3.7`
- Container NÃO tem `curl` — usar `wget` para chamadas internas
- Porta 8080 NÃO publicada no host — chamadas só via `docker exec`
- Volume de sessões: `salva-bolso_evolution_instances` → `/evolution/instances`

### Usuário de Teste
- **ID:** 3
- **Nome:** Ana Castro
- **Telefone (DB):** `5568992383325`
- **Telefone (Evolution LID):** `556892383325` (normalizado via RIGHT(8))

---

## Recomendação Futura: Simplificar Arquitetura

O Docker Swarm adicionou complexidade significativa sem benefício claro para um projeto de escala pequena:
- IPVS quebrado → necessidade de dnsrr
- Ghost DNS endpoints
- Traefik com file provider ao invés de labels
- Impossibilidade de publicar portas facilmente com dnsrr

**Recomendação:** migrar para **Docker Compose simples** (sem Swarm):
- `docker-compose.yml` com todos os serviços
- Traefik com labels de container (mais simples)
- Sem IPVS, sem overlay networks complexas
- Portas publicadas diretamente quando necessário
- Rollback mais simples

Essa migração pode ser feita pelo EasyPanel (suporta Compose além de Swarm) ou manualmente.

---

## Código do Backend — Estado Atual

**Tag estável:** `v1.0-stable` (commit `c30408e`)
**Branch atual:** `main`
**Último commit:** `fe1c02e` (fix script fix-evolution.sh)

### Funcionalidades implementadas e estáveis:
- Webhook `/webhooks/whatsapp?provider=evolution`
- Parser de transações (ex: "50 uber", "120 mercado", "500 freelance")
- Busca de usuário por telefone (RIGHT(8) para normalização)
- LID addressing mode (Evolution v2.3.7)
- Anti-duplicidade via tabela `processed_messages`
- Logs estruturados (`[WEBHOOK][USER][PARSER][DB][WHATSAPP][ERROR]`)
- Confirmação WhatsApp via Evolution API

### Banco de Dados
```sql
-- Tabelas existentes em 'evolution':
users              -- usuários cadastrados (id=3: Ana Castro, tel=5568992383325)
transactions       -- transações financeiras
processed_messages -- anti-duplicidade (message_id PRIMARY KEY)
```

---

## Comandos de Referência Rápida

```bash
# Ver todos os serviços
docker service ls

# Ver tasks de um serviço (e histórico)
docker service ps salva-bolso_evolution-api

# Ver logs da Evolution
docker service logs --tail 50 salva-bolso_evolution-api

# Ver logs do backend
docker service logs --tail 50 salva-bolso_backend-salvabolso

# Entrar no container da Evolution
docker exec -it $(docker ps -q --filter "name=evolution" | head -1) sh

# Testar Evolution internamente
docker exec $(docker ps -q --filter "name=evolution" | head -1) wget -qO- http://localhost:8080/

# Verificar DNS do Traefik
CID=$(docker ps -q --filter "name=traefik" | head -1)
docker exec $CID nslookup salva-bolso_evolution-api

# Verificar endpoint mode de um serviço
docker service inspect salva-bolso_evolution-api -f '{{json .Endpoint}}'

# Aplicar dnsrr (se necessário após redeploy)
docker service update --endpoint-mode dnsrr salva-bolso_evolution-api
docker service update --endpoint-mode dnsrr salva-bolso_backend-salvabolso

# Limpar containers mortos da Evolution
docker ps -a --filter "name=evolution" --filter "status=exited" -q | xargs -r docker rm

# Ver configuração Traefik
cat /etc/easypanel/traefik/config/main.yaml | grep -A5 evolution
```

---

## Estado Final desta Sessão

**O que foi feito:**
1. Diagnosticado: problema é 100% infraestrutura (Swarm/Traefik/Evolution)
2. Confirmado: IPVS vazio → dnsrr aplicado em ambos os serviços
3. Confirmado: Traefik usa file provider (`main.yaml`), não labels
4. Diagnosticado: ghost DNS persiste por múltiplos IPs no Swarm
5. Recriado serviço Evolution via `fix-evolution.sh` (serviço está rodando)
6. Instância WhatsApp NÃO criada (bug no script — curl não existe no container)
7. API key confirmada: `salvabolsoevolution123456`

**O que falta:**
1. Criar instância `salva-bolso` na Evolution (usar wget, não curl)
2. Obter e escanear QR code
3. Validar envio/recebimento end-to-end
4. (Opcional) Atualizar `fix-evolution.sh` para usar wget em vez de curl
