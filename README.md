# Chiru MultiTracker

Agregador e monitor de trackers BitTorrent em Node.js, com dashboard web, gerador de magnet links, verificação de endpoints, histórico local e API HTTP.

## Requisitos

- Node.js 18 ou superior
- Rede com acesso aos trackers que você deseja verificar

## Executar no Termux

```sh
pkg install nodejs
git clone https://github.com/chirusanrestart/chiru-multi-tracker.git
cd chiru-multi-tracker
npm test
npm start
```

Por padrão, o servidor escuta na porta `3000`. Para escolher outra porta:

```sh
PORT=8080 npm start
```

O histórico é salvo em `data/history.json`, criado automaticamente e ignorado pelo Git. As verificações são repetidas a cada cinco minutos; no máximo cinco trackers são verificados em paralelo.

## API

- `GET /` - dashboard web
- `POST /api/refresh` - dispara uma verificação manual (retorna 409 se já houver uma em andamento)
- `GET /api/magnet?hash=INFOHASH&dn=NOME` - gera um magnet link com os trackers configurados; `hash` aceita 40 caracteres hexadecimais ou 32 em Base32
- `GET /` - dashboard web
- `GET /api/status` - estado geral do serviço e horário da última verificação
- `GET /api/trackers` - lista completa; filtros opcionais: `category`, `status` e `protocol`
- `GET /api/list` - URLs dos trackers marcados como online, ordenadas por latência; filtro opcional: `protocol`
- `GET /api/history?limit=24` - snapshots recentes (limite máximo de 288)
- `GET /api/history/summary` - disponibilidade histórica e latência média por tracker

Exemplos: `/api/trackers?protocol=udp&status=online` e `/api/magnet?hash=0123456789abcdef0123456789abcdef01234567&dn=Teste`.

No dashboard, cole um infohash para gerar o magnet. Marque “Usar somente trackers que responderam ao teste” se quiser filtrar a lista; por padrão, o gerador inclui todos os trackers configurados, mesmo que o teste ainda não tenha sido concluído.

## Como interpretar os resultados

- **UDP:** a verificação confirma a resposta ao handshake de conexão do protocolo de tracker UDP. Isso não mede a quantidade de peers nem garante que um torrent específico tenha seeds.
- **HTTP/HTTPS:** a verificação mede acessibilidade HTTP. Ela não executa um announce BitTorrent completo, então o resultado não garante que o tracker aceite announces ou tenha peers disponíveis.
- **Online não significa rápido:** latência é o tempo observado nessa verificação e pode variar com a rede, DNS e localização.

A lista em `data/trackers.json` é editável. Organize os URLs nas categorias existentes ou crie categorias novas. Use somente endpoints públicos e respeite as regras dos serviços e a legislação aplicável.
