// Linha do tempo de uma luta: o dano por segundo de cada
// jogador com o HP do chefe e o ping, os buffs e debuffs de quem você escolher
// e as skills que ele usou, todos no mesmo eixo de tempo. Passar o mouse marca
// o momento em todas as partes de uma vez.

const SVG = "http://www.w3.org/2000/svg";

function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

// Um número redondo acima de `max`, para o topo do eixo.
function niceMax(max) {
  if (max <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    if (step * power >= max) return step * power;
  }
  return 10 * power;
}

// Passo do eixo de tempo, em segundos: no máximo uns 8 rótulos.
function timeStep(seconds) {
  for (const step of [5, 10, 15, 30, 60, 120, 300, 600]) {
    if (seconds / step <= 8) return step;
  }
  return 1200;
}

// Tempo da luta com décimos: 1:02,5 (antes do começo, negativo).
function clockTenths(ms) {
  const sign = ms < 0 ? "-" : "";
  const tenths = Math.floor(Math.abs(ms) / 100);
  const m = Math.floor(tenths / 600);
  const s = String(Math.floor((tenths % 600) / 10)).padStart(2, "0");
  return `${sign}${m}:${s},${tenths % 10}`;
}

const remPx = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 15;

// Coluna dos nomes e margem direita, em rem: o gráfico, os buffs e as skills
// alinham o tempo por elas.
const GUTTER_REM = 13;
const RIGHT_REM = 4.4;

// HP do chefe em vermelho tracejado, ping em branco pontilhado; o que o
// próprio alvo lançou, em vermelho claro.
const HP_COLOR = "#ff7a7a";
const PING_COLOR = "#e5e7eb";
const HOSTILE_COLOR = "#ff9b9b";
const OTHER_COLOR = "#b4bac4";

// Como cada pedaço de buff acabou (`end_code` em fight_buffs.rs do motor).
const BUFF_END = [
  "Acúmulos mudaram",
  "Expirou",
  "Tirado por uma skill",
  "Removido (motivo desconhecido)",
  "Lançado de novo por outra pessoa",
  "Alvo morreu ou saiu",
  "Troca de mapa",
  "Fim não visto",
  "Empurrado por um acúmulo mais novo",
  "Acabou o tempo (fim não visto)",
  "Ainda ativo no fim da luta",
  "Trocado por um nível novo",
];

// Escolhas da linha do tempo, guardadas neste PC.
const timelinePrefs = (() => {
  const prefs = { dps: true, buffs: true, casts: true, caster: "all", passives: false, sort: "uptime" };
  try {
    Object.assign(prefs, JSON.parse(loadPref("timeline") || "{}"));
  } catch {
    // Fica o padrão.
  }
  return prefs;
})();
const saveTimelinePrefs = () => savePref("timeline", JSON.stringify(timelinePrefs));

// Os desenhos (gráfico, skills) são refeitos quando a largura muda. A tela ao
// vivo é refeita a cada segundo: o que saiu da página deixa de ser observado.
const observed = new Set();
const resizer = new ResizeObserver((entries) => {
  for (const entry of entries) entry.target._draw?.();
});

function observe(node) {
  observed.add(node);
  resizer.observe(node);
}

// Chamado antes de montar uma linha do tempo nova: a anterior ainda está na
// tela, as de antes dela já saíram.
function forgetDetached() {
  for (const old of observed) {
    if (!old.isConnected) {
      resizer.unobserve(old);
      observed.delete(old);
    }
  }
}

// Ícone com reservas: tenta cada endereço; sem nenhum, um símbolo.
function iconFrom(urls, cls) {
  const list = (urls ?? []).filter(Boolean);
  const none = () => el("span", { class: `${cls} none`, "aria-hidden": "true", text: "✦" });
  if (list.length === 0) return none();
  let i = 0;
  const img = el("img", { class: cls, src: list[0], alt: "", loading: "lazy" });
  img.addEventListener("error", () => {
    i += 1;
    if (i < list.length) img.src = list[i];
    else img.replaceWith(none());
  });
  return img;
}

// Imagens dos ícones para desenhar no canvas, carregadas uma vez.
const canvasIcons = new Map();

function canvasIcon(url, onReady) {
  if (!url) return null;
  let entry = canvasIcons.get(url);
  if (!entry) {
    entry = { img: new Image(), ready: false, failed: false, waiting: new Set() };
    entry.img.onload = () => {
      entry.ready = true;
      for (const redraw of entry.waiting) redraw();
      entry.waiting.clear();
    };
    entry.img.onerror = () => {
      entry.failed = true;
      entry.waiting.clear();
    };
    entry.img.src = url;
    canvasIcons.set(url, entry);
  }
  if (!entry.ready && !entry.failed) entry.waiting.add(onReady);
  return entry;
}

// Uma linha: tracejada, pontilhada ou cheia, na cor dela (para as legendas).
function lineSwatch(color, dash) {
  const box = svg("svg", { width: 26, height: 10, viewBox: "0 0 26 10", "aria-hidden": "true", class: "line-swatch" });
  box.append(svg("line", { x1: 1, y1: 5, x2: 25, y2: 5, stroke: color, "stroke-width": 3, "stroke-dasharray": dash ?? "", "stroke-linecap": "round" }));
  return box;
}

function note(text) {
  return el("p", { class: "ftl-note", text });
}

// A dica que segue o mouse (uma para a página toda).
let ftlTip = null;

function showTip(lines, event) {
  if (!ftlTip) {
    ftlTip = el("div", { class: "ftl-tip", role: "tooltip", hidden: true });
    document.body.append(ftlTip);
  }
  ftlTip.replaceChildren(...lines);
  ftlTip.hidden = false;
  moveTip(event);
}

function moveTip(event) {
  if (!ftlTip || ftlTip.hidden) return;
  const pad = 14;
  let x = event.clientX + pad;
  let y = event.clientY + pad;
  if (x + ftlTip.offsetWidth > window.innerWidth - 4) x = Math.max(4, event.clientX - ftlTip.offsetWidth - pad);
  if (y + ftlTip.offsetHeight > window.innerHeight - 4) y = Math.max(4, event.clientY - ftlTip.offsetHeight - pad);
  ftlTip.style.left = `${x}px`;
  ftlTip.style.top = `${y}px`;
}

function hideTip() {
  if (ftlTip) ftlTip.hidden = true;
}

// ── a linha do tempo ───────────────────────────────────────

// Fica embaixo das skills: `state.player` (o jogador
// escolhido na lista de cima) é de quem são os buffs e as skills; `rerender`
// refaz a luta.
function fightTimeline(view, state, rerender) {
  hideTip();
  forgetDetached();
  const durationMs = Math.max(view.durationMs, 1000);
  const players = view.players.filter((p) => p.damage > 0 || p.heal > 0);
  if (!players.some((p) => p.name === state.player)) state.player = (players.find((p) => p.me) ?? players[0])?.name ?? null;
  const player = players.find((p) => p.name === state.player) ?? null;

  const root = el("section", { class: "ftl", style: `--gutter: ${GUTTER_REM}rem; --right: ${RIGHT_REM}rem`, "aria-label": "Linha do tempo da luta" });
  const title = el(
    "div",
    { class: "ftl-title" },
    el("h3", { text: "Linha do tempo da luta" }),
    player ? el("span", { class: "muted", text: `Buffs e skills de ${player.name}. Troque o jogador na lista de cima.` }) : null,
  );
  const sections = el(
    "div",
    { class: "ftl-sections", role: "group", "aria-label": "Partes da linha do tempo" },
    ...[
      ["dps", "Gráfico"],
      ["buffs", "Buffs"],
      ["casts", "Skills"],
    ].map(([key, label]) =>
      el("button", {
        class: "toggle",
        "aria-pressed": String(timelinePrefs[key]),
        text: label,
        onclick: () => {
          timelinePrefs[key] = !timelinePrefs[key];
          saveTimelinePrefs();
          rerender();
        },
      }),
    ),
  );
  root.append(el("div", { class: "ftl-top" }, title, sections));

  const body = el("div", { class: "ftl-body" });
  if (timelinePrefs.dps) body.append(dpsSection(view, state, durationMs));
  if (timelinePrefs.buffs) body.append(buffSection(view, player, durationMs, rerender));
  if (timelinePrefs.casts) body.append(castSection(player, durationMs));
  if (!timelinePrefs.dps && !timelinePrefs.buffs && !timelinePrefs.casts) {
    body.append(note("Ligue o gráfico, os buffs ou as skills nos botões acima."));
    root.append(body);
    return root;
  }
  body.append(axisRow(durationMs));

  // O momento sob o mouse, numa linha que passa por todas as partes.
  const timeTag = el("span", { class: "ftl-cursor-time" });
  const cursor = el("div", { class: "ftl-cursor", hidden: true, "aria-hidden": "true" }, timeTag);
  body.append(cursor);
  body.addEventListener("mousemove", (e) => {
    const rect = body.getBoundingClientRect();
    const rem = remPx();
    const left = GUTTER_REM * rem;
    const right = rect.width - RIGHT_REM * rem;
    const x = e.clientX - rect.left;
    if (x < left || x > right) {
      cursor.hidden = true;
      return;
    }
    cursor.hidden = false;
    cursor.style.left = `${x}px`;
    timeTag.textContent = clock(((x - left) / (right - left)) * durationMs);
  });
  body.addEventListener("mouseleave", () => {
    cursor.hidden = true;
    hideTip();
  });
  root.append(body);
  return root;
}

function section(title, ...extra) {
  return el("section", { class: "ftl-section" }, el("div", { class: "ftl-head" }, el("h4", { text: title }), ...extra));
}

// ── dano por segundo, HP e ping ────────────────────────────

function dpsSection(view, state, durationMs) {
  const box = section("Dano por segundo");
  if (view.timeline.party.length < 2) {
    box.append(note("A luta ainda é curta demais para o gráfico."));
    return box;
  }
  const hidden = state.hiddenLines;
  const series = [
    ...view.timeline.players.map((p) => ({ key: p.name, name: p.name, color: lighten(classColor(p.job), 0.4), values: p.values })),
    { key: "party", name: "Grupo", color: "#ffffff", values: view.timeline.party },
  ];
  const hp = view.timeline.hp ?? [];
  const ping = view.ping ?? [];
  const extras = [];
  if (hp.length > 1) extras.push({ key: "hp", name: "HP do chefe", color: HP_COLOR, dash: "6 5" });
  if (ping.length > 0) extras.push({ key: "ping", name: "Ping", color: PING_COLOR, dash: "2 5" });

  const plot = el("div", { class: "ftl-plot" });
  const legend = el("div", { class: "chart-legend", role: "group", "aria-label": "Linhas do gráfico" });
  for (const s of [...series, ...extras]) {
    const dash = s.dash ?? (s.key === state.player || s.key === "party" ? "" : "7 4");
    const button = el("button", { class: "legend-item", "aria-pressed": String(!hidden.has(s.key)) }, lineSwatch(s.color, dash), s.name);
    button.addEventListener("click", () => {
      if (hidden.has(s.key)) hidden.delete(s.key);
      else hidden.add(s.key);
      button.setAttribute("aria-pressed", String(!hidden.has(s.key)));
      draw();
    });
    legend.append(button);
  }
  box.append(plot, legend);

  function draw() {
    if (!plot.isConnected) return;
    const rem = remPx();
    const width = plot.clientWidth || 900;
    const height = Math.round(rem * 16);
    const left = GUTTER_REM * rem;
    const right = width - RIGHT_REM * rem;
    const top = rem * 0.8;
    const bottom = height - rem * 0.5;
    const plotW = Math.max(10, right - left);
    const plotH = bottom - top;
    const length = view.timeline.party.length;
    const visible = series.filter((s) => !hidden.has(s.key));
    const showHp = hp.length > 1 && !hidden.has("hp");
    const showPing = ping.length > 0 && !hidden.has("ping");
    const maxDps = niceMax(Math.max(0, ...visible.flatMap((s) => s.values)));
    const maxPing = niceMax(Math.max(1, ...ping.map((p) => p.ms)));
    const xAt = (ms) => left + (Math.min(Math.max(ms, 0), durationMs) / durationMs) * plotW;
    const xOf = (i) => left + (length > 1 ? (i / (length - 1)) * plotW : 0);
    const yDps = (v) => bottom - (v / maxDps) * plotH;

    const root = svg("svg", { width, height, viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": "Dano por segundo ao longo da luta" });
    for (let i = 0; i <= 4; i++) {
      const y = top + (plotH / 4) * i;
      root.append(svg("line", { x1: left, x2: right, y1: y, y2: y, class: "grid" }));
      const label = svg("text", { x: left - rem * 0.6, y: y + rem * 0.35, "text-anchor": "end", class: "axis" });
      label.textContent = compact(maxDps * (1 - i / 4));
      root.append(label);
      if (showPing) {
        const pingLabel = svg("text", { x: right + rem * 0.5, y: y + rem * 0.35, "text-anchor": "start", class: "axis" });
        pingLabel.textContent = `${Math.round(maxPing * (1 - i / 4))} ms`;
        root.append(pingLabel);
      }
    }
    const step = timeStep(durationMs / 1000);
    for (let s = step; s < durationMs / 1000; s += step) {
      root.append(svg("line", { x1: xAt(s * 1000), x2: xAt(s * 1000), y1: top, y2: bottom, class: "grid" }));
    }

    if (showHp) {
      // Cheio no começo; cada valor é o HP no fim daquele segundo.
      const points = [[0, 100], ...hp.map((v, i) => [((i + 1) / hp.length) * durationMs, v])];
      const d = points.map(([t, v], i) => `${i ? "L" : "M"}${xAt(t).toFixed(1)},${(bottom - (v / 100) * plotH).toFixed(1)}`).join("");
      root.append(svg("path", { d, fill: "none", stroke: HP_COLOR, "stroke-width": 2.2, "stroke-dasharray": "6 5" }));
    }

    // Os outros embaixo, o grupo, e o escolhido por cima de todos.
    const order = [...visible.filter((s) => s.key !== state.player && s.key !== "party"), ...visible.filter((s) => s.key === "party"), ...visible.filter((s) => s.key === state.player)];
    for (const s of order) {
      if (s.values.length === 0) continue;
      const d = s.values.map((v, i) => `${i ? "L" : "M"}${xOf(i).toFixed(1)},${yDps(v).toFixed(1)}`).join("");
      const chosen = s.key === state.player;
      const party = s.key === "party";
      root.append(
        svg("path", {
          d,
          fill: "none",
          stroke: s.color,
          "stroke-width": chosen ? 3 : party ? 2.5 : 1.8,
          "stroke-dasharray": chosen || party ? "" : "7 4",
          "stroke-linejoin": "round",
          opacity: chosen || party ? 1 : 0.85,
        }),
      );
    }

    if (showPing) {
      const pts = ping.map((p) => [xAt(p.t), bottom - (p.ms / maxPing) * plotH]);
      let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
      if (pts.length === 1) d += `L${(pts[0][0] + 1).toFixed(1)},${pts[0][1].toFixed(1)}`;
      // Curva suave pelos pontos (Catmull-Rom).
      for (let i = 0; i < pts.length - 1; i++) {
        const [p0, p1, p2, p3] = [pts[Math.max(0, i - 1)], pts[i], pts[i + 1], pts[Math.min(pts.length - 1, i + 2)]];
        const c1 = [p1[0] + (p2[0] - p0[0]) / 4, p1[1] + (p2[1] - p0[1]) / 4];
        const c2 = [p2[0] - (p3[0] - p1[0]) / 4, p2[1] - (p3[1] - p1[1]) / 4];
        d += `C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
      }
      root.append(svg("path", { d, fill: "none", stroke: PING_COLOR, "stroke-width": 2, "stroke-dasharray": "2 5", "stroke-linecap": "round" }));
    }
    plot.replaceChildren(root);

    plot.onmousemove = (e) => {
      const rect = plot.getBoundingClientRect();
      const x = e.clientX - rect.left;
      if (x < left || x > right) {
        hideTip();
        return;
      }
      const ms = ((x - left) / plotW) * durationMs;
      const i = Math.round((ms / durationMs) * (length - 1));
      const lines = [el("div", { class: "tip-time", text: clock(ms) })];
      if (showHp) {
        const at = Math.min(hp.length - 1, Math.max(0, Math.floor((ms / durationMs) * hp.length)));
        lines.push(el("div", { class: "tip-row", style: `--series: ${HP_COLOR}` }, el("span", { class: "swatch" }), el("span", { text: "HP do chefe" }), el("b", { text: percent(hp[at]) })));
      }
      if (showPing) {
        const near = ping.reduce((best, p) => (Math.abs(p.t - ms) < Math.abs(best.t - ms) ? p : best), ping[0]);
        lines.push(el("div", { class: "tip-row", style: `--series: ${PING_COLOR}` }, el("span", { class: "swatch" }), el("span", { text: "Ping" }), el("b", { text: `${near.ms} ms` })));
      }
      const rows = visible
        .map((s) => ({ s, v: s.values[i] ?? 0 }))
        .sort((a, b) => b.v - a.v)
        .slice(0, 10)
        .map(({ s, v }) => el("div", { class: "tip-row", style: `--series: ${s.color}` }, el("span", { class: "swatch" }), el("span", { text: s.name }), el("b", { text: compact(v) })));
      showTip([...lines, ...rows], e);
    };
    plot.onmouseleave = hideTip;
  }

  plot._draw = draw;
  observe(plot);
  return box;
}

// ── buffs e debuffs ────────────────────────────────────────

// Os pedaços de acúmulos juntados nas vezes que o buff ficou ativo: um pedaço
// que acabou por mudar de acúmulos (0) continua no próximo.
function buffApplications(segs) {
  const apps = [];
  const of = [];
  let current = null;
  for (const [start, end, stacks, how] of segs) {
    if (current && current.how === 0 && current.end === start) {
      current.end = end;
      current.how = how;
      current.stacks = Math.max(current.stacks, stacks);
    } else {
      current = { start, end, how, stacks };
      apps.push(current);
    }
    of.push(current);
  }
  return of;
}

// Junta os pedaços de vários registros num só: ativo onde qualquer um está.
function unionSegs(lists) {
  const pieces = lists.flat().filter((s) => s[1] > s[0]);
  const cuts = [...new Set(pieces.flatMap((s) => [s[0], s[1]]))].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const [a, b] = [cuts[i], cuts[i + 1]];
    const on = pieces.filter((s) => s[0] <= a && s[1] >= b);
    if (on.length === 0) continue;
    const stacks = Math.max(...on.map((s) => s[2]));
    const goesOn = on.some((s) => s[1] > b);
    const how = goesOn ? 0 : on.filter((s) => s[1] === b).at(-1)[3];
    const last = out.at(-1);
    if (last && last[1] === a && last[3] === 0 && last[2] === stacks) {
      last[1] = b;
      last[3] = how;
    } else {
      out.push([a, b, stacks, how]);
    }
  }
  return out;
}

// O jogo aplica alguns efeitos com mais de um código: o mesmo nome, de quem
// lançou e em quem, vira uma linha só.
function mergeBuffs(list, durationMs) {
  const groups = new Map();
  for (const b of list) {
    const key = [b.name, b.by, b.byTarget, b.on, b.onTarget, b.summon].join("|");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b);
  }
  return [...groups.values()].map((group) => {
    if (group.length === 1) return group[0];
    const lead = group.reduce((a, b) => (b.up > a.up ? b : a));
    const segs = unionSegs(group.map((b) => b.segs));
    const up = segs.reduce((sum, [start, end]) => sum + Math.max(0, Math.min(durationMs, end) - Math.max(0, start)), 0);
    return { ...lead, segs, up };
  });
}

const firstStart = (b) => b.segs[0]?.[0] ?? Infinity;

function sortBuffs(list) {
  return timelinePrefs.sort === "first"
    ? list.sort((a, b) => firstStart(a) - firstStart(b) || b.up - a.up || a.id - b.id)
    : list.sort((a, b) => b.up - a.up || firstStart(a) - firstStart(b) || a.id - b.id);
}

// A cor de quem lançou: a da classe, o vermelho do alvo, ou cinza.
function buffColor(b) {
  if (b.byTarget) return HOSTILE_COLOR;
  if (b.byJob) return lighten(classColor(b.byJob), 0.4);
  return OTHER_COLOR;
}

function uptime(up, durationMs) {
  const pct = Math.min(100, (Math.max(0, up) / durationMs) * 100);
  if (up > 0 && pct < 1) return "<1%";
  return `${Math.round(pct)}%`;
}

function buffTip(b, seg, app, event, view) {
  const caster = b.byTarget ? view.boss || "o alvo" : b.by || "desconhecido";
  const job = b.byJob ? ` (${classInfo(b.byJob).name})` : "";
  const lines = [
    el("div", { class: "tip-time", text: b.name }),
    el("div", { text: `Lançado por ${caster}${job}` }),
    el("div", { text: `${clockTenths(app.start)} – ${clockTenths(app.end)} (${((app.end - app.start) / 1000).toFixed(1).replace(".", ",")} s)` }),
  ];
  if (app.start < 0) lines.push(el("div", { class: "muted", text: "Já estava ativo antes da luta" }));
  if (seg[2] > 1 || app.stacks > 1) lines.push(el("div", { text: `Acúmulos: ${seg[2]}` }));
  lines.push(el("div", { class: "muted", text: `Fim: ${BUFF_END[app.how] ?? BUFF_END[3]}` }));
  showTip(lines, event);
}

function buffRow(b, durationMs, view) {
  const color = buffColor(b);
  const label = el(
    "div",
    { class: "ftl-label", title: b.name },
    iconFrom(b.icons, "ftl-icon"),
    el("span", { class: "ftl-name", text: b.name, style: `color: ${color}` }),
    b.summon ? el("span", { class: "tag", text: "INVOCAÇÃO" }) : null,
  );
  const lane = el("div", { class: "ftl-lane" });
  const maxStacks = Math.max(1, ...b.segs.map((s) => s[2]));
  const apps = buffApplications(b.segs);
  b.segs.forEach((seg, i) => {
    const from = Math.max(0, seg[0]);
    const to = Math.min(durationMs, seg[1]);
    if (to <= from) return;
    const width = ((to - from) / durationMs) * 100;
    const opacity = maxStacks > 1 ? 0.45 + 0.55 * (seg[2] / maxStacks) : 0.9;
    const bar = el(
      "div",
      { class: "ftl-buff", style: `left: ${(from / durationMs) * 100}%; width: ${width}%; background: ${color}; opacity: ${opacity.toFixed(2)}` },
      seg[2] > 1 && width >= 2.5 ? el("span", { text: String(seg[2]) }) : null,
    );
    bar.addEventListener("mouseenter", (e) => buffTip(b, seg, apps[i], e, view));
    bar.addEventListener("mousemove", moveTip);
    bar.addEventListener("mouseleave", hideTip);
    lane.append(bar);
  });
  return el("div", { class: "ftl-row" }, label, lane, el("div", { class: "ftl-right", text: uptime(b.up, durationMs) }));
}

function buffGroup(title, list, durationMs, view) {
  const group = el("div", { class: "ftl-group" }, el("div", { class: "ftl-group-head" }, el("span", { text: title }), el("span", { class: "count", text: String(list.length) })));
  if (list.length === 0) group.append(note("Nenhum com estes filtros."));
  for (const b of list) group.append(buffRow(b, durationMs, view));
  return group;
}

function segmentedPick(label, options, value, onPick) {
  return el(
    "div",
    { class: "ftl-pick" },
    el("span", { class: "muted", text: label }),
    el(
      "div",
      { class: "segmented small", role: "radiogroup", "aria-label": label },
      ...options.map(([id, text]) => el("button", { class: "segment", role: "radio", "aria-checked": String(value === id), text, onclick: () => onPick(id) })),
    ),
  );
}

function buffSection(view, player, durationMs, rerender) {
  const set = (key) => (value) => {
    timelinePrefs[key] = value;
    saveTimelinePrefs();
    rerender();
  };
  const tools = el(
    "div",
    { class: "ftl-tools" },
    segmentedPick(
      "Lançado por",
      [
        ["all", "Todos"],
        ["party", "Grupo"],
        ["self", "Próprio"],
      ],
      timelinePrefs.caster,
      set("caster"),
    ),
    segmentedPick(
      "Ordenar",
      [
        ["uptime", "Tempo ativo"],
        ["first", "Primeiro"],
      ],
      timelinePrefs.sort,
      set("sort"),
    ),
    el("button", { class: "toggle", "aria-pressed": String(timelinePrefs.passives), text: "Passivas", onclick: () => set("passives")(!timelinePrefs.passives) }),
  );
  const box = section("Buffs e debuffs", tools);
  if (!view.buffs) {
    box.append(note(view.id ? "Esta luta foi gravada antes de o Kerub guardar os buffs." : "Ainda sem buffs nesta luta."));
    return box;
  }
  if (view.buffs.length === 0) {
    box.append(note("Nenhum buff ou debuff nesta luta."));
    return box;
  }
  if (!player) {
    box.append(note("Escolha um jogador acima para ver os buffs dele."));
    return box;
  }
  const party = new Set(view.players.map((p) => p.name));
  const keep = (b) => (timelinePrefs.caster === "party" ? party.has(b.by) : timelinePrefs.caster === "self" ? b.by === player.name : true);
  const onPlayer = view.buffs.filter((b) => !b.onTarget && b.on === player.name && keep(b));
  const timed = sortBuffs(mergeBuffs(onPlayer.filter((b) => !b.passive), durationMs));
  const onTarget = sortBuffs(mergeBuffs(view.buffs.filter((b) => b.onTarget && !b.passive && keep(b)), durationMs));
  const mine = buffGroup(`Em ${player.name}`, timed, durationMs, view);
  const passives = onPlayer.filter((b) => b.passive);
  if (timelinePrefs.passives && passives.length) {
    mine.append(el("p", { class: "ftl-passives" }, el("b", { text: "Passivas: " }), [...new Set(passives.map((b) => b.name))].join(", ")));
  }
  box.append(mine, buffGroup("Debuffs no alvo", onTarget, durationMs, view));
  return box;
}

// ── skills usadas ──────────────────────────────────────────

function drawCasts(canvas, lane, skill, durationMs, color) {
  if (!lane.isConnected) return;
  const w = lane.clientWidth;
  const h = lane.clientHeight;
  if (!w || !h) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.ceil(w * dpr);
  canvas.height = Math.ceil(h * dpr);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  const size = Math.max(12, h - 6);
  const icon = canvasIcon(skill.icon, () => drawCasts(canvas, lane, skill, durationMs, color));
  for (const t of skill.times) {
    const x = (Math.min(Math.max(t, 0), durationMs) / durationMs) * w;
    if (icon?.ready) {
      ctx.drawImage(icon.img, x - size / 2, (h - size) / 2, size, size);
    } else {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, h / 2, size / 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function castSection(player, durationMs) {
  const box = section(player ? `Skills de ${player.name}` : "Skills usadas");
  const skills = player ? (player.skills.length ? player.skills : player.heals).filter((s) => s.times?.length) : [];
  if (skills.length === 0) {
    box.append(note(player ? "Sem horários de skill nesta luta." : "Escolha um jogador acima."));
    return box;
  }
  const color = lighten(classColor(player.job), 0.4);
  for (const skill of skills.slice(0, 15)) {
    const canvas = el("canvas", { "aria-hidden": "true" });
    const lane = el("div", { class: "ftl-lane casts" }, canvas);
    const label = el("div", { class: "ftl-label", title: skill.name }, skillIcon(skill.icon), el("span", { class: "ftl-name", text: skill.name }));
    box.append(el("div", { class: "ftl-row" }, label, lane, el("div", { class: "ftl-right", text: `×${skill.times.length}` })));
    lane._draw = () => drawCasts(canvas, lane, skill, durationMs, color);
    observe(lane);
  }
  if (skills.length > 15) box.append(note(`Mais ${skills.length - 15} skills com menos dano ficaram de fora.`));
  return box;
}

// ── eixo do tempo ──────────────────────────────────────────

function axisRow(durationMs) {
  const seconds = durationMs / 1000;
  const step = timeStep(seconds);
  const ticks = [];
  for (let s = 0; s < seconds - step * 0.4; s += step) ticks.push(s);
  ticks.push(seconds);
  const lane = el(
    "div",
    { class: "ftl-axis-lane" },
    ...ticks.map((s, i) => el("span", { class: i === ticks.length - 1 ? "end" : "", style: `left: ${(s / seconds) * 100}%`, text: clock(s * 1000) })),
  );
  return el("div", { class: "ftl-row ftl-axis" }, el("div"), lane, el("div"));
}
