#!/bin/bash
# recover-evolution.sh
# Recupera sessão Baileys corrompida da Evolution API
# Seguro: não toca no backend, banco do app nem Swarm
# Uso: bash recover-evolution.sh

set -euo pipefail

# ── Configuração ──────────────────────────────────────────────────────────────
INSTANCE="salva-bolso"
VOLUME="salva-bolso_evolution_instances"
QR_PORT=9191
WEBHOOK_URL="http://salva-bolso_backend-salvabolso/webhooks/whatsapp?provider=evolution"
TEST_NUMBER="5568992383325"

# ── Cores ─────────────────────────────────────────────────────────────────────
G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; B='\033[1;34m'; N='\033[0m'
ok()   { echo -e "${G}[✓ $(date +%H:%M:%S)]${N} $1"; }
info() { echo -e "${B}[→ $(date +%H:%M:%S)]${N} $1"; }
warn() { echo -e "${Y}[! $(date +%H:%M:%S)]${N} $1"; }
fail() { echo -e "${R}[✗ $(date +%H:%M:%S)]${N} $1"; }
sep()  { echo -e "${B}────────────────────────────────────────────${N}"; }

sep
echo -e "${B}  RECUPERAÇÃO DA SESSÃO EVOLUTION/BAILEYS${N}"
echo -e "${B}  Instância: $INSTANCE${N}"
sep

# ── Localizar container Evolution ─────────────────────────────────────────────
info "Localizando container Evolution..."
EVOL_CID=$(docker ps -q --filter "name=evolution" | head -1)
if [ -z "$EVOL_CID" ]; then
  fail "Container Evolution não encontrado. Verifique: docker ps"
  exit 1
fi
ok "Container encontrado: $EVOL_CID"

# ── Obter API key ─────────────────────────────────────────────────────────────
EVOL_KEY=$(docker exec "$EVOL_CID" printenv AUTHENTICATION_API_KEY 2>/dev/null || true)
if [ -z "$EVOL_KEY" ]; then
  fail "Não foi possível ler AUTHENTICATION_API_KEY do container"
  exit 1
fi
ok "API key obtida"

# ── 1. Forçar delete da instância via API (pode falhar — tudo bem) ─────────────
sep; info "PASSO 1/7 — Forçando delete da instância via API..."
curl -s -X DELETE "http://localhost:8080/instance/delete/$INSTANCE" \
  -H "apikey: $EVOL_KEY" 2>/dev/null | head -1 || true
ok "Delete API executado (erro ignorado se sessão corrompida)"

# ── 2. Parar container ────────────────────────────────────────────────────────
sep; info "PASSO 2/7 — Parando container Evolution..."
docker stop "$EVOL_CID"
ok "Container parado"

# ── 3. Limpar arquivos da sessão ──────────────────────────────────────────────
sep; info "PASSO 3/7 — Removendo sessão corrompida do volume..."
docker run --rm -v "$VOLUME:/data" alpine sh -c \
  "if [ -d /data/$INSTANCE ]; then rm -rf /data/$INSTANCE && echo 'Sessão removida'; else echo 'Sessão já inexistente'; fi && echo 'Conteúdo atual do volume:' && ls /data/"
ok "Sessão limpa"

# ── 4. Reiniciar container ────────────────────────────────────────────────────
sep; info "PASSO 4/7 — Reiniciando Evolution com sessão limpa..."
docker start "$EVOL_CID"
info "Aguardando inicialização (20s)..."
sleep 20

# Verificar se subiu
if ! curl -s "http://localhost:8080/" -m 5 >/dev/null 2>&1; then
  warn "Evolution ainda não responde, aguardando mais 15s..."
  sleep 15
fi
ok "Evolution API respondendo"

# ── 5. Recriar instância ──────────────────────────────────────────────────────
sep; info "PASSO 5/7 — Recriando instância '$INSTANCE'..."
CREATE=$(curl -s -X POST "http://localhost:8080/instance/create" \
  -H "apikey: $EVOL_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"instanceName\":\"$INSTANCE\",\"qrcode\":true,\"integration\":\"WHATSAPP-BAILEYS\"}")
echo "  Resposta: $(echo "$CREATE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('instance',{}).get('instanceName','?'), '|', d.get('hash',{}).get('apikey','')[:10]+'...')" 2>/dev/null || echo "$CREATE" | head -c 200)"
ok "Instância recriada"

sleep 5

# ── 6. Configurar webhook ─────────────────────────────────────────────────────
sep; info "PASSO 6/7 — Reconfigurando webhook..."
WH=$(curl -s -X PUT "http://localhost:8080/webhook/set/$INSTANCE" \
  -H "apikey: $EVOL_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"url\":\"$WEBHOOK_URL\",\"enabled\":true,\"events\":[\"MESSAGES_UPSERT\"]}")
echo "  Webhook: $(echo "$WH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('webhook',{}).get('url','?'))" 2>/dev/null || echo "$WH" | head -c 150)"
ok "Webhook configurado: $WEBHOOK_URL"

# ── 7. Gerar e exibir QR code ─────────────────────────────────────────────────
sep; info "PASSO 7/7 — Obtendo QR code para reconexão..."
sleep 3
QR_RESP=$(curl -s "http://localhost:8080/instance/connect/$INSTANCE" -H "apikey: $EVOL_KEY")
QR_CODE=$(echo "$QR_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('code',''))" 2>/dev/null || true)
QR_B64=$(echo "$QR_RESP"  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('base64',''))" 2>/dev/null || true)

# Tenta renderizar no terminal
if command -v qrencode &>/dev/null && [ -n "$QR_CODE" ]; then
  ok "QR Code (escaneie com o WhatsApp agora):"
  echo ""
  echo "$QR_CODE" | qrencode -t ANSIUTF8 -s 1
else
  # Fallback: serve PNG via HTTP
  if [ -n "$QR_B64" ]; then
    echo "$QR_B64" | python3 -c "
import sys, base64
b64 = sys.stdin.read().strip().split(',')[-1]
open('/tmp/qr-evolution.png','wb').write(base64.b64decode(b64))
" 2>/dev/null
    # Mata servidor anterior se existir
    fuser -k ${QR_PORT}/tcp 2>/dev/null || true
    python3 -m http.server $QR_PORT --directory /tmp >/dev/null 2>&1 &
    HTTP_PID=$!
    SERVER_IP=$(curl -s --max-time 3 ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
    echo ""
    warn "═══════════════════════════════════════════════════"
    warn "  Abra no navegador e escaneie com o WhatsApp:"
    warn "  http://$SERVER_IP:$QR_PORT/qr-evolution.png"
    warn "═══════════════════════════════════════════════════"
    echo ""
  else
    warn "QR não obtido ainda. Aguardando instância ficar pronta..."
    sleep 10
    # Segunda tentativa
    QR_RESP2=$(curl -s "http://localhost:8080/instance/connect/$INSTANCE" -H "apikey: $EVOL_KEY")
    echo "Resposta: $(echo "$QR_RESP2" | head -c 200)"
  fi
fi

# ── Aguardar escaneamento ──────────────────────────────────────────────────────
sep
warn "Escaneie o QR com o WhatsApp agora."
warn "Aguardando conexão (máx 90 segundos)..."
echo ""

CONNECTED=false
for i in $(seq 1 18); do
  sleep 5
  STATE=$(curl -s "http://localhost:8080/instance/connectionState/$INSTANCE" \
    -H "apikey: $EVOL_KEY" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('instance',{}).get('state','?'))" 2>/dev/null || echo "?")

  if [ "$STATE" = "open" ]; then
    CONNECTED=true
    ok "WhatsApp conectado! state=open"
    break
  fi
  info "Aguardando... estado atual: $STATE (${i}/18)"
done

# Mata servidor HTTP se existir
kill "${HTTP_PID:-}" 2>/dev/null || true

sep
if [ "$CONNECTED" = true ]; then
  ok "CONEXÃO ESTABELECIDA — testando envio direto..."
  sleep 3
  SEND=$(curl -s -X POST "http://localhost:8080/message/sendText/$INSTANCE" \
    -H "apikey: $EVOL_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"number\":\"$TEST_NUMBER\",\"text\":\"✅ Sessão recuperada com sucesso! Bot online.\"}")
  STATUS=$(echo "$SEND" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status','?'))" 2>/dev/null || echo "?")
  echo "  Status do envio: $STATUS"
  if [ "$STATUS" != "?" ]; then
    ok "Mensagem enviada! Verifique o WhatsApp."
  else
    warn "Envio retornou formato inesperado: $(echo "$SEND" | head -c 200)"
  fi
else
  fail "Timeout — QR não escaneado em 90 segundos."
  fail "Execute novamente: bash recover-evolution.sh"
fi

sep
echo ""
ok "Script concluído."
echo "  Próximo passo: envie uma mensagem de teste pelo WhatsApp (ex: '50 uber')"
echo "  e confirme que o bot responde imediatamente."
echo ""
