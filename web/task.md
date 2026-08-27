# RirekiTailor Web — Task de melhoria UI/UX

Acompanhamento da execução do overhaul: **UI profissional + chat por seção + menu global (biblioteca)**.

Decisões aprovadas:

- Overhaul completo (CSS + modais/toasts customizados + micro-UX) — substitui `prompt/confirm/alert` nativos.
- Tema **dark + toggle light** (persistido, fallback `prefers-color-scheme`).
- **Chat por seção** na Etapa 3, ao lado do PDF (`TellSDK.tell` one-shot com `system` contextual + histórico em `context`).
- **Menu lateral global**: Biblioteca (**máx. 2 masters + 2 templates**) e config LLM unificada; seleção por seção via dropdowns (**cópia por seção**); botões **"Salvar como modelo"**.
- `smoke.js` atualizado para a nova UI.

Restrições: 100% offline/estático (sem CDN), IDs existentes preservados.

---

## Fase A — CSS overhaul (`css/app.css`) — ✅ concluída

- [x] Design tokens dark/light via `data-theme` no `<html>` (cores, espaçamento, raios, sombras)
- [x] Base: tipografia, foco visível, seleção, scrollbars, `prefers-reduced-motion`
- [x] Header com branding + status pill + botão de tema
- [x] Stepper com estados concluído/ativo/pendente + conector
- [x] Sistema de botões (primary/secondary/ghost/danger/icon, spinner `.is-loading`)
- [x] Cards com sombra/hover/focus-within; forms (select custom, checkbox toggle, textarea + contador)
- [x] Toasts (variantes ok/err/warn/info, auto-dismiss, aria-live)
- [x] Modais customizados (backdrop blur, animação, modo danger)
- [x] Barra de progresso indeterminada (LLM/compile)
- [x] Sidebar drawer (esquerda, backdrop, tabs Biblioteca/LLM, cards de entrada da biblioteca)
- [x] Chat (bolhas user/assistant, markdown-lite, quick-ask chips, input auto-grow)
- [x] Etapa 3 em 3 colunas `[tex | pdf | chat]` + responsivo (chat full-width abaixo de 1280px)
- [x] Responsivo geral (header/toolbar mobile; `.btn-group` vira grid 2×2 ≤700px)

## Fase B — HTML (`index.html`) — ✅ concluída

- [x] Header: `#btn-menu`, `#btn-theme`, status pill; SVG inline nos botões (sem emoji)
- [x] Containers globais: `#toasts`, `#modal-root`, `#progress`
- [x] Sidebar `#sidebar` + `#sidebar-backdrop`: tabs Biblioteca / LLM (cfg movida para dentro, IDs preservados)
- [x] Biblioteca: listas `#lib-masters` / `#lib-templates` (renderizadas via JS) + ações
- [x] Etapa 1: dropdowns `#master-lib` / `#template-lib` nos cards master/template + botão "salvar como modelo"
- [x] Etapa 3: painel de chat (`#chat-panel`, `#chat-messages`, `#chat-input`, `#chat-send`, `#chat-clear`, `#chat-context`)
- [x] Contadores de caracteres + botões copiar + ARIA (`role="status"`, `aria-live`)
- [x] Carregar `js/chat.js` antes de `app.js`

## Fase C — App JS (`js/app.js`) — ✅ concluída

- [x] Estado `library` (`localStorage riki.library`) + seed inicial (master EN + CV_ATS dos DEFAULT_FILES)
- [x] Sidebar: abrir/fechar (Esc/backdrop/X), tabs, render das entradas, limite 2 com toast
- [x] Ações biblioteca: adicionar/salvar/upload/excluir/usar-na-seção/**salvar-modelo** (da seção atual)
- [x] Dropdowns por seção: copiar conteúdo p/ seção (`s.masterId`/`s.templateId`, `s.lang`)
- [x] Seções: nova herda ids/conteúdo; duplicar mantém escolha e limpa chat/cvOut/cover/tex
- [x] Tema: aplicar/persistir/toggle (`riki.theme`)
- [x] Modais `modal.confirm/prompt/alert` + `toast()` substituindo nativos (criar/renomear/excluir seção, import)
- [x] Progress bar + spinners em gerar/cover/toTex/compile
- [x] Contadores de caracteres + copiar (clipboard + toast)
- [x] Validação amigável antes de gerar (toast warn se vaga/master vazios)

## Fase D — Chat (`js/chat.js` novo + `js/llm.js`) — ✅ concluída

- [x] `llm.js`: `chatTell(msg, config, {system, context})` → `TellSDK.tell(..., {exec:false, system, context})`
- [x] Histórico por seção `section.chat` (auto-save; limpo ao duplicar)
- [x] System prompt contextual (vaga/master/CV_OUT/cover/tex não vazios, idioma da seção)
- [x] Render bolhas + markdown-lite seguro (escape HTML primeiro) + "pensando…"
- [x] Quick-ask chips; Enter envia / Shift+Enter quebra linha; copiar mensagem; limpar chat (modal confirm)
- [x] Erro sem API key → bolha com link que abre o menu (seção LLM)

## Fase E — Testes (`scripts/smoke.js`) — ✅ concluída

- [x] Nova seção via modal customizado (remove handler `dialog` nativo)
- [x] Asserts: sidebar/biblioteca, limite 2 masters, dropdown carrega master na seção
- [x] Asserts: LLM persiste dentro do menu; chat na Etapa 3; tema alterna e persiste; toast aparece
- [x] Suíte roda verde sem erros de console

## Fase F — Verificação — ✅ concluída

- [x] `node web/scripts/serve.js --port 8080` + `NODE_PATH=$(npm root -g) node web/scripts/smoke.js` → **EXIT=0, errors: none**
- [x] `e2e.js` (compile real) → **EXIT=0** (PDF 115.225 bytes, `%PDF-1.5`, ~2–3 s)
- [x] Screenshots Playwright: desktop dark/light, sidebar, Etapa 3 com chat, mobile dark + sidebar
- [x] README-web.md atualizado (biblioteca, chat, temas, modais/toasts, testes)

---

## Notas de execução

- **Playwright** não estava mais instalado globalmente → `npm install -g playwright`
  (revisão do Chromium 1234 = cache existente em `~/.cache/ms-playwright`).
- **Bug corrigido (`js/chat.js`)**: `fillStep1()` chamava `Chat.render()` antes de
  `Chat.init(deps)` (via `createInitial`) → abortava todo o `init()`. Guard `ready` adicionado.
- **Bug pré-existente corrigido (`scripts/e2e.js`)**: assert do header do PDF comparava
  hex com espaços (`join(' ')`) contra `startsWith('25504446')` → sempre falhava.
  Agora normaliza espaços antes do assert.
- **CSS**: `.btn-group` quebrava o botão "Excluir" na borda em mobile → grid 2×2 ≤700px.
- Chat é **one-shot por mensagem** (bundle browser do `@tell-ai/sdk` não expõe streaming);
  histórico multi-turn via `context` (últimos ~14 turnos, cap ~24k chars).
- `#cfg-panel` migrou de `<details>` para `<form>` dentro da sidebar (IDs `#cfg-*` preservados).
