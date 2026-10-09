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

## Tracker HTTP próprio (v2.2.0)

O servidor também implementa os endpoints HTTP BitTorrent `/announce` e `/scrape`, com respostas bencoded, peers compactos IPv4 e IPv6 (BEP 7), registro local de peers, expiração de peers e limites básicos por IP. Ele pode ser usado por clientes BitTorrent comuns que aceitem trackers HTTP.

Para colocar o tracker nos magnets gerados, defina `PUBLIC_TRACKER_URL` como o endereço público completo terminado em `/announce`:

```sh
PUBLIC_TRACKER_URL='http://seu-dominio-dynu:3000/announce' npm start
```

Use um domínio Dynu com registro AAAA para IPv6 (e A se também tiver IPv4), ou HTTPS atrás de um proxy reverso configurado por você. O servidor escuta em `::` por padrão; use `BIND_HOST=0.0.0.0` para IPv4 somente. A rede precisa permitir conexões de entrada na porta escolhida. Em redes móveis, isso pode ser bloqueado mesmo quando o aparelho tem IPv6. Não exponha o endpoint publicamente sem entender que qualquer cliente poderá anunciar torrents nele.

**Como o multi-tracker funciona:** os magnets gerados incluem nosso tracker e trackers públicos externos. Os clientes BitTorrent conectam-se diretamente a cada tracker listado e juntam os peers que recebem. O tracker próprio mantém os peers que anunciam a ele; ele não faz proxy de announces para outros trackers nem consegue obrigá-los a revelar suas listas de peers. Isso preserva a compatibilidade com clientes comuns.

## API

- `GET /` - dashboard web
- `POST /api/refresh` - dispara uma verificação manual (retorna 409 se já houver uma em andamento)
- `GET /api/magnet?hash=INFOHASH&dn=NOME` - gera um magnet link com o tracker próprio configurado e os trackers externos; `hash` aceita 40 caracteres hexadecimais ou 32 em Base32
- `GET /` - dashboard web
- `GET /api/status` - estado geral, horário da última verificação e contagem local de swarms/peers
- `GET /announce` - endpoint HTTP BitTorrent announce (resposta bencoded)
- `GET /scrape?info_hash=...` - estatísticas do swarm local para um infohash (quando suportado pelo cliente)
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


## Fontes da lista de trackers

A lista inicial inclui endpoints públicos UDP, HTTP e HTTPS da coleção mantida por [ngosang/trackerslist](https://github.com/ngosang/trackerslist), usando as listas `trackers_best.txt`, `trackers_all_udp.txt`, `trackers_all_http.txt` e `trackers_all_https.txt`. A lista foi deduplicada contra os endereços que já existiam no projeto. Os endpoints podem sair do ar a qualquer momento; consulte o resultado do monitor antes de usá-los. O projeto não inclui trackers WebSocket, I2P ou Yggdrasil, pois exigem suporte/rede específica que o verificador atual não implementa.


## Atualizador automático de IPv6/Dynu

O script `src/ddns-updater.js` consulta `https://api6.ipify.org` e `https://ipv6.icanhazip.com` para descobrir o IPv6 público de saída. Se ambas responderem, exige que os endereços coincidam; se só uma responder, usa o resultado disponível. Quando o IPv6 muda, envia o endereço diretamente ao endpoint oficial do Dynu, `https://api.dynu.com/nic/update`, com `myip=no` e `myipv6=<IPv6>`. O script só considera sucesso as respostas `good` ou `nochg`, guarda o último endereço localmente e verifica novamente a cada cinco minutos.

Configure o `.env` **localmente no Termux**:

```sh
cp .env.example .env
nano .env
```

Defina `DDNS_HOST`, `DDNS_USERNAME` e `DDNS_PASSWORD`. O arquivo de modelo no GitHub deve conter apenas campos vazios/de exemplo; nunca publique a senha real. O atualizador lê essas variáveis do ambiente ou do arquivo local `.env`.

Execute o atualizador em outro processo:

```sh
npm run ddns
```

O primeiro ciclo ocorre ao iniciar; depois, verifica a cada `DDNS_UPDATE_INTERVAL_MS` milissegundos (padrão: 300000). O último IPv6 confirmado fica em `data/ddns-last-ip.json`, ignorado pelo Git. As credenciais são enviadas somente ao endpoint HTTPS do Dynu e não são impressas nos logs.

**Importante:** a API de descoberta identifica o IPv6 público usado para conexões de saída. Isso não abre portas de entrada nem garante que o endereço seja estável/acessível no Android. O registro AAAA e as regras de entrada da rede precisam permitir conexões ao servidor.
