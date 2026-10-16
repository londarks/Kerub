// O overlay por cima do jogo. As colunas, as cores das classes e o resto das
// escolhas vêm do client (shared.js); tamanho, posição, transparência e trava
// são deste overlay e ficam neste PC.

const { LogicalSize, PhysicalPosition } = window.__TAURI__.dpi;
const { availableMonitors } = window.__TAURI__.window;
const win = window.__TAURI__.window.getCurrentWindow();

// Colunas que o client deixa escolher: título, largura (rem) e valor.
const COLUMNS = {
  dps: { label: "DPS <i>↓</i>", width: 4.4, value: (r) => dash(r.dps) },
  share: { label: "%", width: 3.7, title: "Parte do dano do grupo", value: (r) => dash(r.share, percent) },
  damage: { label: "Dano", width: 4.2, value: (r) => dash(r.damage) },
  crit: { label: "Crít", width: 3, title: "Golpes críticos", value: (r) => (r.crit == null ? "–" : `${Math.round(r.crit)}%`) },
  heal: { label: "Cura<br>feita", width: 4.4, title: "Cura que o jogador fez", value: (r) => dash(r.heal) },
  healed: { label: "Cura<br>receb.", width: 4.4, title: "Cura que o jogador recebeu", value: (r) => dash(r.healed) },
  taken: { label: "Dano<br>receb.", width: 4.4, title: "Dano que o jogador levou de monstros", value: (r) => dash(r.taken) },
};
// Largura do resto da janela, em rem: nome do jogador, bordas e espaços.
const NAME_REM = 10.5;
const FRAME_REM = 2.8;
const GAP_REM = 0.5;

const SCALES = [1, 1.15, 1.3, 1.5, 1.75, 2];
const DEFAULT_SCALE = 1.15;

// Cada clique deixa o fundo mais transparente; depois de 50% volta ao normal.
const ALPHAS = [1, 0.9, 0.8, 0.7, 0.6, 0.5];

const STATUS = {
  noNpcap: "Npcap não encontrado. Ele é necessário para ler o tráfego do jogo.",
  waiting: "Procurando a conexão do AION 2… Entre ou troque de zona.",
};

const $ = (id) => document.getElementById(id);
const meterEl = $("meter");
const rowsEl = $("rows");
const rowEls = new Map();
let lastSnapshot = null;

// ── colunas ────────────────────────────────────────────────

const columns = () => config.columns.filter((c) => COLUMNS[c]);

function fitRem() {
  const cols = columns();
  return FRAME_REM + NAME_REM + cols.reduce((sum, c) => sum + COLUMNS[c].width + GAP_REM, 0);
}

function applyColumns() {
  const cols = columns();
  meterEl.style.setProperty("--cols", ["minmax(0, 1fr)", ...cols.map((c) => `${COLUMNS[c].width}rem`)].join(" "));
  $("thead").replaceChildren(
    el("span", { text: "Jogador" }),
    ...cols.map((c) => {
      const span = el("span", { title: COLUMNS[c].title });
      span.innerHTML = COLUMNS[c].label; // texto fixo daqui, não do jogo
      return span;
    }),
  );
  // As linhas são refeitas com as colunas novas.
  rowEls.clear();
  rowsEl.replaceChildren();
  if (lastSnapshot) renderRows(lastSnapshot.rows);
  else renderRows([]);
}

// ── linhas ─────────────────────────────────────────────────

function makeRow() {
  const li = el("li", { tabindex: "0", role: "button" });
  li.append(
    el("span", { class: "bg" }, el("span", { class: "bar" })),
    el("span", { class: "player" }, el("span", { class: "badge-slot" }), el("span", { class: "name" })),
    ...columns().map((c) => el("span", { class: `col col-${c}` })),
  );
  const open = () => openDetails(li.dataset.name);
  li.addEventListener("click", open);
  li.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open();
    }
  });
  return li;
}

const moreEl = el("li", { class: "more" });

// Em PvP massivo aparecem dezenas de jogadores: a janela mostra os primeiros e
// resume o resto numa linha. Você fora do top fica fixo por último.
function pickRows(rows) {
  const max = config.maxRows;
  const meIndex = rows.findIndex((r) => r.me);
  if (meIndex < max) return rows.slice(0, max).map((row, rank) => ({ row, rank }));
  return [...rows.slice(0, max - 1).map((row, rank) => ({ row, rank })), { row: rows[meIndex], rank: meIndex }];
}

function renderRows(rows) {
  if (rows.length === 0) {
    rowEls.clear();
    rowsEl.replaceChildren(el("li", { class: "empty", text: "Sem dano ainda" }));
    return;
  }
  rowsEl.querySelector(".empty")?.remove();

  const top = rows[0].dps || 1;
  const picked = pickRows(rows);
  const seen = new Set();
  const cols = columns();
  picked.forEach(({ row, rank }, i) => {
    seen.add(row.id);
    let li = rowEls.get(row.id);
    if (!li) {
      li = makeRow();
      rowEls.set(row.id, li);
    }
    const info = classInfo(row.job);
    if (li.dataset.job !== row.job || li.dataset.color !== classColor(row.job)) {
      li.dataset.job = row.job;
      li.dataset.color = classColor(row.job);
      li.style.setProperty("--c", classColor(row.job));
      li.querySelector(".badge-slot").replaceChildren(classBadge(row.job));
    }
    li.dataset.name = row.name;
    li.classList.toggle("me", row.me);
    li.classList.toggle("selected", row.name === detailsName);
    li.querySelector(".bar").style.width = `${(row.dps / top) * 100}%`;
    li.querySelector(".name").textContent = `${rank !== i ? `${rank + 1}º ` : ""}${row.name || info.name}`;
    li.title = `${row.name || "?"} · ${info.name} · clique para ver as skills`;
    cols.forEach((c) => {
      li.querySelector(`.col-${c}`).textContent = COLUMNS[c].value(row);
    });

    if (rowsEl.children[i] !== li) rowsEl.insertBefore(li, rowsEl.children[i] ?? null);
  });

  for (const [id, li] of rowEls) {
    if (!seen.has(id)) {
      li.remove();
      rowEls.delete(id);
    }
  }

  const hidden = rows.filter((r) => !seen.has(r.id));
  if (hidden.length === 0) {
    moreEl.remove();
    return;
  }
  const hiddenDps = hidden.reduce((sum, r) => sum + r.dps, 0);
  moreEl.textContent = `+${hidden.length} jogadores · ${compact(hiddenDps)} DPS`;
  if (rowsEl.children[picked.length] !== moreEl) {
    rowsEl.insertBefore(moreEl, rowsEl.children[picked.length] ?? null);
  }
}

// ── tela ───────────────────────────────────────────────────

function render(snap) {
  lastSnapshot = snap;
  $("timer").textContent = `(${clock(snap.battleMs)})`;
  // Ping alto em vermelho claro: a partir de 150 ms o jogo já atrasa.
  $("ping").hidden = snap.ping == null;
  $("ping").textContent = snap.ping == null ? "" : `${snap.ping} ms`;
  $("ping").classList.toggle("high", snap.ping >= 150);

  $("boss").hidden = !snap.target;
  $("target").textContent = snap.target;
  const hasHp = snap.targetMaxHp > 0 && snap.targetHp >= 0;
  const hpPct = hasHp ? Math.min(100, (snap.targetHp / snap.targetMaxHp) * 100) : 0;
  $("hp").hidden = !hasHp;
  $("hp-fill").style.width = `${hpPct}%`;
  $("hp-pct").textContent = hasHp ? `${compact(snap.targetHp)} · ${percent(hpPct)}` : "";

  const totalDamage = snap.rows.reduce((sum, r) => sum + r.damage, 0);
  const totalDps = snap.rows.reduce((sum, r) => sum + r.dps, 0);
  $("total-damage").textContent = compact(totalDamage);
  $("total-dps").textContent = compact(totalDps, 2);

  // Quanto falta com o DPS de agora: HP que sobra ÷ DPS do grupo.
  const showLeft = config.timeLeft && snap.targetIsBoss && hasHp && snap.targetHp > 0 && totalDps > 0;
  $("time-left").hidden = !showLeft;
  if (showLeft) $("time-left").textContent = `≈ ${clock((snap.targetHp / totalDps) * 1000)} para acabar neste DPS`;

  renderRows(snap.rows);

  const noNpcap = snap.status === "noNpcap";
  const message = noNpcap && npcapSetup ? npcapSetup : STATUS[snap.status];
  $("status").hidden = !message;
  $("status-text").textContent = message ?? "";
  $("install-npcap").hidden = !noNpcap || npcapSetup === INSTALLING;
}

// ── detalhes de um jogador ─────────────────────────────────
// Clique no nome: as skills dele nesta luta, atualizadas a cada segundo.

const MAX_SKILLS = 8;
let detailsName = null;
let detailsTimer = null;

function openDetails(name) {
  if (detailsName === name) {
    closeDetails();
    return;
  }
  detailsName = name;
  $("details").hidden = false;
  for (const li of rowEls.values()) li.classList.toggle("selected", li.dataset.name === name);
  refreshDetails();
  clearInterval(detailsTimer);
  detailsTimer = setInterval(refreshDetails, 1000);
}

function closeDetails() {
  detailsName = null;
  clearInterval(detailsTimer);
  $("details").hidden = true;
  for (const li of rowEls.values()) li.classList.remove("selected");
}

async function refreshDetails() {
  if (!detailsName) return;
  let fight = null;
  try {
    fight = await invoke("live_fight");
  } catch {
    // Tenta de novo no próximo segundo.
  }
  const index = fight?.players.findIndex((p) => p.name === detailsName) ?? -1;
  const player = index >= 0 ? fight.players[index] : null;
  $("details-name").textContent = detailsName;
  if (!player) {
    $("details-badge").replaceChildren();
    $("details-sub").textContent = "Sem dados dele nesta luta.";
    $("skills").replaceChildren();
    return;
  }
  $("details-badge").replaceChildren(classBadge(player.job));
  const seconds = fight.durationMs / 1000 || 1;
  $("details-sub").textContent =
    `#${index + 1} · ${classInfo(player.job).name} · ${compact(player.dps)} DPS · ${compact(player.damage)} (${percent(player.share)})`;

  const color = classColor(player.job);
  const top = player.skills[0]?.amount || 1;
  $("skills").replaceChildren(
    ...player.skills.slice(0, MAX_SKILLS).map((s) =>
      el(
        "li",
        { style: `--c: ${color}`, title: `${s.name}: ${s.hits} golpes, maior ${compact(s.max)}` },
        el("span", { class: "bg" }, el("span", { class: "bar", style: `width: ${(s.amount / top) * 100}%` })),
        el("span", { class: "skill-name" }, skillIcon(s.icon), el("span", { class: "name", text: s.name })),
        el("span", { class: "col", text: compact(s.amount) }),
        el("span", { class: "col", text: compact(s.amount / seconds) }),
        el("span", { class: "col", text: s.crit == null ? "–" : `${Math.round(s.crit)}%` }),
      ),
    ),
  );
  if (player.skills.length === 0) $("skills").replaceChildren(el("li", { class: "empty", text: "Sem skills de dano." }));
}

$("details-close").addEventListener("click", closeDetails);

// ── tamanho da janela ──────────────────────────────────────
// A largura é sua (canto de baixo à direita) e fica salva. A altura acompanha
// o conteúdo, para não sobrar área vazia tampando o jogo.

let width = Number(loadPref("width")) || window.innerWidth;
let height = 0;
let scale = Number(loadPref("scale")) || DEFAULT_SCALE;

function applySize() {
  if (height > 0) win.setSize(new LogicalSize(width, height));
}

// Largura que cabe as colunas escolhidas.
function fitWidth() {
  width = Math.ceil(fitRem() * 12 * scale);
  savePref("width", width);
  applySize();
}

new ResizeObserver(() => {
  const h = Math.ceil(meterEl.getBoundingClientRect().height);
  if (h === height) return;
  height = h;
  applySize();
}).observe(meterEl);

window.addEventListener("resize", () => {
  if (window.innerWidth === width) return;
  width = window.innerWidth;
  savePref("width", width);
});

// ── tamanho do texto ───────────────────────────────────────

function applyScale(next) {
  next = Math.min(SCALES.at(-1), Math.max(SCALES[0], next));
  // A janela cresce na mesma proporção, para as colunas não apertarem.
  width = Math.round(width * (next / scale));
  scale = next;
  document.documentElement.style.setProperty("--scale", scale);
  $("scale").title = `Tamanho do texto: ${Math.round(scale * 100)}% (Ctrl + roda do mouse)`;
  savePref("scale", scale);
  savePref("width", width);
  applySize();
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
  else if (e.key === "0") applyScale(DEFAULT_SCALE);
  else return;
  e.preventDefault();
});

// ── transparência do fundo ─────────────────────────────────

let alpha = ALPHAS.includes(Number(loadPref("alpha"))) ? Number(loadPref("alpha")) : 1;

function applyAlpha() {
  document.documentElement.style.setProperty("--alpha", alpha);
  meterEl.classList.toggle("see-through", alpha < 1);
  const label = `Fundo ${Math.round(alpha * 100)}% visível (clique para mudar)`;
  $("opacity").title = label;
  $("opacity").setAttribute("aria-label", label);
  savePref("alpha", alpha);
}

$("opacity").addEventListener("click", () => {
  alpha = ALPHAS[(ALPHAS.indexOf(alpha) + 1) % ALPHAS.length];
  applyAlpha();
});

// ── arrastar, travar, redimensionar ────────────────────────

let locked = loadPref("locked") === "true";

function applyLock() {
  meterEl.classList.toggle("locked", locked);
  $("lock").classList.toggle("on", locked);
  const label = locked ? "Destravar posição" : "Travar posição";
  $("lock").title = label;
  $("lock").setAttribute("aria-label", label);
  $("shackle").setAttribute("d", locked ? "M8 11V7a4 4 0 0 1 8 0v4" : "M8 11V7a4 4 0 0 1 7.6-1.8");
}

// Arrasta por qualquer lugar menos botões e linhas, que abrem os detalhes.
meterEl.addEventListener("mousedown", (e) => {
  if (e.button !== 0 || locked || e.target.closest("button, .grip, #rows li, .details")) return;
  win.startDragging();
});

$("grip").addEventListener("mousedown", (e) => {
  e.preventDefault();
  if (!locked) win.startResizeDragging("East");
});

$("lock").addEventListener("click", () => {
  locked = !locked;
  savePref("locked", locked);
  applyLock();
});

// A posição fica salva; volta nela se ainda estiver numa tela ligada.
win.onMoved(({ payload }) => {
  savePref("x", payload.x);
  savePref("y", payload.y);
});

async function restorePosition() {
  const x = Number(loadPref("x"));
  const y = Number(loadPref("y"));
  if (!loadPref("x") || !Number.isFinite(x) || !Number.isFinite(y)) return;
  try {
    const monitors = await availableMonitors();
    const visible = monitors.some(({ position: p, size: s }) => x >= p.x - 20 && y >= p.y - 20 && x < p.x + s.width - 40 && y < p.y + s.height - 40);
    if (visible) await win.setPosition(new PhysicalPosition(x, y));
  } catch {
    // Fica onde o Windows pôs.
  }
}

// ── modo, zerar, client, fechar ────────────────────────────

// O que medir é uma escolha do meter: o client mostra e muda a mesma.
function applyMode() {
  $("mode").textContent = (MODES.find(([id]) => id === config.mode) ?? MODES[0])[1];
}

$("mode").addEventListener("click", () => {
  const i = MODES.findIndex(([id]) => id === config.mode);
  saveConfig({ mode: MODES[(i + 1) % MODES.length][0] });
});
$("reset").addEventListener("click", () => invoke("reset"));

// Print do overlay inteiro: área de transferência e
// Imagens\Kerub. O botão fica verde (deu) ou vermelho (não deu) por 2 s.
const PRINT_TITLE = $("print").title;
$("print").addEventListener("click", async () => {
  const button = $("print");
  let shot = null;
  try {
    shot = await invoke("screenshot", {
      x: 0,
      y: 0,
      width: window.innerWidth,
      height: window.innerHeight,
      scale: window.devicePixelRatio || 1,
      name: `Kerub - overlay - ${stamp(Date.now())}`,
    });
  } catch {
    shot = null;
  }
  const ok = !!(shot?.clipboard || shot?.file);
  button.classList.add(ok ? "done" : "failed");
  button.title = ok ? "Print copiado (Ctrl + V) e salvo em Imagens\\Kerub" : "Não deu para tirar o print";
  setTimeout(() => {
    button.classList.remove("done", "failed");
    button.title = PRINT_TITLE;
  }, 2000);
});
$("client").addEventListener("click", () => invoke("show_client"));
// Fechar o overlay desliga ele; o client liga de novo.
$("close").addEventListener("click", () => saveConfig({ overlay: false }));

// ── instalar o Npcap ───────────────────────────────────────
// O meter baixa o instalador oficial do npcap.com e abre. Quando ele termina,
// a captura começa sozinha e o aviso some.

const INSTALLING = "Baixando o instalador do Npcap… Depois, siga a janela dele até o fim.";
let npcapSetup = null;

$("install-npcap").addEventListener("click", async () => {
  npcapSetup = INSTALLING;
  $("status-text").textContent = INSTALLING;
  $("install-npcap").hidden = true;
  try {
    await invoke("install_npcap");
    npcapSetup = null;
  } catch (error) {
    npcapSetup = `${error} Também dá para instalar pelo npcap.com.`;
  }
});

// ── início ─────────────────────────────────────────────────

(async () => {
  document.documentElement.style.setProperty("--scale", scale);
  $("scale").title = `Tamanho do texto: ${Math.round(scale * 100)}% (Ctrl + roda do mouse)`;
  applyAlpha();
  applyLock();
  await loadConfig();
  applyMode();
  applyColumns();
  // Nesta versão as colunas são escolhidas no client: a janela começa do
  // tamanho que cabe as escolhidas.
  if (loadPref("layout") !== "client") {
    savePref("layout", "client");
    fitWidth();
  }
  onConfig(() => {
    applyMode();
    const before = meterEl.style.getPropertyValue("--cols");
    applyColumns();
    if (meterEl.style.getPropertyValue("--cols") !== before) fitWidth();
    rowEls.clear();
    rowsEl.replaceChildren();
    if (lastSnapshot) render(lastSnapshot);
  });
  listen("meter", (event) => render(event.payload));
  await restorePosition();
  // Espera o tamanho certo antes de aparecer.
  requestAnimationFrame(() => requestAnimationFrame(() => invoke("overlay_ready")));
})();
