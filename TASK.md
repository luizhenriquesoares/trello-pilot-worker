# TaskPilot Worker — Plano de Ação

Consolidação de todas as falhas e melhorias mapeadas em 25/04/2026, agrupadas por severidade.

Legenda de prioridade:
- **P0** — bug crítico em produção (perda de dados, segurança, pipeline travado)
- **P1** — bug funcional ativo ou risco alto de regressão
- **P2** — melhoria de UX / qualidade / observabilidade

Status:
- ✅ **Todos os P0 (#1-#5) aplicados em 25/04/2026.**
- ✅ **Limpeza de Railway feita** — projetos migraram pra Hostinger (CI/CD automático no commit), `DeployWatcher` removido, `RAILWAY_TOKEN` removido, `railwayProjectId` removido. Resolve P1 #6 por deleção.

---

## P0 — Correções críticas (bloqueantes) ✅ APLICADO

### 1. Webhook responde 200 antes de confirmar enfileiramento no SQS ✅
- **Origem:** QA review
- **Arquivos:** [webhook-handler.ts:87-88](src/server/webhook-handler.ts#L87-L88), [webhook-handler.ts:158-160](src/server/webhook-handler.ts#L158-L160)
- **Problema:** o handler responde `res.status(200).json({ received: true })` antes de chamar `sqsProducer.sendMessage(event)`. Se o `sendMessage()` falhar, o Trello já recebeu ACK e o card desaparece do pipeline sem retry.
- **Ação:**
  1. Mover o `res.status(200)` para depois do `await sqsProducer.sendMessage(event)`.
  2. Em caso de exceção, devolver 5xx pra que o Trello reentregue o webhook (Trello reenvia em 5xx por algumas tentativas).
  3. Cuidado com timeout do Trello (~10s): se o SQS estiver lento, ainda dá tempo. Se ficar apertado, considerar mover o `sendMessage` pra um background com retry interno + persistência local antes do ACK.
- **Aceite:** simulação de SQS down (env vars erradas) deve resultar em 5xx no webhook e o Trello reenviar o evento.

### 2. Falhas de stage viram consumo bem-sucedido do SQS (sem retry / sem DLQ) ✅
- **Origem:** QA review
- **Arquivos:** [orchestrator.ts:156-168](src/pipeline/orchestrator.ts#L156-L168), [index.ts:211-216](src/index.ts#L211-L216)
- **Problema:** `processEvent()` captura erros, comenta no Trello e retorna sem relançar; o poller em seguida chama `deleteMessage()`. Resultado: erro transitório de Trello/GitHub/Claude vira "sucesso" e a mensagem some.
- **Ação:**
  1. Em `processEvent()`, classificar erros como **transitórios** (timeout, 5xx, rate limit, ECONNRESET) vs **permanentes** (validação, auth, "PR não merge-ável") e relançar transitórios.
  2. No `pollLoop`, só chamar `deleteMessage` quando `processEvent` resolver sem exceção. Em caso de exceção, **não** deletar — deixar a SQS reentregar após o visibility timeout.
  3. Configurar **DLQ** na fila SQS com `maxReceiveCount` ~ 3 para parar de retentar erros permanentes.
  4. Logar com nível `error` e enviar pro Slack quando a mensagem cair na DLQ.
- **Aceite:** matar a API do Trello durante uma stage e verificar que a mensagem volta após o visibility timeout (não some).

### 3. REVIEW e QA ignoram `exitCode` do Claude ✅
- **Origem:** QA review
- **Arquivos:** [headless-runner.ts:121-130](src/claude/headless-runner.ts#L121-L130), [review.ts:85-99](src/pipeline/stages/review.ts#L85-L99), [qa.ts:79-102](src/pipeline/stages/qa.ts#L79-L102)
- **Problema:** o `runClaude()` retorna `exitCode = 124` em timeout e o código de exit do processo em outros erros, mas as stages não checam — seguem direto pro `push` e o QA tenta `mergePr` mesmo se o Claude falhou. Isso permite mergear código com QA sem ter rodado.
- **Ação:**
  1. Após cada `runClaude()`, validar `runResult.exitCode === 0`. Se ≠ 0:
     - **Review:** abortar a stage com erro claro ("Claude review falhou: <stderr>"). Card permanece em Review.
     - **QA:** abortar antes do `mergePr`. Card permanece em QA com comentário "QA não validou — implementação não foi mergeada".
  2. Bloquear `mergePr` se a sessão do Claude QA não tiver concluído com `exitCode 0`.
  3. Considerar exigir que o último evento `result` do stream tenha `is_error: false`.
- **Aceite:** simular timeout no Claude (timeout baixo) e verificar que o PR **não** é mergeado.

### 4. PR não fecha após merge — branches acumulam abertas ✅
- **Origem:** relato do usuário
- **Arquivos:** [repo-manager.ts:160-170](src/git/repo-manager.ts#L160-L170), [repo-manager.ts:192-209](src/git/repo-manager.ts#L192-L209)
- **Problema:**
  - Matcher de erro frouxo: `'unable to delete'` faz match em mensagens de proteção/permissão e trata como "branch já deletada", mascarando falhas reais.
  - `gh pr merge` sem `--admin` falha em repos com required status checks. Sem `--auto` não enfileira merge pra quando os checks passarem.
  - Não há fallback via REST API logo após o merge — só roda no `DeployWatcher` depois do deploy verificado.
- **Ação:**
  1. Apertar matcher em `deleteRemoteBranchIfExists` para regex estrita: `/remote ref does not exist|not found in upstream/`. Qualquer outro erro → warning + fallback.
  2. Em `mergePr`, tentar primeiro `gh pr merge --squash --delete-branch`; se falhar com "required status checks", retentar com `--admin`. Se ainda falhar, retornar `merged=false` com a stderr exposta.
  3. Após merge bem-sucedido, **sempre** chamar `deleteBranchViaApi()` (DELETE `/repos/{owner}/{repo}/git/refs/heads/{branch}`) como confirmação independente da CLI.
  4. No boot do worker, chamar `gh auth status --show-token` e logar quais scopes o token tem. Avisar visivelmente se faltar `Contents: Write` ou `Administration: Write`.
- **Aceite:** pipeline completo num repo com required status checks. PR fecha, branch some no GitHub.

### 5. Validação de assinatura do webhook efetivamente desativada ✅
- **Origem:** QA review
- **Arquivos:** [index.ts:124-130](src/index.ts#L124-L130), [routes.ts:11](src/server/routes.ts#L11), [webhook-handler.ts:72](src/server/webhook-handler.ts#L72)
- **Problema:** `WebhookHandler` é instanciado com `callbackUrl=undefined`, e a validação só roda quando `webhookSecret && callbackUrl` (linha 72). Mesmo se ativada, o `app.use(express.json())` em routes.ts:11 consome o raw body antes da verificação HMAC, então o hash nunca bateria.
- **Ação:**
  1. Resolver `callbackUrl` no boot (env `PUBLIC_BASE_URL` + `/webhook/trello`) e passar pro construtor.
  2. Capturar o raw body no Express usando `express.json({ verify: (req, _res, buf) => { req.rawBody = buf } })`.
  3. Usar `req.rawBody` na verificação HMAC.
  4. Se `TRELLO_WEBHOOK_SECRET` estiver presente e a assinatura faltar/falhar, devolver 401 (já está) — testar de fato com payload do Trello.
- **Aceite:** webhook sem header `x-trello-webhook` com `TRELLO_WEBHOOK_SECRET` setado retorna 401; payload válido continua passando.

---

## P1 — Funcionalidade comprometida

### 6. Recovery de deploy pode mover card errado pra Done ✅ (resolvido por deleção)
- **Status:** Resolvido — projetos migraram pra Hostinger (CI/CD no commit). O `DeployWatcher` inteiro foi removido (`src/deploy/watcher.ts` deletado), eliminando `recoverStuckCards()` e o risco que ele introduzia.
- **Comportamento atual:** após merge bem-sucedido, o card vai direto pra Done. O CI/CD do Hostinger pega o commit em paralelo.

### 7. Fluxo standalone REVIEW/QA truncado ✅ (parcial)
- **Origem:** QA review
- **Arquivos:** [orchestrator.ts](src/pipeline/orchestrator.ts) `handleReview` / `handleQa`
- **Status:** `handleQa` agora completa o fluxo (move pra Done + Slack) quando o merge é bem-sucedido, e respeita o `merged=false` (deixa em QA). Limpeza do Railway tornou o caminho consistente com o inline.
- **Pendente:** `handleReview` ainda só move pra QA sem rodar QA — decidir se é intencional ou se deve disparar QA via SQS.

### 8. Sem testes automatizados
- **Origem:** QA review
- **Arquivos:** raiz do projeto
- **Problema:** zero `*.test.*` / `*.spec.*` no repo. Fluxos críticos (orchestrator, repo-manager, webhook-handler) sem cobertura.
- **Ação:**
  1. Adicionar Vitest ao `package.json` e config.
  2. Cobertura mínima inicial:
     - `repo-manager.spec.ts` — `mergePr` com falha de `--delete-branch`, matcher de "branch already gone", fallback API.
     - `webhook-handler.spec.ts` — assinatura inválida, payload sem action, retry de SQS.
     - `orchestrator.spec.ts` — erro transitório relança, erro permanente não relança, repo lock.
  3. Rodar testes no CI antes do deploy do Railway.
- **Aceite:** `npm test` passa, CI bloqueia deploy se vermelho.

---

## P2 — UX / Frontend / Operação

### 9. Front-end TaskPilot — seletor de projetos completo
- **Origem:** pedido do usuário
- **Contexto:** hoje só os 5 projetos das listas Trello estão disponíveis. Os ~25 repos locais (audit-intelligence, b2b-portal, lambda-sqs-quotation, nexus-mileage-ai, etc.) não têm como receber tasks pelo TaskPilot.
- **Pré-requisito de arquitetura:**
  - Centralizar lista de projetos em um `projects.json` único, lido por `task-pilot/server.js` e `trello-pilot-worker/config.json` (ou via env `BOARD_CONFIG_JSON`).
  - Cada entry: `{ name, repoUrl, baseBranch, branchPrefix, trelloListId, railwayProjectId? }`.
  - Decidir destino Trello para repos sem lista própria: **labels** num board "Outros" (recomendado) ou criar lista por projeto (polui board).
- **Ação no front (`task-pilot/client/src/App.tsx`):**
  1. Adicionar combobox/dropdown **"Projeto destino"** acima da textarea, com search (são muitos itens) e default "auto-detectar".
  2. Endpoint `/api/projects` retorna lista completa com metadata (ícone/cor opcional por projeto).
  3. No preview pós-IA, permitir override do projeto detectado antes do "Criar no Trello".
- **Aceite:** usuário cria task pra `audit-intelligence` direto pela UI e o card aparece no board com label/lista correto.

### 10. Redesign visual do TaskPilot App
- **Origem:** pedido do usuário
- **Pontos a melhorar (baseado nos screenshots):**
  - Header roxo saturado e alto demais → tom mais sóbrio + altura reduzida.
  - Cards do board sem hierarquia visual (título, projeto, anexos misturados).
  - Tela "Worker" muito vazia → grid mais denso, sparkline de Total/Success/Failed, badge de uptime mais discreto.
  - Tela "Nova" parece formulário rápido sem identidade — adicionar seções **Projeto → Descrição → Anexos → Ação**.
- **Ação:** primeiro fechar P0/P1 do worker; depois alinhar protótipo de UI com o usuário (Figma/wireframe rápido) antes de codar.

### 11. Melhorias gerais de operação
- Logar scopes do `GH_TOKEN` no boot (já listado em P0 #4, vale ressaltar).
- Adicionar métrica/alerta para mensagens DLQ.
- Considerar remover lógica redundante de `deleteRemoteBranchIfExists` quando `gh pr merge --delete-branch` rodou — ou manter só como API fallback.
- Documentar no README quais scopes do `GH_TOKEN` são necessários (`Contents: Write`, `Pull requests: Write`, opcionalmente `Administration: Write` para `--admin`).

---

## Pré-requisitos pra ativar tudo em produção

1. **Configurar `PUBLIC_BASE_URL`** no env do worker (ex: `https://worker.dominio.com`). Sem isso o HMAC fica desativado mas com warning explícito no boot.
2. **DLQ na fila SQS** com `maxReceiveCount=3` — pra erros não-permanentes não fazerem loop infinito.
3. **Verificar scopes do `GH_TOKEN`** — vai aparecer no log do boot (`[Worker] GH_TOKEN ok — ... scopes=[...]`); precisa de `repo` (classic) ou `Contents: Write` + `Pull requests: Write` (fine-grained).
4. **Remover `RAILWAY_TOKEN`** do env (se ainda estiver setado) — não é mais usado.

## Próximos passos (ordem sugerida)

1. **P1 #8 (testes)** — cobrir `repo-manager.mergePr`, `webhook-handler` e classificação de erros do `pollLoop` com Vitest.
2. **P1 #7 (handleReview standalone)** — decidir se enfileira QA ou se removemos o caminho.
3. **P2 #9-#11 (front + projects.json + UX)** — quando o worker estiver estável e testado.
