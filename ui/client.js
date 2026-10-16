// O client: a luta ao vivo com as skills de cada um, o histórico de cada
// luta, os recordes e as escolhas do overlay.

const $ = (id) => document.getElementById(id);

const PAGES = ["live", "history", "fight", "records", "chars", "char", "map", "settings"];
let page = "live";
const win = window.__TAURI__.window.getCurrentWindow();

// ── barra de título ────────────────────────────────────────
// A do Windows foi tirada (tauri.conf.json): esta é a nossa, da cor da lateral.

$("win-min").addEventListener("click", () => win.minimize());
$("win-max").addEventListener("click", () => win.toggleMaximize());
// Fechar o client fecha o meter, gravando antes a luta (main.rs).
$("win-close").addEventListener("click", () => win.close());

async function syncMaximized() {
  const maximized = await win.isMaximized().catch(() => false);
  document.documentElement.classList.toggle("maximized", maximized);
  const label = maximized ? "Restaurar" : "Maximizar";
  $("win-max").title = label;
  $("win-max").setAttribute("aria-label", label);
  // Restaurar: dois quadrados, como no Windows.
  $("win-max-icon").setAttribute("d", maximized ? "M2.5 2.5h7v7h-7zM0.5 7.5v-7h7" : "M0.5 0.5h9v9h-9z");
}
win.onResized(syncMaximized);
syncMaximized();

// ── navegação ──────────────────────────────────────────────
// Cada tela vista entra numa lista, como num navegador: ← e → no topo,
// Alt + setas e os botões laterais do mouse andam por ela.

const visited = [];
let visitedAt = -1;

function go(entry) {
  const current = visited[visitedAt];
  if (current && current.page === entry.page && current.id === entry.id && current.q === entry.q) {
    openEntry(entry);
    return;
  }
  visited.splice(visitedAt + 1);
  visited.push(entry);
  visitedAt = visited.length - 1;
  openEntry(entry);
}

function step(direction) {
  const next = visitedAt + direction;
  if (next < 0 || next >= visited.length) return;
  visitedAt = next;
  openEntry(visited[next]);
}

function openEntry(entry) {
  if (entry.page === "fight") loadFight(entry.id);
  else if (entry.page === "char") openCharacter(entry); // chars.js
  else if (entry.page === "chars") openCharacters(entry); // chars.js
  else if (entry.page === "map") openMap(); // map.js
  else show(entry.page);
  $("nav-back").disabled = visitedAt <= 0;
  $("nav-forward").disabled = visitedAt >= visited.length - 1;
}

$("nav-back").addEventListener("click", () => step(-1));
$("nav-forward").addEventListener("click", () => step(1));
window.addEventListener("keydown", (e) => {
  if (!e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
  e.preventDefault();
  step(e.key === "ArrowLeft" ? -1 : 1);
});
window.addEventListener("mouseup", (e) => {
  if (e.button === 3) step(-1);
  if (e.button === 4) step(1);
});

function show(next) {
  page = next;
  for (const p of PAGES) $(`page-${p}`).hidden = p !== next;
  const nav = { fight: "history", char: "chars" }[next] ?? next;
  for (const button of document.querySelectorAll(".nav[data-page]")) {
    const on = button.dataset.page === nav;
    button.classList.toggle("on", on);
    if (on) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  $("main").scrollTop = 0;
  // O mapa ocupa a área toda, sem margem nem rolagem.
  $("main").classList.toggle("flush", next === "map");
  if (next === "live") refreshLive();
  if (next === "history" || next === "records") refreshHistory();
}

for (const button of document.querySelectorAll(".nav[data-page]")) {
  button.addEventListener("click", () => go({ page: button.dataset.page }));
}

// ── uma luta (ao vivo ou do histórico) ─────────────────────

const TABS = [
  ["damage", "Dano"],
  ["heal", "Cura"],
  ["taken", "Dano recebido"],
];

// O que a pessoa escolheu em cada tela de luta, mantido entre atualizações.
// A linha do "Grupo" no gráfico começa desligada.
function fightState() {
  return { tab: "damage", player: null, hiddenLines: new Set(["party"]), sort: { key: "amount", dir: -1 }, shot: null };
}

// Números inteiros com ponto de milhar: poder de combate 68.836.
const INT = new Intl.NumberFormat("pt-BR");
const int = (n) => INT.format(Math.round(n));

// O nome de uma luta (do histórico ou a tela inteira): o chefe; numa luta
// comum, a passagem pela dungeon ou o alvo que mais apanhou e quantos mais.
function fightTitle(f) {
  if (f.kind !== "combat") return f.boss || "Luta";
  if (f.dungeonId) return "Passagem completa";
  const first = f.boss || "Monstros";
  return f.targets > 1 ? `${first} e mais ${f.targets - 1}` : first;
}

const plural = (n, one, many) => `${int(n)} ${n === 1 ? one : many}`;

function card(label, value, note, cls) {
  return el("div", { class: `stat ${cls ?? ""}` }, el("span", { class: "label", text: label }), el("b", { text: value }), note ? el("span", { class: "note", text: note }) : null);
}

function playerName(p) {
  return el(
    "span",
    { class: "who" },
    classBadge(p.job),
    el("span", { class: "name", text: p.name || "?" }),
    p.me ? el("span", { class: "tag", text: "VOCÊ" }) : null,
  );
}

// Tabela de jogadores com barra da cor da classe; clicar abre as skills.
function playersTable(players, columns, state, barOf, onPick) {
  const top = Math.max(...players.map(barOf), 1);
  const head = el(
    "div",
    { class: "prow head" },
    el("span", { text: "Jogador" }),
    ...columns.map(([label]) => el("span", { text: label })),
  );
  const rows = players.map((p, i) => {
    const row = el(
      "button",
      {
        class: `prow${p.name === state.player ? " selected" : ""}${p.me ? " me" : ""}`,
        style: `--c: ${classColor(p.job)}; --cols: ${columns.length}`,
        "aria-pressed": String(p.name === state.player),
        title: `${p.name} · ${classInfo(p.job).name}`,
        onclick: () => onPick(p.name),
      },
      el("span", { class: "bg" }, el("span", { class: "bar", style: `width: ${(barOf(p) / top) * 100}%` })),
      el("span", { class: "rank", text: `${i + 1}` }),
      playerName(p),
      ...columns.map(([, value]) => el("span", { class: "num", text: value(p) })),
    );
    return row;
  });
  return el("div", { class: "ptable", style: `--cols: ${columns.length}` }, head, ...rows);
}

// Colunas da tabela de skills. `rate`: a contagem
// dividida pelos golpes; `extra`: só aparece quando alguma skill tem.
const rateOf = (id) => (s) => (s.hits > 0 && !s.dot ? s[id] / s.hits : -1);
const SKILL_COLUMNS = [
  { id: "amount", label: "Dano", title: "Dano total", basic: true, value: (s) => compact(s.amount), sort: (s) => s.amount },
  { id: "share", label: "%", title: "Parte do dano do jogador", basic: true, value: (s, c) => percent((s.amount / c.total) * 100), sort: (s) => s.amount },
  { id: "dps", label: "DPS", title: "Dano por segundo", basic: true, value: (s, c) => compact(s.amount / c.seconds), sort: (s) => s.amount },
  { id: "hits", label: "Golpes", title: "Golpes que acertaram", basic: true, value: (s) => int(s.hits), sort: (s) => s.hits },
  { id: "crits", label: "Crít", title: "Crítico %", basic: true, rate: true },
  { id: "perfect", label: "Perfeito", title: "Perfeito %", rate: true },
  { id: "double", label: "Duplo", title: "Duplo %", rate: true },
  { id: "back", label: "Costas", title: "Ataque pelas costas %", rate: true },
  { id: "frontal", label: "Frontal", title: "Ataque de frente %", rate: true, extra: true },
  { id: "multi", label: "Múltiplo", title: "Golpes que vieram com golpes extras %", rate: true, extra: true },
  { id: "multiDamage", label: "Dano múltiplo", title: "Dano dos golpes extras", extra: true, value: (s) => dash(s.multiDamage), sort: (s) => s.multiDamage },
  { id: "parry", label: "Aparar", title: "Golpes que o alvo aparou %", rate: true, extra: true },
  { id: "block", label: "Bloqueio", title: "Bloqueio com escudo %", rate: true, extra: true },
  { id: "perfectBlock", label: "Bloq. perf.", title: "Bloqueio perfeito %", rate: true, extra: true },
  { id: "ironWall", label: "Vigor", title: "Vigor %", rate: true, extra: true },
  { id: "regeneration", label: "Regen.", title: "Regeneração %", rate: true, extra: true },
  { id: "miss", label: "Erros", title: "Golpes que erraram", extra: true, value: (s) => dash(s.miss, int), sort: (s) => s.miss },
  { id: "resist", label: "Resistidos", title: "Golpes resistidos", extra: true, value: (s) => dash(s.resist, int), sort: (s) => s.resist },
  { id: "drain", label: "Roubo", title: "Vida roubada com o golpe", extra: true, value: (s) => dash(s.drain), sort: (s) => s.drain },
  { id: "min", label: "Mín", title: "Menor golpe", value: (s) => dash(s.min), sort: (s) => s.min },
  { id: "avg", label: "Média", title: "Dano médio por golpe", value: (s) => (s.hits > 0 ? compact(s.amount / s.hits) : "–"), sort: (s) => (s.hits > 0 ? s.amount / s.hits : 0) },
  { id: "max", label: "Máx", title: "Maior golpe", basic: true, value: (s) => dash(s.max), sort: (s) => s.max },
].map((col) => (col.rate ? { ...col, value: (s) => (s.hits > 0 && !s.dot ? `${Math.round((s[col.id] / s.hits) * 100)}%` : "–"), sort: rateOf(col.id) } : col));

const HEAL_COLUMNS = [
  { id: "amount", label: "Cura", title: "Cura total", value: (s) => compact(s.amount), sort: (s) => s.amount },
  { id: "dps", label: "Cura/s", title: "Cura por segundo", value: (s, c) => compact(s.amount / c.seconds), sort: (s) => s.amount },
  { id: "share", label: "%", title: "Parte da cura do jogador", value: (s, c) => percent((s.amount / c.total) * 100), sort: (s) => s.amount },
  { id: "hits", label: "Vezes", title: "Curas e ticks de cura", value: (s) => int(s.hits), sort: (s) => s.hits },
];

// "Principais" ou "Todas" as colunas, guardado neste PC.
let skillColumns = loadPref("skillColumns") === "basic" ? "basic" : "all";

function skillsTable(skills, seconds, color, kind, state, rerender) {
  if (skills.length === 0) {
    return el("p", { class: "hint", text: kind === "heal" ? "Nenhuma cura nesta luta." : "Nenhum dano nesta luta." });
  }
  const heal = kind === "heal";
  const ctx = { seconds, total: skills.reduce((sum, s) => sum + s.amount, 0) || 1 };
  const columns = heal
    ? HEAL_COLUMNS
    : SKILL_COLUMNS.filter((col) => (skillColumns === "basic" ? col.basic : !col.extra || skills.some((s) => (s[col.id] ?? 0) > 0)));
  const sortBy = columns.find((col) => col.id === state.sort.key) ?? columns[0];
  const sorted = [...skills].sort((a, b) => (sortBy.sort(b) - sortBy.sort(a)) * (state.sort.dir < 0 ? 1 : -1) || b.amount - a.amount);
  const top = Math.max(...skills.map((s) => s.amount)) || 1;
  const head = el(
    "div",
    { class: "srow head" },
    el("span", { text: heal ? "Skill de cura" : "Skill" }),
    ...columns.map((col) => {
      const on = col.id === sortBy.id;
      return el(
        "button",
        {
          class: `sort${on ? " on" : ""}`,
          title: `${col.title}. Clique para ordenar.`,
          "aria-sort": on ? (state.sort.dir < 0 ? "descending" : "ascending") : "none",
          onclick: () => {
            state.sort = { key: col.id, dir: on ? -state.sort.dir : -1 };
            rerender();
          },
        },
        col.label,
        on ? el("span", { class: "arrow", "aria-hidden": "true", text: state.sort.dir < 0 ? "↓" : "↑" }) : null,
      );
    }),
  );
  return el(
    "div",
    { class: "stable-wrap" },
    el(
      "div",
      { class: "stable", style: `--cols: ${columns.length}` },
      head,
      ...sorted.map((s) =>
        el(
          "div",
          { class: "srow", style: `--c: ${color}` },
          el("span", { class: "bg" }, el("span", { class: "bar", style: `width: ${(s.amount / top) * 100}%` })),
          el("span", { class: "skill", title: s.name }, skillIcon(s.icon), el("span", { class: "name", text: s.name })),
          ...columns.map((col) => el("span", { class: "num", text: col.value(s, ctx) })),
        ),
      ),
    ),
  );
}

// Golpe a golpe somado: as taxas do jogador, das skills diretas (DoT não
// crita).
function hitRates(skills) {
  const direct = skills.filter((s) => !s.dot);
  const hits = direct.reduce((sum, s) => sum + s.hits, 0);
  const rate = (key) => (hits > 0 ? percent((direct.reduce((sum, s) => sum + s[key], 0) / hits) * 100) : "–");
  return { hits: skills.reduce((sum, s) => sum + s.hits, 0), rate };
}

function playerPanel(view, p, kind, state, rerender) {
  const seconds = view.durationMs / 1000 || 1;
  const rank = view.players.filter((x) => x.damage > 0).indexOf(p) + 1;
  const facts = [
    rank > 0 ? `#${rank}` : null,
    classInfo(p.job).name,
    p.level > 0 ? `Nível ${p.level}` : null,
    p.gear > 0 ? `Item ${int(p.gear)}` : null,
    p.power > 0 ? `Poder ${int(p.power)}` : null,
  ].filter(Boolean);
  const head = el(
    "div",
    { class: "pp-head" },
    classBadge(p.job),
    el("div", {}, el("h3", {}, p.name, p.me ? el("span", { class: "tag", text: "VOCÊ" }) : null), el("span", { class: "muted", text: facts.join(" · ") })),
  );
  if (kind === "heal") {
    const stats = el("div", { class: "cards small" }, card("Cura feita", dash(p.heal)), card("Cura/s", dash(p.heal / seconds)), card("Cura recebida", dash(p.healed)));
    return el("div", { class: "player-panel" }, head, stats, skillsTable(p.heals, seconds, classColor(p.job), kind, state, rerender));
  }
  const { hits, rate } = hitRates(p.skills);
  const stats = el(
    "div",
    { class: "cards small" },
    card("DPS", dash(p.dps)),
    card("Dano", dash(p.damage)),
    card("Contribuição", dash(p.share, percent)),
    card("Golpes", hits > 0 ? int(hits) : "–"),
    card("Crítico", p.crit == null ? "–" : `${Math.round(p.crit)}%`),
    card("Perfeito", rate("perfect")),
    card("Duplo", rate("double")),
    card("Costas", rate("back")),
    card("Golpe múltiplo", rate("multi")),
    card("Aparado pelo alvo", rate("parry")),
  );
  // A skill que mais deu dano, em destaque.
  const best = [...p.skills].sort((a, b) => b.amount - a.amount)[0];
  const total = p.skills.reduce((sum, s) => sum + s.amount, 0) || 1;
  const highlight = best
    ? el(
        "div",
        { class: "best-skill" },
        skillIcon(best.icon),
        el(
          "div",
          {},
          el("span", { class: "label", text: "Skill que mais deu dano" }),
          el("b", { text: best.name }),
          el("span", { class: "muted", text: `${percent((best.amount / total) * 100)} do dano · ${compact(best.amount)} · maior golpe ${dash(best.max)}` }),
        ),
      )
    : null;
  const modes = el(
    "div",
    { class: "segmented", role: "radiogroup", "aria-label": "Colunas das skills" },
    ...[
      ["basic", "Principais"],
      ["all", "Todas as colunas"],
    ].map(([id, label]) =>
      el("button", {
        class: "segment",
        role: "radio",
        "aria-checked": String(skillColumns === id),
        text: label,
        onclick: () => {
          skillColumns = id;
          savePref("skillColumns", id);
          rerender();
        },
      }),
    ),
  );
  return el(
    "div",
    { class: "player-panel" },
    head,
    stats,
    highlight,
    el("div", { class: "pp-tools" }, el("span", { class: "muted", text: "Clique no título de uma coluna para ordenar. A tabela rola para o lado." }), modes),
    skillsTable(p.skills, seconds, classColor(p.job), kind, state, rerender),
  );
}

function renderTab(view, state, rerender) {
  const seconds = view.durationMs / 1000 || 1;
  const pick = (name) => {
    state.player = name;
    rerender();
  };
  if (state.tab === "taken") {
    const players = view.players.filter((p) => p.taken > 0).sort((a, b) => b.taken - a.taken);
    if (players.length === 0) return el("p", { class: "hint", text: "Ninguém levou dano de monstro nesta luta." });
    const total = players.reduce((sum, p) => sum + p.taken, 0) || 1;
    return el(
      "div",
      {},
      playersTable(players, [["Dano receb.", (p) => compact(p.taken)], ["Por segundo", (p) => compact(p.taken / seconds)], ["% do total", (p) => percent((p.taken / total) * 100)]], state, (p) => p.taken, () => {}),
      el("p", { class: "hint", text: "Só o dano de monstros. Por enquanto o meter guarda só o total de cada jogador, sem dizer de qual golpe veio." }),
    );
  }
  const heal = state.tab === "heal";
  const players = heal
    ? view.players.filter((p) => p.heal > 0 || p.healed > 0).sort((a, b) => b.heal - a.heal || b.healed - a.healed)
    : view.players.filter((p) => p.damage > 0);
  if (players.length === 0) return el("p", { class: "hint", text: heal ? "Ninguém curou nesta luta." : "Sem dano nesta luta." });
  if (!players.some((p) => p.name === state.player)) state.player = (players.find((p) => p.me) ?? players[0]).name;
  let columns;
  if (heal) {
    columns = [["Cura feita", (p) => dash(p.heal)], ["Cura/s", (p) => dash(p.heal / seconds)], ["Cura receb.", (p) => dash(p.healed)]];
  } else {
    // Nível de item e poder de combate de quem está no seu grupo.
    columns = [["DPS", (p) => dash(p.dps)], ["%", (p) => dash(p.share, percent)], ["Dano", (p) => dash(p.damage)], ["Crít", (p) => (p.crit == null ? "–" : `${Math.round(p.crit)}%`)]];
    if (players.some((p) => p.gear > 0)) columns.push(["Item", (p) => (p.gear > 0 ? int(p.gear) : "–")]);
    if (players.some((p) => p.power > 0)) columns.push(["Poder", (p) => (p.power > 0 ? int(p.power) : "–")]);
  }
  const selected = players.find((p) => p.name === state.player);
  // Embaixo: o gráfico de DPS, os buffs e as skills no tempo.
  return el(
    "div",
    {},
    el(
      "div",
      { class: "split" },
      playersTable(players, columns, state, heal ? (p) => p.heal : (p) => p.dps, pick),
      playerPanel(view, selected, heal ? "heal" : "damage", state, rerender),
    ),
    fightTimeline(view, state, rerender), // chart.js
  );
}

// Resumo de uma linha para colar no chat do jogo.
function summaryText(view) {
  const players = view.players.filter((p) => p.damage > 0).slice(0, 6);
  const who = players.map((p) => `${p.name} ${compact(p.dps)}`).join(" · ");
  const status = view.kind === "boss" && !view.killed ? " (não morreu)" : "";
  return `[Kerub] ${fightTitle(view)} ${clock(view.durationMs)}${status} | Grupo ${compact(view.partyDps)} DPS | ${who}`;
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = el("textarea", { style: "position: fixed; opacity: 0" });
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  const label = button.textContent;
  button.textContent = "Copiado ✓";
  setTimeout(() => (button.textContent = label), 1600);
}

// ── print ──────────────────────────────────────────────────

// Ícone de câmera (desenho fixo daqui, não vem do jogo).
function cameraIcon() {
  const span = el("span", { class: "btn-icon", "aria-hidden": "true" });
  span.innerHTML = '<svg viewBox="0 0 24 24"><path d="M3 8h3.5l2-3h7l2 3H21v12H3z"/><circle cx="12" cy="13.5" r="3.6"/></svg>';
  return span;
}

// Print da luta: o pedaço dela que está na tela vai para a área de
// transferência e para Imagens\Kerub.
async function printFight(container, view, state, rerender) {
  state.shot = null;
  container.querySelector(".shot-note")?.remove();
  // Espera a tela redesenhar sem o aviso do print anterior.
  await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  const area = $("main").getBoundingClientRect();
  const box = container.getBoundingClientRect();
  const pad = 14;
  const x = Math.max(area.left, box.left - pad);
  const y = Math.max(area.top, box.top - pad);
  const right = Math.min(area.right, box.right + pad);
  const bottom = Math.min(area.bottom, box.bottom + pad);
  let shot = null;
  if (right - x > 10 && bottom - y > 10) {
    try {
      shot = await invoke("screenshot", { x, y, width: right - x, height: bottom - y, scale: window.devicePixelRatio || 1, name: `Kerub - ${fightTitle(view)} - ${stamp(Date.now())}` });
    } catch {
      shot = null;
    }
  }
  let text;
  if (shot?.clipboard && shot.file) text = "Print copiado: cole com Ctrl + V. Também ficou salvo em Imagens\\Kerub.";
  else if (shot?.clipboard) text = "Print copiado: cole com Ctrl + V. Não deu para salvar o arquivo.";
  else if (shot?.file) text = "Print salvo em Imagens\\Kerub, mas não deu para copiar.";
  else text = "Não deu para tirar o print. Deixe a janela do Kerub à vista e tente de novo.";
  state.shot = { text, file: shot?.file ?? null, ok: !!(shot?.clipboard || shot?.file), at: Date.now() };
  rerender();
}

// O aviso do último print, por alguns segundos (a tela ao vivo se refaz a
// cada segundo: o aviso fica no estado dela).
function shotNote(state) {
  if (!state.shot || Date.now() - state.shot.at > 10000) return null;
  const open = state.shot.file
    ? el("button", { class: "link", text: "Abrir pasta", onclick: () => invoke("show_screenshot", { file: state.shot.file }).catch(() => {}) })
    : null;
  return el("div", { class: `shot-note${state.shot.ok ? "" : " bad"}`, role: "status" }, el("span", { text: state.shot.text }), open);
}

function fightView(view, state, { live = false, best = false, onDelete } = {}) {
  const container = el("div", { class: "fight" });
  const rerender = () => container.replaceWith(fightView(view, state, { live, best, onDelete }));

  const badges = [];
  if (view.kind === "combat") {
    badges.push(el("span", { class: "pill", text: "Luta comum" }));
    badges.push(el("span", { class: "pill", text: `${plural(view.targets, "alvo", "alvos")} · ${plural(view.kills, "abatido", "abatidos")}` }));
  } else if (view.train) badges.push(el("span", { class: "pill", text: "Boneco de treino" }));
  else if (view.killed) badges.push(el("span", { class: "pill ok", text: "Derrotado" }));
  else if (!live) badges.push(el("span", { class: "pill", text: "Não derrotado" }));
  if (best) badges.push(el("span", { class: "pill best", text: "Recorde pessoal" }));

  const sub = [view.startMs > 0 ? `${date(view.startMs)}, ${time(view.startMs)}` : null, view.dungeon || null].filter(Boolean).join(" · ");
  const actions = el("div", { class: "actions" });
  const print = el("button", { class: "button", title: "Copia uma imagem desta luta (a parte que está na tela) e salva em Imagens\\Kerub" }, cameraIcon(), el("span", { text: "Print" }));
  print.addEventListener("click", () => printFight(container, view, state, rerender));
  const copy = el("button", { class: "button", text: "Copiar resumo", title: "Uma linha com o DPS de cada um, para colar no chat do jogo" });
  copy.addEventListener("click", () => copyText(summaryText(view), copy));
  actions.append(print, copy);
  if (onDelete) {
    const del = el("button", { class: "button danger", text: "Apagar luta" });
    let armed = null;
    del.addEventListener("click", () => {
      if (armed) {
        clearTimeout(armed);
        onDelete();
        return;
      }
      del.textContent = "Clique de novo para apagar";
      armed = setTimeout(() => {
        armed = null;
        del.textContent = "Apagar luta";
      }, 4000);
    });
    actions.append(del);
  }

  container.append(
    el("header", { class: "fight-head" }, el("div", {}, el("h2", { text: live ? view.boss || "Luta" : fightTitle(view) }), el("div", { class: "sub" }, sub ? el("span", { class: "muted", text: sub }) : null, ...badges)), actions),
  );
  const noteEl = shotNote(state);
  if (noteEl) container.append(noteEl);

  if (live) container.append(liveBoss());

  const seconds = view.durationMs / 1000 || 1;
  const cards = el(
    "div",
    { class: "cards" },
    card("Duração", clock(view.durationMs)),
    card("Dano total", compact(view.totalDamage)),
    card("DPS do grupo", compact(view.partyDps), null, "accent"),
    card("Pico de DPS", dash(view.peakDps), view.lowDps > 0 ? `mais baixo ${compact(view.lowDps)}` : null),
    card("Dano recebido", dash(view.taken), view.taken > 0 ? `${compact(view.taken / seconds)} por segundo` : null, "taken"),
    card("Cura feita", dash(view.heal)),
  );
  if (view.ping?.length) {
    const values = view.ping.map((p) => p.ms);
    const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
    cards.append(card("Ping médio", `${Math.round(avg)} ms`, `máximo ${Math.max(...values)} ms`));
  }
  container.append(cards);

  const tabs = el("div", { class: "tabs", role: "tablist" });
  for (const [id, label] of TABS) {
    tabs.append(
      el("button", {
        role: "tab",
        class: "tab",
        "aria-selected": String(state.tab === id),
        text: label,
        onclick: () => {
          state.tab = id;
          // Ao vivo, a linha do tempo pede a luta com os horários e os buffs.
          if (live) refreshLive();
          else rerender();
        },
      }),
    );
  }
  container.append(tabs, el("div", { class: "tab-body", role: "tabpanel" }, renderTab(view, state, rerender)));
  return container;
}

// ── ao vivo ────────────────────────────────────────────────

const liveState = fightState();
let snapshot = null;
let liveView = null;

// HP do chefe e tempo para acabar, do evento de 250 ms (mais rápido que os
// detalhes, que chegam a cada segundo).
function liveBoss() {
  const box = el("div", { class: "live-boss", id: "live-boss" });
  fillLiveBoss(box);
  return box;
}

function fillLiveBoss(box) {
  if (!box || !snapshot) return;
  const hasHp = snapshot.targetMaxHp > 0 && snapshot.targetHp >= 0;
  if (!hasHp) {
    box.replaceChildren();
    return;
  }
  const pct = Math.min(100, (snapshot.targetHp / snapshot.targetMaxHp) * 100);
  const dps = snapshot.rows.reduce((sum, r) => sum + r.dps, 0);
  const left = snapshot.targetIsBoss && snapshot.targetHp > 0 && dps > 0 ? `≈ ${clock((snapshot.targetHp / dps) * 1000)} para acabar neste DPS` : "";
  box.replaceChildren(
    el("div", { class: "hp-line" }, el("span", { text: `HP ${compact(snapshot.targetHp)} · ${percent(pct)}` }), el("span", { class: "muted", text: left })),
    el("div", { class: "hp" }, el("div", { class: "hp-fill", style: `width: ${pct}%` })),
  );
}

async function refreshLive() {
  if (page !== "live" || document.hidden) return;
  try {
    liveView = await invoke("live_fight", { full: liveState.tab !== "taken" });
  } catch {
    return;
  }
  $("live-empty").hidden = !!liveView;
  if (!liveView) {
    $("live-fight").replaceChildren();
    return;
  }
  const scroll = $("main").scrollTop;
  $("live-fight").replaceChildren(fightView(liveView, liveState, { live: true }));
  $("main").scrollTop = scroll;
}

// O que medir: o mesmo botão "Chefe" do overlay.
function renderMode() {
  $("live-mode").replaceChildren(
    ...MODES.map(([id, label]) =>
      el("button", {
        class: "segment",
        role: "radio",
        "aria-checked": String(config.mode === id),
        text: label,
        onclick: () => saveConfig({ mode: id }),
      }),
    ),
  );
}

$("live-reset").addEventListener("click", async () => {
  await invoke("reset");
  refreshLive();
});

setInterval(refreshLive, 1000);
document.addEventListener("visibilitychange", refreshLive);

// ── histórico ──────────────────────────────────────────────

let fights = [];
// O melhor DPS seu em cada chefe (por personagem), das lutas que ele morreu.
let bests = new Map();
const bestKey = (f) => `${f.me}|${f.mobCode}|${f.dungeonId}`;

async function refreshHistory() {
  try {
    fights = await invoke("history_list");
  } catch (error) {
    $("history-list").replaceChildren(el("p", { class: "hint", text: String(error) }));
    return;
  }
  bests = new Map();
  for (const f of fights) {
    if (f.kind !== "boss" || !f.killed || !f.me || f.myDps <= 0) continue;
    const key = bestKey(f);
    if (!bests.has(key) || bests.get(key).myDps < f.myDps) bests.set(key, f);
  }
  if (page === "history") renderHistory();
  if (page === "records") renderRecords();
}

const isBest = (f) => bests.get(bestKey(f))?.id === f.id;

// Dungeon seguida: lutas na mesma instância com menos de 20 min entre uma e
// outra. O tempo é do primeiro golpe no primeiro chefe ao fim do último.
const RUN_GAP_MS = 20 * 60 * 1000;

function groupRuns(list) {
  const out = [];
  const ordered = [...list].sort((a, b) => a.startMs - b.startMs);
  for (const f of ordered) {
    const last = out.at(-1);
    const prev = last?.fights.at(-1);
    if (f.dungeonId && last?.dungeonId === f.dungeonId && f.startMs - (prev.startMs + prev.durationMs) < RUN_GAP_MS) {
      last.fights.push(f);
    } else {
      out.push({ dungeonId: f.dungeonId, dungeon: f.dungeon, fights: [f] });
    }
  }
  return out.reverse();
}

function fightRow(f) {
  const combat = f.kind === "combat";
  const facts = [time(f.startMs), clock(f.durationMs), f.kind === "train" ? "boneco" : null, combat ? plural(f.targets, "alvo", "alvos") : null];
  let status = null;
  if (combat) status = el("span", { class: "pill", text: "Luta comum" });
  else if (f.kind === "boss") status = el("span", { class: f.killed ? "pill ok" : "pill", text: f.killed ? "Derrotado" : "Não derrotado" });
  const row = el(
    "button",
    { class: `hrow${combat ? " common" : ""}`, onclick: () => openFight(f.id) },
    el("span", { class: "hparty" }, ...f.jobs.slice(0, 8).map((j) => classBadge(j, true))),
    el("span", { class: "hboss" }, el("b", { text: fightTitle(f) }), el("span", { class: "muted", text: facts.filter(Boolean).join(" · ") })),
    el("span", { class: "hstatus" }, status, isBest(f) ? el("span", { class: "pill best", text: "Recorde" }) : null),
    el("span", { class: "hnum" }, el("span", { class: "muted", text: "Grupo" }), el("b", { text: `${compact(f.partyDps)} DPS` })),
    el("span", { class: "hnum" }, el("span", { class: "muted", text: f.me ? "Você" : "" }), el("b", { text: f.myDps > 0 ? `${compact(f.myDps)} DPS` : "–" })),
  );
  if (!f.detailed) row.title = "Só o resumo: os detalhes desta luta antiga foram apagados para economizar espaço.";
  return row;
}

function renderHistory() {
  const query = $("history-filter").value.trim().toLowerCase();
  const train = $("history-train").checked;
  const common = $("history-common").checked;
  const list = fights.filter(
    (f) => (train || f.kind !== "train") && (common || f.kind !== "combat") && (!query || `${fightTitle(f)} ${f.boss} ${f.dungeon}`.toLowerCase().includes(query)),
  );
  if (list.length === 0) {
    $("history-list").replaceChildren(
      el(
        "div",
        { class: "empty-state" },
        el("h2", { text: fights.length ? "Nada encontrado" : "Nenhuma luta gravada ainda" }),
        el("p", { text: fights.length ? "Tente outro nome ou ligue as lutas escondidas nos filtros." : "Cada luta de 5 segundos ou mais é gravada aqui quando acaba: chefes, boneco de treino e as lutas comuns." }),
      ),
    );
    return;
  }
  const days = new Map();
  for (const run of groupRuns(list)) {
    const day = date(run.fights[0].startMs);
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(run);
  }
  const today = date(Date.now());
  const yesterday = date(Date.now() - 86400000);
  const out = [];
  for (const [day, runs] of days) {
    out.push(el("h3", { class: "day", text: day === today ? "Hoje" : day === yesterday ? "Ontem" : day }));
    for (const run of runs) {
      if (run.dungeonId && run.fights.length > 1) {
        const first = run.fights[0];
        const last = run.fights.at(-1);
        const total = Math.max(...run.fights.map((f) => f.startMs + f.durationMs)) - first.startMs;
        const bosses = run.fights.filter((f) => f.kind === "boss");
        const killed = bosses.filter((f) => f.killed).length;
        out.push(
          el(
            "div",
            { class: "run" },
            el(
              "div",
              { class: "run-head" },
              el("b", { text: run.dungeon || `Dungeon ${run.dungeonId}` }),
              el("span", { class: "muted", text: `${plural(bosses.length, "chefe", "chefes")} · ${plural(killed, "derrotado", "derrotados")} · ${clock(total)} do primeiro ao último golpe` }),
            ),
            ...[...run.fights].reverse().map(fightRow),
          ),
        );
      } else {
        for (const f of [...run.fights].reverse()) {
          out.push(run.dungeon ? el("div", { class: "solo" }, el("span", { class: "muted small", text: run.dungeon }), fightRow(f)) : fightRow(f));
        }
      }
    }
  }
  $("history-list").replaceChildren(...out);
}

$("history-filter").addEventListener("input", renderHistory);
$("history-train").addEventListener("change", renderHistory);
// Lutas comuns aparecem; a escolha fica neste PC.
$("history-common").checked = loadPref("history.common") !== "false";
$("history-common").addEventListener("change", () => {
  savePref("history.common", $("history-common").checked);
  renderHistory();
});

let openState = fightState();

function openFight(id) {
  go({ page: "fight", id });
}

async function loadFight(id) {
  openState = fightState();
  show("fight");
  $("fight-view").replaceChildren(spinner("Abrindo a luta"));
  let view;
  try {
    view = await invoke("history_fight", { id });
  } catch (error) {
    $("fight-view").replaceChildren(el("p", { class: "hint", text: String(error) }));
    return;
  }
  const summary = fights.find((f) => f.id === id);
  $("fight-view").replaceChildren(
    fightView(view, openState, {
      best: summary ? isBest(summary) : false,
      onDelete: async () => {
        await invoke("history_delete", { id });
        go({ page: "history" });
      },
    }),
  );
}

$("fight-back").addEventListener("click", () => go({ page: "history" }));
listen("history", () => {
  if (page === "history" || page === "records") refreshHistory();
});

// ── recordes ───────────────────────────────────────────────

function renderRecords() {
  const byChar = new Map();
  for (const f of fights) {
    if (f.kind !== "boss" || !f.killed || !f.me) continue;
    if (!byChar.has(f.me)) byChar.set(f.me, new Map());
    const bosses = byChar.get(f.me);
    const key = `${f.mobCode}|${f.dungeonId}`;
    const entry = bosses.get(key) ?? { boss: f.boss, dungeon: f.dungeon, job: f.myJob, best: null, fastest: null, kills: 0 };
    entry.kills++;
    if (f.myDps > 0 && (!entry.best || f.myDps > entry.best.myDps)) entry.best = f;
    if (!entry.fastest || f.durationMs < entry.fastest.durationMs) entry.fastest = f;
    bosses.set(key, entry);
  }
  if (byChar.size === 0) {
    $("records-list").replaceChildren(
      el("div", { class: "empty-state" }, el("h2", { text: "Nenhum recorde ainda" }), el("p", { text: "Derrote um chefe com o meter aberto e o seu DPS aparece aqui." })),
    );
    return;
  }
  const out = [];
  for (const [name, bosses] of byChar) {
    const entries = [...bosses.values()].sort((a, b) => a.boss.localeCompare(b.boss, "pt-BR"));
    const job = entries.find((e) => e.job)?.job ?? "";
    out.push(
      el(
        "div",
        { class: "card records" },
        el("h3", { class: "who" }, classBadge(job), el("span", { text: name })),
        el(
          "div",
          { class: "rtable" },
          el("div", { class: "rrow head" }, el("span", { text: "Chefe" }), el("span", { text: "Melhor DPS" }), el("span", { text: "Mais rápido" }), el("span", { text: "Vitórias" })),
          ...entries.map((e) =>
            el(
              "div",
              { class: "rrow" },
              el("span", { class: "hboss" }, el("b", { text: e.boss }), e.dungeon ? el("span", { class: "muted", text: e.dungeon }) : null),
              e.best
                ? el("button", { class: "link", title: "Abrir essa luta", onclick: () => openFight(e.best.id) }, el("b", { text: compact(e.best.myDps) }), el("span", { class: "muted", text: ` · ${date(e.best.startMs)}` }))
                : el("span", { text: "–" }),
              el("button", { class: "link", title: "Abrir essa luta", onclick: () => openFight(e.fastest.id) }, el("b", { text: clock(e.fastest.durationMs) })),
              el("span", { text: String(e.kills) }),
            ),
          ),
        ),
      ),
    );
  }
  $("records-list").replaceChildren(...out);
}

// ── personalizar ───────────────────────────────────────────

const COLUMN_NAMES = [
  ["dps", "DPS"],
  ["share", "% do dano do grupo"],
  ["damage", "Dano"],
  ["crit", "Crítico"],
  ["heal", "Cura feita"],
  ["healed", "Cura recebida"],
  ["taken", "Dano recebido"],
];

function renderSettings() {
  $("set-overlay").checked = config.overlay;
  $("overlay-toggle").checked = config.overlay;
  $("set-time-left").checked = config.timeLeft;
  $("set-rows").replaceChildren(
    ...[5, 8, 10, 15, 20].map((n) =>
      el("button", {
        type: "button",
        class: "segment",
        role: "radio",
        "aria-checked": String(config.maxRows === n),
        text: String(n),
        onclick: () => saveConfig({ maxRows: n }),
      }),
    ),
  );

  $("set-columns").replaceChildren(
    ...COLUMN_NAMES.map(([id, label]) => {
      const input = el("input", { type: "checkbox" });
      input.checked = config.columns.includes(id);
      input.addEventListener("change", () => {
        const columns = COLUMN_NAMES.map(([c]) => c).filter((c) => (c === id ? input.checked : config.columns.includes(c)));
        saveConfig({ columns });
      });
      return el("label", { class: "check" }, input, label);
    }),
  );

  $("set-colors").replaceChildren(
    ...Object.entries(CLASSES).map(([key, info]) => {
      const color = classColor(key);
      const ratio = contrast(color, "#ffffff");
      const input = el("input", { type: "color", "aria-label": `Cor do ${info.name}` });
      input.value = color;
      input.addEventListener("change", () => saveConfig({ colors: { ...config.colors, [key]: input.value } }));
      const ok = ratio >= 4.5;
      return el(
        "div",
        { class: "color-row" },
        el("div", { class: "preview", style: `--c: ${color}` }, classBadge(key), el("b", { text: info.name }), el("span", { class: "num", text: "72,0K" })),
        input,
        el("span", { class: ok ? "contrast ok" : "contrast low", text: ok ? `Contraste ${ratio.toFixed(1).replace(".", ",")}:1` : `Contraste baixo (${ratio.toFixed(1).replace(".", ",")}:1): escureça a cor` }),
      );
    }),
  );
}

$("set-overlay").addEventListener("change", (e) => saveConfig({ overlay: e.target.checked }));
$("overlay-toggle").addEventListener("change", (e) => saveConfig({ overlay: e.target.checked }));
$("set-time-left").addEventListener("change", (e) => saveConfig({ timeLeft: e.target.checked }));
$("reset-colors").addEventListener("click", () => saveConfig({ colors: {} }));

// ── captura e Npcap ────────────────────────────────────────

// No topo, como o "Aion 2 is running" da referência: o jogo está aberto e o
// meter está lendo a luta?
const INSTALLING = "Baixando o Npcap…";
let npcapSetup = null;

function renderCapture() {
  if (!snapshot) return;
  const noNpcap = snapshot.status === "noNpcap";
  let text;
  let state;
  if (noNpcap) [text, state] = [npcapSetup ?? "Npcap não instalado", "off"];
  else if (!snapshot.gameRunning) [text, state] = ["AION 2 fechado", "idle"];
  else if (snapshot.status === "waiting") [text, state] = ["AION 2 aberto · procurando a conexão", "wait"];
  else [text, state] = [snapshot.ping != null ? `AION 2 aberto · ${snapshot.ping} ms` : "AION 2 aberto", "on"];
  $("game-text").textContent = text;
  $("game").dataset.state = state;
  $("game").title = state === "wait" ? "Entre numa zona ou troque de zona para o meter achar a conexão do jogo." : text;
  $("install-npcap").hidden = !noNpcap || npcapSetup === INSTALLING;
}

$("install-npcap").addEventListener("click", async () => {
  npcapSetup = INSTALLING;
  renderCapture();
  try {
    await invoke("install_npcap");
    npcapSetup = null;
  } catch (error) {
    npcapSetup = `${error} Também dá para instalar pelo npcap.com.`;
  }
  renderCapture();
});

listen("meter", (event) => {
  snapshot = event.payload;
  renderCapture();
  if (page === "live" && !document.hidden) fillLiveBoss($("live-boss"));
});

// ── tamanho do texto ───────────────────────────────────────

const SCALES = [1, 1.15, 1.3, 1.5, 1.75];
let scale = Number(loadPref("client.scale")) || 1;

function applyScale(next) {
  scale = Math.min(SCALES.at(-1), Math.max(SCALES[0], next));
  document.documentElement.style.setProperty("--scale", scale);
  $("scale-text").textContent = `Texto ${Math.round(scale * 100)}%`;
  savePref("client.scale", scale);
}

function stepScale(direction) {
  const i = SCALES.findIndex((s) => s >= scale - 0.001);
  applyScale(SCALES[Math.max(0, Math.min(SCALES.length - 1, i + direction))]);
}

$("scale").addEventListener("click", () => {
  const i = SCALES.findIndex((s) => s >= scale - 0.001);
  applyScale(SCALES[(i + 1) % SCALES.length]);
});
window.addEventListener(
  "wheel",
  (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    stepScale(e.deltaY < 0 ? 1 : -1);
  },
  { passive: false },
);
window.addEventListener("keydown", (e) => {
  if (!e.ctrlKey) return;
  if (e.key === "+" || e.key === "=") stepScale(1);
  else if (e.key === "-") stepScale(-1);
  else if (e.key === "0") applyScale(1);
  else return;
  e.preventDefault();
});

// ── início ─────────────────────────────────────────────────

(async () => {
  applyScale(scale);
  await loadConfig();
  renderSettings();
  renderMode();
  onConfig(() => {
    renderSettings();
    renderMode();
    // As cores novas valem já nas barras e no gráfico.
    if (page === "live") refreshLive();
    if (page === "history") renderHistory();
    if (page === "records") renderRecords();
  });
  go({ page: "live" });
  refreshHistory();
})();
