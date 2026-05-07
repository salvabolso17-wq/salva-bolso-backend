#!/bin/bash
# fix-swarm.sh — Solução definitiva para Docker Swarm VIP/IPVS quebrado
# Rodar na VPS como root
set -e

echo "=== [1/5] Verificando estado atual do IPVS ==="
ipvsadm -Ln 2>/dev/null || echo "ipvsadm nao disponivel"

echo ""
echo "=== [2/5] Aplicando endpoint_mode=dnsrr no backend ==="
docker service update --endpoint-mode dnsrr salva-bolso_backend-salvabolso
echo "OK"

echo ""
echo "=== [3/5] Aguardando servico estabilizar ==="
sleep 5
docker service ps salva-bolso_backend-salvabolso --no-trunc | head -5

echo ""
echo "=== [4/5] Testando resolucao DNS do service name ==="
EVOL_CONTAINER=$(docker ps -q --filter "name=evolution" | head -1)
if [ -z "$EVOL_CONTAINER" ]; then
  echo "Container da Evolution nao encontrado, buscando..."
  docker ps --filter "name=evolution" --format "{{.Names}}: {{.ID}}"
  EVOL_CONTAINER=$(docker ps -q --filter "name=salva_bolso_evolution" | head -1)
fi

if [ -n "$EVOL_CONTAINER" ]; then
  echo "Container Evolution: $EVOL_CONTAINER"
  docker exec "$EVOL_CONTAINER" sh -c "nslookup salva-bolso_backend-salvabolso 2>&1 || wget -qO- http://salva-bolso_backend-salvabolso/ 2>&1"
else
  echo "AVISO: nao encontrou container da Evolution — verifique o nome com 'docker ps'"
fi

echo ""
echo "=== [5/5] Atualizando webhook para usar service name ==="
# Pegar a chave da API da Evolution do .env
EVOL_KEY=$(grep AUTHENTICATION_API_KEY /etc/easypanel/projects/salva-bolso/evolution/code/.env 2>/dev/null \
  || grep AUTHENTICATION_API_KEY /root/salva-bolso/evolution/.env 2>/dev/null \
  || echo "")

if [ -z "$EVOL_KEY" ]; then
  echo "AVISO: Nao consegui ler a chave da Evolution automaticamente."
  echo "Rode manualmente:"
  echo ""
  echo "  curl -X PUT http://localhost:8080/webhook/set/NOME_DA_INSTANCIA \\"
  echo "    -H 'apikey: SUA_CHAVE' \\"
  echo "    -H 'Content-Type: application/json' \\"
  echo "    -d '{\"url\":\"http://salva-bolso_backend-salvabolso/webhooks/whatsapp?provider=evolution\",\"enabled\":true,\"events\":[\"MESSAGES_UPSERT\"]}'"
else
  # Descobrir o nome da instância
  INSTANCE=$(curl -s http://localhost:8080/instance/fetchInstances \
    -H "apikey: $EVOL_KEY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['name'] if d else '')" 2>/dev/null || echo "")

  if [ -z "$INSTANCE" ]; then
    echo "AVISO: Nao consegui descobrir o nome da instancia automaticamente."
    echo "Verifique com: curl http://localhost:8080/instance/fetchInstances -H 'apikey: $EVOL_KEY'"
  else
    echo "Instancia encontrada: $INSTANCE"
    curl -s -X PUT "http://localhost:8080/webhook/set/$INSTANCE" \
      -H "apikey: $EVOL_KEY" \
      -H "Content-Type: application/json" \
      -d "{\"url\":\"http://salva-bolso_backend-salvabolso/webhooks/whatsapp?provider=evolution\",\"enabled\":true,\"events\":[\"MESSAGES_UPSERT\"]}"
    echo ""
    echo "Webhook atualizado!"
  fi
fi

echo ""
echo "=== Concluido ==="
echo "Se o DNS resolveu no passo 4, o sistema esta funcionando com service name permanente."
echo "Se nao resolveu, use o IP direto temporariamente: http://10.0.1.253/webhooks/whatsapp?provider=evolution"
