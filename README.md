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

Por padrão, o servidor escuta na porta `6969`. Para escolher outra porta:

```sh
PORT=6969 npm start
```

O histórico é salvo em `data/history.json`, criado automaticamente e ignorado pelo Git. As verificações são repetidas a cada cinco minutos; no máximo cinco trackers são verificados em paralelo.

## Tracker HTTP próprio (v2.2.0)

O servidor também implementa os endpoints HTTP BitTorrent `/announce` e `/scrape`, com respostas bencoded, peers compactos IPv4 e IPv6 (BEP 7), registro local de peers, expiração de peers e limites básicos por IP. Ele pode ser usado por clientes BitTorrent comuns que aceitem trackers HTTP.

O endereço público padrão já está configurado como `http://chirusanrestart.freeddns.org:6969/announce`, então ele será incluído automaticamente nos magnets gerados. Se mudar de domínio ou porta, você pode substituir o padrão pela variável `PUBLIC_TRACKER_URL` ao iniciar:

```sh
PUBLIC_TRACKER_URL='http://seu-dominio-dynu:6969/announce' npm start
```

Use um domínio Dynu com registro AAAA apontando para o IPv6 atual (e registro A se também tiver IPv4), ou HTTPS atrás de um proxy reverso configurado por você. O servidor escuta em `::` por padrão; use `BIND_HOST=0.0.0.0` para IPv4 somente. A rede precisa permitir conexões de entrada na porta escolhida. Em redes móveis, isso pode ser bloqueado mesmo quando o aparelho tem IPv6. Não exponha o endpoint publicamente sem entender que qualquer cliente poderá anunciar torrents nele.

**Como o multi-tracker funciona:** os magnets gerados incluem nosso tracker e trackers públicos externos. Os clientes BitTorrent conectam-se diretamente a cada tracker listado e juntam os peers que recebem. O tracker próprio mantém os peers que anunciam a ele; ele não faz proxy de announces para outros trackers nem consegue obrigá-los a revelar suas listas de peers. Isso preserva a compatibilidade com clientes comuns.

## Descoberta de novos trackers

Ao iniciar `npm start`, o servidor executa a descoberta automaticamente e repete o processo a cada seis horas. Ele consulta listas públicas, compara os endereços com `data/trackers.json` e atualiza `data/discovered-trackers.json` com os candidatos novos. Para executar manualmente, use `npm run discover`.

O script consulta as listas `trackers_best`, `trackers_all_udp`, `trackers_all_http` e `trackers_all_https` do [ngosang/trackerslist](https://github.com/ngosang/trackerslist), além da lista comunitária [DeSireFire/animeTrackerList](https://github.com/DeSireFire/animeTrackerList). Se uma fonte falhar, as demais ainda são processadas. Os candidatos são normalizados para remover barras repetidas e entradas malformadas, deduplicados e ordenados pela prioridade da fonte, favorecendo a lista `trackers_best` antes das listas gerais e comunitárias. Após uma descoberta bem-sucedida, o servidor também avalia automaticamente um lote de até 200 candidatos UDP por ciclo, em grupos de até oito testes simultâneos.

**Segurança e promoção automática:** descoberta não significa validação. O avaliador testa até 200 candidatos UDP por ciclo por padrão (configurável até 200), usando o handshake de conexão do protocolo. Os testes rodam em paralelo com concorrência limitada para reduzir o tempo total sem disparar centenas de conexões de uma vez. Um candidato só é promovido para `data/trackers.json` após responder em dois ciclos consecutivos; no máximo cinco são adicionados por execução. O histórico de avaliação fica em `data/candidate-history.json`. Esse handshake é um sinal técnico forte, mas não garante que o tracker encontre peers para um torrent específico. HTTP/HTTPS não são promovidos automaticamente porque uma resposta HTTP simples não prova que o announce BitTorrent funciona. Os candidatos HTTP/HTTPS continuam em `data/discovered-trackers.json` para avaliação manual. O arquivo de descoberta e o histórico ficam locais e não são versionados automaticamente. A frequência padrão de descoberta é de seis horas; altere com `TRACKER_DISCOVERY_INTERVAL_MS` (milissegundos) ou desative com `DISABLE_TRACKER_DISCOVERY=1`. Para desativar apenas a avaliação/promoção automática, use `DISABLE_TRACKER_AUTO_PROMOTION=1`. O tamanho do lote pode ser alterado com `TRACKER_CANDIDATE_BATCH` (padrão 200, máximo 200), a concorrência com `TRACKER_CANDIDATE_CONCURRENCY` (padrão 8, máximo 32) e o limite de promoções por ciclo com `TRACKER_MAX_PROMOTE` (padrão 5).

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
- `GET /api/ranking` - alias para o resumo ranqueado dos trackers, com recomendação `keep`, `watch` ou `retirement-candidate`

Exemplos: `/api/trackers?protocol=udp&status=online` e `/api/magnet?hash=0123456789abcdef0123456789abcdef01234567&dn=Teste`.

No dashboard, cole um infohash para gerar o magnet. Marque “Usar somente trackers que responderam ao teste” se quiser filtrar a lista; por padrão, o gerador inclui todos os trackers configurados, mesmo que o teste ainda não tenha sido concluído.

## Ranking e manutenção da lista

O endpoint `/api/history/summary` (também disponível em `/api/ranking`) ordena os trackers pela recomendação baseada no histórico: `keep` para disponibilidade de pelo menos 80%, `watch` entre 35% e 80%, e `retirement-candidate` abaixo de 35%, somente depois de pelo menos 12 verificações. O ranking usa a disponibilidade histórica e a latência média como critério de ordenação. Ele **não remove automaticamente** nenhum tracker: uma queda de rede ou bloqueio temporário pode causar falsos negativos, então confirme os candidatos a remoção antes de editar `data/trackers.json`.

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

O `npm start` inicia o atualizador Dynu automaticamente junto com o servidor. Se quiser executar somente o atualizador, sem iniciar o servidor, use:

```sh
npm run ddns
```

O primeiro ciclo ocorre ao iniciar; depois, verifica a cada `DDNS_UPDATE_INTERVAL_MS` milissegundos (padrão: 300000). Para desativar o processo automático junto ao servidor, defina `DISABLE_DDNS_UPDATER=1`. O último IPv6 confirmado fica em `data/ddns-last-ip.json`, ignorado pelo Git. As credenciais são enviadas somente ao endpoint HTTPS do Dynu e não são impressas nos logs.

**Importante:** a API de descoberta identifica o IPv6 público usado para conexões de saída. Isso não abre portas de entrada nem garante que o endereço seja estável/acessível no Android. O registro AAAA e as regras de entrada da rede precisam permitir conexões ao servidor.
