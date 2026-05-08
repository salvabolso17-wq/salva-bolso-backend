#!/bin/bash
echo "=== 1. Labels do servico Evolution no Swarm ==="
docker service inspect salva-bolso_evolution-api --format '{{json .Spec.Labels}}' 2>/dev/null \
  | python3 -m json.tool 2>/dev/null || echo "Servico nao encontrado"

echo ""
echo "=== 2. Servicos Swarm com 'evolution' no nome ==="
docker service ls | grep -i evolution

echo ""
echo "=== 3. Container Evolution — labels atuais ==="
docker inspect $(docker ps -q --filter "name=evolution" | head -1) \
  --format '{{json .Config.Labels}}' 2>/dev/null \
  | python3 -m json.tool 2>/dev/null | grep -i "traefik\|easypanel" | head -30

echo ""
echo "=== 4. Rotas Traefik com 'evolution' ==="
docker exec $(docker ps -q --filter "name=traefik" | head -1) \
  wget -qO- http://localhost:8080/api/http/routers 2>/dev/null \
  | python3 -m json.tool 2>/dev/null \
  | grep -i "evolution\|rule\|name" | head -30

echo ""
echo "=== 5. Dominio configurado no EasyPanel para evolution ==="
cat /etc/easypanel/projects/salva-bolso/evolution-api/config.json 2>/dev/null \
  | python3 -m json.tool 2>/dev/null | head -40 || echo "config.json nao encontrado"

echo ""
echo "=== DONE ==="
