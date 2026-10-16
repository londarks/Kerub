// Usado pelo client e pelo overlay: classes, cores, números e as escolhas.

const { listen } = window.__TAURI__.event;
const { invoke } = window.__TAURI__.core;

// Erros de uma tela vão para o log do meter.
window.addEventListener("error", (e) => invoke("ui_error", { message: `${e.message} (${e.filename}:${e.lineno})` }).catch(() => {}));
window.addEventListener("unhandledrejection", (e) => invoke("ui_error", { message: `${e.reason?.stack ?? e.reason}` }).catch(() => {}));

// Nome oficial em português (site do AION 2) e cor padrão da barra de cada
// classe, no tom do ícone do jogo. Escuras o
// bastante para o texto branco passar de 4,5:1 (WCAG AA) em todas; o Clérigo,
// dourado no jogo, fica marrom: nada de amarelo atrás de texto.
const CLASSES = {
  gladiator: { name: "Gladiador", color: "#0e7490" },
  templar: { name: "Templário", color: "#1d4ed8" },
  assassin: { name: "Assassino", color: "#4d7c0f" },
  ranger: { name: "Arqueiro", color: "#047857" },
  sorcerer: { name: "Mago", color: "#6d28d9" },
  elementalist: { name: "Espiritualista", color: "#a21caf" },
  cleric: { name: "Clérigo", color: "#854d0e" },
  chanter: { name: "Encantador", color: "#c2410c" },
  fighter: { name: "Lutador", color: "#be123c" },
};
const UNKNOWN_CLASS = { name: "Classe desconhecida", color: "#3f3f46" };

// O que medir.
const MODES = [
  ["bossTargets", "Chefe"],
  ["allTargets", "Todos"],
  ["trainTargets", "Boneco"],
];

let config = {
  overlay: true,
  columns: ["dps", "share", "damage", "crit"],
  colors: {},
  timeLeft: true,
  maxRows: 10,
  mode: "bossTargets",
};

const classInfo = (key) => CLASSES[key] ?? UNKNOWN_CLASS;
const classColor = (key) => config.colors[key] ?? classInfo(key).color;

// ── cores ──────────────────────────────────────────────────

function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function hex([r, g, b]) {
  return "#" + [r, g, b].map((c) => Math.round(c).toString(16).padStart(2, "0")).join("");
}

// Contraste WCAG entre duas cores (1 a 21).
function contrast(a, b) {
  const lum = (color) => {
    const [r, g, b] = rgb(color).map((c) => {
      c /= 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// A cor da classe clareada: linha do gráfico e contorno do ícone, que ficam
// sobre fundo escuro.
function lighten(color, amount = 0.45) {
  return hex(rgb(color).map((c) => c + (255 - c) * amount));
}

// Ícone colorido da classe num quadradinho escuro com contorno da cor dela:
// sobre a barra da mesma cor, o ícone sozinho sumia.
function classBadge(key, small = false) {
  const badge = document.createElement("span");
  badge.className = small ? "badge small" : "badge";
  const color = classColor(key);
  badge.style.setProperty("--ring", lighten(color, 0.3));
  badge.title = classInfo(key).name;
  if (CLASSES[key]) {
    const img = document.createElement("img");
    img.src = `classes/${key}.png`;
    img.alt = classInfo(key).name;
    badge.append(img);
  } else {
    badge.textContent = "?";
  }
  return badge;
}

// ── números ────────────────────────────────────────────────

function compact(n, digits = 1) {
  const abs = Math.abs(n);
  let text;
  if (abs >= 1e9) text = (n / 1e9).toFixed(digits) + "B";
  else if (abs >= 1e6) text = (n / 1e6).toFixed(digits) + "M";
  else if (abs >= 1e3) text = (n / 1e3).toFixed(digits) + "K";
  else text = Math.round(n).toString();
  return text.replace(".", ",");
}

const percent = (n, digits = 1) => `${n.toFixed(digits).replace(".", ",")}%`;

// Zero vira traço: quem só curou não tem DPS, e quase ninguém cura.
const dash = (n, format = compact) => (n > 0 ? format(n) : "–");

function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

const DATE = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
const TIME = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" });
const date = (ms) => DATE.format(new Date(ms));
const time = (ms) => TIME.format(new Date(ms));

// "2026-10-15 20h31m05s": a hora no nome do arquivo de um print.
function stamp(ms) {
  const d = new Date(ms);
  const two = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}h${two(d.getMinutes())}m${two(d.getSeconds())}s`;
}

// ── escolhas ───────────────────────────────────────────────
// Ficam no banco do meter; uma mudança no client chega no overlay na hora.

async function loadConfig() {
  try {
    config = await invoke("get_config");
  } catch {
    // Sem resposta: fica o padrão.
  }
  return config;
}

async function saveConfig(changes) {
  config = await invoke("set_config", { config: { ...config, ...changes } });
  return config;
}

function onConfig(callback) {
  listen("config", (event) => {
    config = event.payload;
    callback(config);
  });
}

// ── preferências deste PC (tamanho, posição) ────────────────

function loadPref(key) {
  try {
    return localStorage.getItem(`kerub.${key}`);
  } catch {
    return null;
  }
}

function savePref(key, value) {
  try {
    localStorage.setItem(`kerub.${key}`, value);
  } catch {
    // Sem armazenamento: volta ao padrão na próxima abertura.
  }
}

// ── elementos ──────────────────────────────────────────────
// Nomes de jogadores e chefes vêm do jogo: sempre como texto, nunca como HTML.

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "style") node.style.cssText = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  node.append(...children.flat().filter((c) => c != null && c !== false));
  return node;
}

// Ícone de skill do site oficial; sem ícone (ataque básico) ou sem internet,
// um símbolo no lugar.
function skillIcon(url) {
  if (!url) return el("span", { class: "skill-icon none", "aria-hidden": "true", text: "⚔" });
  const img = el("img", { class: "skill-icon", src: url, alt: "", loading: "lazy" });
  img.addEventListener("error", () => img.replaceWith(el("span", { class: "skill-icon none", "aria-hidden": "true", text: "✦" })));
  return img;
}

// Carregando: um anel girando, sem texto na tela (o texto fica para leitores
// de tela).
function spinner(label = "Carregando", small = false) {
  return el("div", { class: small ? "spinner small" : "spinner", role: "status", "aria-label": label }, el("span", { class: "spin", "aria-hidden": "true" }));
}

// Blocos cinza no lugar do conteúdo que ainda vai chegar.
function skeleton(...classes) {
  return el("div", { class: "skeletons", "aria-hidden": "true" }, ...classes.map((c) => el("span", { class: `skeleton ${c}` })));
}
