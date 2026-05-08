#!/bin/bash
# fix-evolution.sh — Recovery definitivo da Evolution API
# Recria o servico do zero, limpa ghost DNS, restaura manager e QR
# Preserva: backend, postgres, redis
# Uso: bash fix-evolution.sh

set -euo pipefail

G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; B='\033[1;34m'; N='\033[0m'
ok()   { echo -e "${G}[OK $(date +%H:%M:%S)]${N} $1"; }
info() { echo -e "${B}[>> $(date +%H:%M:%S)]${N} $1"; }
warn() { echo -e "${Y}[!! $(date +%H:%M:%S)]${N} $1"; }
fail() { echo -e "${R}[XX $(date +%H:%M:%S)]${N} $1"; exit 1; }
sep()  { echo -e "${B}================================================${N}"; }

SVC="salva-bolso_evolution-api"
IMAGE="evoapicloud/evolution-api:v2.3.7"
VOLUME="salva-bolso_evolution_instances"
INSTANCE="salva-bolso"
WEBHOOK_URL="http://salva-bolso_backend-salvabolso/webhooks/whatsapp?provider=evolution"
TEST_NUMBER="5568992383325"
QR_PORT=9191
TRAEFIK_CFG="/etc/easypanel/traefik/config/main.yaml"

sep
echo -e "${B}  SALVA BOLSO — RECOVERY DEFINITIVO EVOLUTION${N}"
echo -e "${B}  Preserva: backend, postgres, redis${N}"
sep

# ── 1. Extrair env vars do servico atual ──────────────────────────────────────
info "1/8 Extraindo configuracao do servico atual..."

EVOL_CID=$(docker ps -q --filter "name=evolution" | head -1 || true)
[ -z "$EVOL_CID" ] && fail "Nenhum container Evolution encontrado. Verifique: docker service ls"

EVOL_KEY=$(docker exec "$EVOL_CID" printenv AUTHENTICATION_API_KEY 2>/dev/null || true)
[ -z "$EVOL_KEY" ] && fail "Nao foi possivel ler AUTHENTICATION_API_KEY do container"

# Captura env vars configuradas explicitamente no servico (nao as herdadas da imagem)
mapfile -t ENVS < <(docker service inspect "$SVC" \
  --format '{{range .Spec.TaskTemplate.ContainerSpec.Env}}{{println .}}{{end}}' 2>/dev/null || true)

ok "Configuracao extraida: ${#ENVS[@]} variaveis. API key: ${EVOL_KEY:0:10}..."

# ── 2. Remover servico — elimina ghost DNS e endpoints antigos ─────────────────
sep; info "2/8 Removendo servico Evolution (limpa ghost DNS)..."
docker service rm "$SVC" 2>/dev/null && ok "Servico removido" || warn "Servico nao encontrado, continuando"
info "Aguardando cleanup completo (20s)..."
sleep 20

# Remover containers residuais do Evolution
LEFTOVER=$(docker ps -aq --filter "name=evolution" 2>/dev/null || true)
if [ -n "$LEFTOVER" ]; then
  echo "$LEFTOVER" | xargs docker rm -f 2>/dev/null || true
  ok "Containers residuais removidos"
fi
ok "Cleanup de containers completo"

# ── 3. Limpar sessao antiga do volume ─────────────────────────────────────────
sep; info "3/8 Limpando sessao Baileys corrompida do volume..."
docker run --rm -v "${VOLUME}:/data" alpine \
  sh -c "rm -rf /data/${INSTANCE} 2>/dev/null; echo 'Volume pos-limpeza:'; ls /data/ 2>/dev/null" \
  && ok "Sessao antiga removida" || warn "Volume nao encontrado ou ja vazio"

# ── 4. Garantir Traefik usa service name (nao IP fixo) ────────────────────────
sep; info "4/8 Verificando config Traefik..."
if grep -qE '10\.[0-9]+\.[0-9]+\.[0-9]+:8080' "$TRAEFIK_CFG" 2>/dev/null; then
  sed -i 's|http://10\.[0-9]*\.[0-9]*\.[0-9]*:8080/|http://salva-bolso_evolution-api:8080/|g' "$TRAEFIK_CFG"
  ok "Traefik config restaurada para service name"
else
  ok "Traefik config ja usa service name — nenhuma alteracao"
fi

# ── 5. Recriar servico com endpoint limpo ─────────────────────────────────────
sep; info "5/8 Recriando servico Evolution com endpoint limpo..."

# Montar flags de env vars
ENV_ARGS=()
for e in "${ENVS[@]}"; do
  [[ -n "$e" ]] && ENV_ARGS+=(--env "$e")
done

docker service create \
  --name "$SVC" \
  --image "$IMAGE" \
  --endpoint-mode dnsrr \
  --network "name=easypanel,alias=salva-bolso-evolution-api" \
  --network "name=easypanel-salva-bolso,alias=salva-bolso-evolution-api" \
  --mount "type=volume,source=${VOLUME},target=/evolution/instances" \
  "${ENV_ARGS[@]}"

ok "Servico criado"
info "Aguardando Evolution inicializar (30s)..."
sleep 30

# Aguardar container ficar pronto
EVOL_CID=""
for i in $(seq 1 6); do
  EVOL_CID=$(docker ps -q --filter "name=evolution" | head -1 || true)
  [ -n "$EVOL_CID" ] && break
  warn "Container ainda nao iniciou ($i/6)..."; sleep 5
done
[ -z "$EVOL_CID" ] && fail "Container nao iniciou. Verifique: docker service ps $SVC"

# Aguardar API responder
READY=false
for i in $(seq 1 10); do
  if docker exec "$EVOL_CID" wget -T5 -qO- http://localhost:8080/ 2>/dev/null | grep -q "Evolution"; then
    READY=true; break
  fi
  warn "Aguardando API responder ($i/10)..."; sleep 8
done
$READY || fail "Evolution API nao respondeu apos tentativas. Verifique: docker service logs $SVC"
ok "Evolution API respondendo"

# ── 6. Verificar DNS — deve ter 1 IP apenas ───────────────────────────────────
sep; info "6/8 Verificando DNS (deve retornar 1 IP)..."
TRAEFIK_CID=$(docker ps -q --filter "name=traefik" | head -1 || true)
if [ -n "$TRAEFIK_CID" ]; then
  DNS_OUT=$(docker exec "$TRAEFIK_CID" nslookup salva-bolso_evolution-api 2>/dev/null || true)
  DNS_COUNT=$(echo "$DNS_OUT" | grep "Address:" | grep -v "127.0.0.11" | wc -l)
  if [ "$DNS_COUNT" -eq 1 ]; then
    ok "DNS limpo: 1 IP apenas"
  else
    warn "DNS retornou ${DNS_COUNT} IPs — pode haver instabilidade intermitente por alguns minutos"
  fi
fi

# ── 7. Criar instancia e configurar webhook ───────────────────────────────────
sep; info "7/8 Criando instancia WhatsApp e configurando webhook..."

# Deletar instancia antiga (ignora erro)
docker exec "$EVOL_CID" curl -s -X DELETE \
  -H "apikey: $EVOL_KEY" \
  "http://localhost:8080/instance/delete/$INSTANCE" 2>/dev/null | head -c100 || true
sleep 3

# Criar instancia com webhook ja configurado
CREATE_RESP=$(docker exec "$EVOL_CID" curl -s -X POST \
  -H "apikey: $EVOL_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"instanceName\": \"$INSTANCE\",
    \"qrcode\": true,
    \"integration\": \"WHATSAPP-BAILEYS\",
    \"webhook\": {
      \"url\": \"$WEBHOOK_URL\",
      \"enabled\": true,
      \"events\": [\"MESSAGES_UPSERT\"]
    }
  }" \
  "http://localhost:8080/instance/create" 2>/dev/null || true)
echo "  Instancia: $(echo "$CREATE_RESP" | head -c200)"
ok "Instancia '$INSTANCE' criada com webhook: $WEBHOOK_URL"
sleep 5

# ── 8. QR Code + aguardar escaneamento + validar envio ────────────────────────
sep; info "8/8 Obtendo QR code para escaneamento..."

QR_RESP=$(docker exec "$EVOL_CID" curl -s \
  -H "apikey: $EVOL_KEY" \
  "http://localhost:8080/instance/connect/$INSTANCE" 2>/dev/null || true)

QR_CODE=$(echo "$QR_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('code',''))" 2>/dev/null || true)
QR_B64=$(echo "$QR_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('base64',''))" 2>/dev/null || true)

fuser -k ${QR_PORT}/tcp 2>/dev/null || true
HTTP_PID=""

if command -v qrencode &>/dev/null && [ -n "$QR_CODE" ]; then
  ok "Escaneie com o WhatsApp agora:"
  echo ""
  echo "$QR_CODE" | qrencode -t ANSIUTF8 -s 1
  echo ""
elif [ -n "$QR_B64" ]; then
  echo "$QR_B64" | python3 -c "
import sys, base64
b64 = sys.stdin.read().strip().split(',')[-1]
open('/tmp/qr-evolution.png','wb').write(base64.b64decode(b64))
print('PNG salvo em /tmp/qr-evolution.png')
" 2>/dev/null
  python3 -m http.server $QR_PORT --directory /tmp >/dev/null 2>&1 &
  HTTP_PID=$!
  SERVER_IP=$(curl -s --max-time 3 ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
  sep
  warn "Abra no navegador e escaneie com o WhatsApp:"
  warn "  http://$SERVER_IP:$QR_PORT/qr-evolution.png"
  sep
else
  warn "QR nao disponivel imediatamente — aguardando 15s..."
  sleep 15
  QR_RESP2=$(docker exec "$EVOL_CID" curl -s \
    -H "apikey: $EVOL_KEY" \
    "http://localhost:8080/instance/connect/$INSTANCE" 2>/dev/null || true)
  QR_B64_2=$(echo "$QR_RESP2" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('base64',''))" 2>/dev/null || true)
  if [ -n "$QR_B64_2" ]; then
    echo "$QR_B64_2" | python3 -c "
import sys, base64
b64 = sys.stdin.read().strip().split(',')[-1]
open('/tmp/qr-evolution.png','wb').write(base64.b64decode(b64))
" 2>/dev/null
    python3 -m http.server $QR_PORT --directory /tmp >/dev/null 2>&1 &
    HTTP_PID=$!
    SERVER_IP=$(curl -s --max-time 3 ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
    warn "  http://$SERVER_IP:$QR_PORT/qr-evolution.png"
  else
    warn "QR nao obtido. Acesse manualmente: https://salva-bolso-evolution-api.h5prml.easypanel.host/manager"
  fi
fi

# Aguardar escaneamento (90s)
sep
warn "Escaneie o QR com o WhatsApp. Aguardando conexao (maximo 90s)..."
CONNECTED=false
for i in $(seq 1 18); do
  sleep 5
  STATE=$(docker exec "$EVOL_CID" curl -s \
    -H "apikey: $EVOL_KEY" \
    "http://localhost:8080/instance/connectionState/$INSTANCE" 2>/dev/null \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('instance',{}).get('state','?'))" 2>/dev/null || echo "?")
  [ "$STATE" = "open" ] && CONNECTED=true && ok "WhatsApp conectado! state=open" && break
  info "Estado: $STATE ($i/18)"
done

[ -n "$HTTP_PID" ] && kill "$HTTP_PID" 2>/dev/null || true

sep
if $CONNECTED; then
  sleep 3
  SEND=$(docker exec "$EVOL_CID" curl -s -X POST \
    -H "apikey: $EVOL_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"number\":\"$TEST_NUMBER\",\"text\":\"Bot online! Sessao restaurada. Envie 50 uber para testar.\"}" \
    "http://localhost:8080/message/sendText/$INSTANCE" 2>/dev/null || true)
  STATUS=$(echo "$SEND" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status','?'))" 2>/dev/null || echo "?")
  sep
  ok "SISTEMA RESTAURADO"
  ok "Mensagem de teste enviada — status: $STATUS"
  ok "Manager: https://salva-bolso-evolution-api.h5prml.easypanel.host/manager"
  echo ""
  echo "  Proximo passo: envie '50 uber' pelo WhatsApp e confirme resposta instantanea."
else
  sep
  warn "Timeout — QR nao escaneado em 90s."
  warn "Execute novamente: bash fix-evolution.sh"
  warn "Ou acesse o manager e escaneie manualmente:"
  warn "  https://salva-bolso-evolution-api.h5prml.easypanel.host/manager"
fi
sep
