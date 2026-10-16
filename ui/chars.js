// Personagens do AION 2 pelo site oficial: busca (pela barra de cima) e a
// página de cada um. As chamadas ao site são do Rust (armory.rs); a página
// guardada no banco abre na hora e é atualizada sozinha depois de 10 minutos.

const STALE_MS = 10 * 60 * 1000;
// Imagens da página de personagem do site oficial (aion2.plaync.com).
const SITE_IMG = "https://assets.playnccdn.com/static-aion2/characters/img";
const REGIONS = [
  ["", "Todas as regiões", "Todas"],
  ["la", "América do Sul", "SA"],
  ["nae", "América do Norte Leste", "NA Leste"],
  ["naw", "América do Norte Oeste", "NA Oeste"],
  ["eu", "Europa", "EU"],
  ["as", "Ásia", "Ásia"],
];
const REGION_LABEL = { nae: "NA Leste", naw: "NA Oeste", eu: "EU", la: "SA", as: "Ásia" };
const RACE = { 1: ["Elyos", "elyos"], 2: ["Asmodiano", "asmodian"] };
// A raridade de itens, títulos e nós Daevanion vira a cor do nome.
const GRADES = ["common", "rare", "legend", "unique", "special", "epic", "mythic"];
const gradeKey = (grade) => (GRADES.includes(String(grade).toLowerCase()) ? String(grade).toLowerCase() : "common");
const gradeClass = (grade) => `g-${gradeKey(grade)}`;
const number = (n) => Number(n || 0).toLocaleString("pt-BR");

function serverLabel(hit) {
  return `${hit.server} (${REGION_LABEL[hit.region] ?? hit.region.toUpperCase()})`;
}

function raceTag(race) {
  const [label, cls] = RACE[race] ?? ["?", "unknown"];
  return el("span", { class: `race ${cls}`, text: label });
}

function ago(ms) {
  const minutes = Math.round((Date.now() - ms) / 60000);
  if (minutes < 1) return "agora";
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `há ${hours} h`;
  return `em ${date(ms)}`;
}

function svgIcon(paths) {
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = paths;
  return icon;
}

// ── região da busca (menu nosso, no lugar do select do Windows) ──

let region = REGIONS.some(([id]) => id === loadPref("chars.region")) ? loadPref("chars.region") : "";
const regionMenu = $("region-menu");

function paintRegion() {
  const entry = REGIONS.find(([id]) => id === region) ?? REGIONS[0];
  $("region-label").textContent = entry[2];
  $("region-btn").title = `Região da busca: ${entry[1]}`;
}

function closeRegionMenu() {
  regionMenu.hidden = true;
  $("region-btn").setAttribute("aria-expanded", "false");
}

function openRegionMenu() {
  regionMenu.replaceChildren(
    ...REGIONS.map(([id, label]) =>
      el(
        "button",
        {
          type: "button",
          class: "menu-item",
          role: "option",
          "aria-selected": String(id === region),
          onclick: () => {
            region = id;
            savePref("chars.region", region);
            paintRegion();
            closeRegionMenu();
            $("search").focus();
            if (page === "chars" && lastQuery) search(lastQuery);
          },
        },
        el("span", { text: label }),
        id === region ? el("span", { class: "menu-check", "aria-hidden": "true", text: "✓" }) : null,
      ),
    ),
  );
  const rect = $("region-btn").getBoundingClientRect();
  regionMenu.hidden = false;
  regionMenu.style.top = `${rect.bottom + 6}px`;
  regionMenu.style.left = `${Math.max(8, rect.right - regionMenu.offsetWidth)}px`;
  $("region-btn").setAttribute("aria-expanded", "true");
  regionMenu.querySelector('[aria-selected="true"]')?.focus();
}

$("region-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  if (regionMenu.hidden) openRegionMenu();
  else closeRegionMenu();
});
regionMenu.addEventListener("keydown", (e) => {
  const items = [...regionMenu.querySelectorAll(".menu-item")];
  const at = items.indexOf(document.activeElement);
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
  } else if (e.key === "Escape") {
    closeRegionMenu();
    $("region-btn").focus();
  }
});
document.addEventListener("click", (e) => {
  if (!regionMenu.hidden && !regionMenu.contains(e.target)) closeRegionMenu();
});
paintRegion();

// ── busca ──────────────────────────────────────────────────

let searchSeq = 0;
let lastQuery = "";
let lastHits = [];
const favorites = new Set();

$("search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("search").value.trim();
  if (q) go({ page: "chars", q });
});

// A página de personagens: resultados de uma busca, ou favoritos e vistos.
function openCharacters(entry) {
  show("chars");
  if (entry.q) {
    $("search").value = entry.q;
    search(entry.q);
    return;
  }
  lastQuery = "";
  lastHits = [];
  $("chars-title").textContent = "Personagens";
  $("char-status").textContent = "Procure pelo nome na barra de cima.";
  $("char-results").replaceChildren();
  refreshSavedCharacters();
}

function searching(on) {
  $("search-icon").replaceChildren(on ? el("span", { class: "spin" }) : svgIcon('<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>'));
  $("search-form").classList.toggle("busy", on);
}

async function search(keyword) {
  const seq = ++searchSeq;
  lastQuery = keyword;
  const where = region ? REGIONS.find(([id]) => id === region)[1] : "todas as regiões";
  $("chars-title").textContent = `Resultados para “${keyword}”`;
  $("char-status").textContent = `Procurando em ${where}`;
  $("char-saved").hidden = true;
  $("char-results").replaceChildren(el("div", { class: "clist", "aria-busy": "true" }, ...[0, 1, 2].map(() => skeleton("sk-badge", "sk-line", "sk-pill"))));
  searching(true);
  let hits;
  try {
    hits = await invoke("armory_search", { keyword, region });
  } catch (error) {
    if (seq !== searchSeq) return;
    $("char-status").textContent = String(error);
    $("char-results").replaceChildren();
    return;
  } finally {
    if (seq === searchSeq) searching(false);
  }
  if (seq !== searchSeq) return;
  lastHits = hits;
  $("char-status").textContent =
    hits.length === 0
      ? `Ninguém com esse nome em ${where}. A região muda no menu da busca.`
      : `${hits.length} ${hits.length === 1 ? "personagem" : "personagens"} em ${where}`;
  $("char-results").replaceChildren(hits.length ? characterList(hits) : "");
}

function starButton(hit, withLabel = false) {
  const button = el("button", { class: withLabel ? "button fav" : "star", type: "button" });
  const paint = () => {
    const on = favorites.has(hit.id);
    button.replaceChildren(el("span", { class: "star-glyph", "aria-hidden": "true", text: on ? "★" : "☆" }), withLabel ? (on ? "Favorito" : "Favoritar") : "");
    button.classList.toggle("on", on);
    button.setAttribute("aria-pressed", String(on));
    button.title = on ? "Tirar dos favoritos" : "Favoritar";
    button.setAttribute("aria-label", `${on ? "Tirar dos favoritos" : "Favoritar"}: ${hit.name}`);
  };
  button.addEventListener("click", async (e) => {
    e.stopPropagation();
    const on = !favorites.has(hit.id);
    if (on) favorites.add(hit.id);
    else favorites.delete(hit.id);
    if (current?.hit.id === hit.id) current.favorite = on;
    paint();
    try {
      await invoke("armory_favorite", { hit, favorite: on });
    } catch {
      // Fica como estava na próxima abertura.
    }
    if (page === "chars" && !lastQuery) refreshSavedCharacters();
  });
  paint();
  return button;
}

function characterRow(hit, note) {
  return el(
    "div",
    { class: "crow" },
    el(
      "button",
      { class: "crow-open", type: "button", onclick: () => go({ page: "char", id: hit.id, serverId: hit.serverId, hit }) },
      classBadge(hit.job),
      el(
        "span",
        { class: "cmain" },
        el("b", { text: hit.name }),
        el("span", { class: "muted" }, `${classInfo(hit.job).name} · Nv. ${hit.level} · ${serverLabel(hit)}`, note ? ` · ${note}` : null),
      ),
      raceTag(hit.race),
    ),
    starButton(hit),
  );
}

function characterList(hits, notes = []) {
  return el("div", { class: "clist" }, ...hits.map((hit, i) => characterRow(hit, notes[i])));
}

// Favoritos e vistos por último, quando não há busca.
async function refreshSavedCharacters() {
  let saved;
  try {
    saved = await invoke("armory_saved");
  } catch {
    return;
  }
  favorites.clear();
  for (const c of saved.favorites) favorites.add(c.id);
  if (lastQuery) return;
  const parts = [];
  if (saved.favorites.length) parts.push(el("h3", { class: "section", text: "Favoritos" }), characterList(saved.favorites));
  if (saved.recent.length) {
    parts.push(el("h3", { class: "section", text: "Vistos por último" }), characterList(saved.recent, saved.recent.map((c) => `visto ${ago(c.viewedMs)}`)));
  }
  if (parts.length === 0) {
    parts.push(
      el(
        "div",
        { class: "empty-state" },
        el("h2", { text: "Nenhum personagem ainda" }),
        el("p", { text: "Digite um nome na barra de cima e aperte Enter. Os personagens que você abrir ou favoritar ficam aqui." }),
      ),
    );
  }
  $("char-saved").hidden = false;
  $("char-saved").replaceChildren(...parts);
}

// ── página do personagem ───────────────────────────────────

const CHAR_TABS = [
  ["equipment", "Equipamento"],
  ["skills", "Skills"],
  ["daevanion", "Daevanion"],
  ["stats", "Atributos"],
  ["looks", "Aparência"],
];
let charState = { tab: "equipment", board: null, statsView: loadPref("chars.statsView") === "list" ? "list" : "ring" };
let current = null; // a página aberta: Profile + favorite
let charSeq = 0;

// Enquanto o site responde: o que a busca já sabia, e blocos no resto.
function loadingPage(hit) {
  const head = hit
    ? charHeader(hit, null)
    : el("header", { class: "char-head" }, skeleton("sk-portrait"), skeleton("sk-title", "sk-line", "sk-line short"));
  return [head, el("div", { class: "ctabs" }, ...CHAR_TABS.map(() => skeleton("sk-tab"))), el("div", { class: "egroup" }, spinner("Abrindo o personagem"))];
}

async function openCharacter(entry) {
  show("char");
  const seq = ++charSeq;
  charState = { tab: "equipment", board: null, statsView: charState.statsView };
  current = null;
  $("char-view").replaceChildren(...loadingPage(entry.hit));
  let page;
  try {
    page = await invoke("armory_profile", { id: entry.id, serverId: entry.serverId, maxAgeS: 7 * 24 * 3600 });
  } catch (error) {
    if (seq !== charSeq) return;
    $("char-view").replaceChildren(
      entry.hit ? charHeader(entry.hit, null) : "",
      el(
        "div",
        { class: "empty-state" },
        el("h2", { text: "Não deu para abrir" }),
        el("p", { text: String(error) }),
        el("button", { class: "button", text: "Tentar de novo", onclick: () => openCharacter(entry) }),
      ),
    );
    return;
  }
  if (seq !== charSeq) return;
  current = page;
  renderCharacter();
  prefetchItems();
  if (Date.now() - page.fetchedMs > STALE_MS) refreshCharacter(true);
}

async function refreshCharacter(quiet = false) {
  if (!current) return;
  const seq = charSeq;
  document.querySelector(".refresh")?.classList.add("spinning");
  try {
    const page = await invoke("armory_profile", { id: current.hit.id, serverId: current.hit.serverId, maxAgeS: 0 });
    if (seq !== charSeq) return;
    current = page;
    renderCharacter();
    prefetchItems();
  } catch (error) {
    document.querySelector(".refresh")?.classList.remove("spinning");
    const line = document.querySelector(".char-alert");
    if (!quiet && line) line.textContent = `Não deu para atualizar: ${error}`;
  }
}

function charHeader(hit, page) {
  const profile = page?.info?.profile;
  const stats = page?.info?.stat?.statList ?? [];
  const itemLevel = stats.find((s) => s.type === "ItemLevel")?.value;
  const petwing = page?.equipment?.petwing ?? {};

  const photo = hit.image ? el("img", { class: "photo", src: hit.image, alt: `Retrato de ${hit.name}` }) : classBadge(hit.job);
  photo.addEventListener?.("error", () => photo.replaceWith(classBadge(hit.job)));
  const portrait = el("div", { class: "portrait" }, photo, el("span", { class: "plevel", title: "Nível", text: String(profile?.characterLevel ?? hit.level) }));

  const id = el(
    "div",
    { class: "char-id" },
    el(
      "div",
      { class: "char-name" },
      el("h2", { text: profile?.characterName ?? hit.name }),
      el("span", { class: "chip" }, el("span", { class: `dot ${RACE[hit.race]?.[1] ?? ""}` }), serverLabel(hit)),
      page
        ? el(
            "button",
            { class: "icon-button refresh", type: "button", title: `Atualizar (dados de ${ago(page.fetchedMs)})`, "aria-label": "Atualizar do site oficial", onclick: () => refreshCharacter() },
            svgIcon('<path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v5h-5"/>'),
          )
        : null,
    ),
    profile?.titleName ? el("div", { class: `title ${gradeClass(profile.titleGrade)}`, text: profile.titleName }) : null,
    el(
      "div",
      { class: "char-line" },
      classBadge(hit.job, true),
      el("span", { text: profile?.className ?? classInfo(hit.job).name }),
      el("span", { class: "sep", "aria-hidden": "true", text: "•" }),
      el("span", { text: RACE[hit.race]?.[0] ?? "" }),
      itemLevel ? el("span", { class: "chip", title: "Nível de item" }, el("span", { class: "muted", text: "Nível de item" }), el("b", { text: number(itemLevel) })) : null,
    ),
    profile
      ? el(
          "div",
          { class: "char-line" },
          el("span", { class: "cp", title: "Poder de combate" }, el("img", { src: `${SITE_IMG}/info/profile_power_icon_pc.png`, alt: "" }), el("span", { text: "PC" }), el("b", { text: number(profile.combatPower) })),
          el("span", { class: "muted small", text: `Atualizado ${ago(page.fetchedMs)}` }),
        )
      : null,
    el("p", { class: "char-alert", role: "status" }),
  );

  const extras = el("div", { class: "char-extra" });
  if (petwing.pet) extras.append(miniCard(petwing.pet.icon, petwing.pet.name, `Pet · Nv. ${petwing.pet.level}`));
  if (petwing.wing) extras.append(miniCard(petwing.wing.icon, petwing.wing.name, "Asas", petwing.wing.grade));

  return el("header", { class: "char-head" }, portrait, id, extras, page ? el("div", { class: "char-actions" }, starButton(hit, true)) : null);
}

function miniCard(icon, name, sub, grade) {
  return el(
    "div",
    { class: `mini ${grade ? gradeClass(grade) : ""}` },
    icon ? el("img", { src: icon, alt: "" }) : null,
    el("span", {}, el("b", { text: name }), el("span", { class: "muted small", text: sub })),
  );
}

function renderCharacter() {
  if (!current) return;
  if (current.favorite) favorites.add(current.hit.id);
  else favorites.delete(current.hit.id);
  const tabs = el("div", { class: "ctabs", role: "tablist" });
  for (const [id, label] of CHAR_TABS) {
    tabs.append(
      el("button", {
        role: "tab",
        class: "ctab",
        type: "button",
        "aria-selected": String(charState.tab === id),
        text: label,
        onclick: () => {
          charState.tab = id;
          renderCharacter();
        },
      }),
    );
  }
  const render = { equipment: equipmentTab, skills: skillsTab, daevanion: daevanionTab, stats: statsTab, looks: looksTab }[charState.tab];
  $("char-view").replaceChildren(charHeader(current.hit, current), tabs, el("div", { class: "ctab-body", role: "tabpanel" }, render(current)));
}

// ── equipamento ────────────────────────────────────────────

const SLOT_NAMES = {
  MainHand: "Mão principal",
  SubHand: "Mão secundária",
  Helmet: "Elmo",
  Shoulder: "Ombreiras",
  Torso: "Peitoral",
  Pants: "Calças",
  Gloves: "Luvas",
  Boots: "Botas",
  Cape: "Capa",
  Necklace: "Colar",
  Earring1: "Brinco",
  Earring2: "Brinco",
  Ring1: "Anel",
  Ring2: "Anel",
  Bracelet1: "Bracelete",
  Bracelet2: "Bracelete",
  Belt: "Cinto",
  Amulet: "Amuleto",
};
const SLOT_GROUPS = [
  ["Armas", ["MainHand", "SubHand"]],
  ["Armadura", ["Helmet", "Shoulder", "Torso", "Pants", "Gloves", "Boots", "Cape"]],
  ["Acessórios", ["Necklace", "Earring1", "Earring2", "Ring1", "Ring2", "Bracelet1", "Bracelet2", "Belt", "Amulet"]],
];

const slotName = (slot) => SLOT_NAMES[slot] ?? (slot.startsWith("Rune") ? `Runa ${slot.slice(4)}` : slot);
const itemTitle = (item) => `${item.enchantLevel > 0 ? `+${item.enchantLevel} ` : ""}${item.name}`;

function itemCard(item, withDetails) {
  const card = el(
    "button",
    { class: `item ${gradeClass(item.grade)}`, type: "button", "aria-label": `${itemTitle(item)}, ${slotName(item.slotPosName)}` },
    el("span", { class: "item-icon" }, el("img", { src: item.icon, alt: "", loading: "lazy" })),
    el(
      "span",
      { class: "item-text" },
      el("b", { text: itemTitle(item) }, item.exceedLevel > 0 ? el("span", { class: "exceed", text: ` ✦${item.exceedLevel}` }) : null),
      el("span", { class: "muted", text: slotName(item.slotPosName) }),
    ),
  );
  if (withDetails) attachItemTip(card, item);
  return card;
}

function equipmentTab(page) {
  const items = page.equipment?.equipment?.equipmentList ?? [];
  if (items.length === 0) return el("p", { class: "hint", text: "Nada equipado." });
  const used = new Set();
  const groups = SLOT_GROUPS.map(([title, slots]) => {
    const list = slots.map((slot) => items.find((i) => i.slotPosName === slot)).filter(Boolean);
    list.forEach((i) => used.add(i));
    return [title, list];
  });
  const runes = items.filter((i) => !used.has(i) && i.slotPosName.startsWith("Rune"));
  runes.forEach((i) => used.add(i));
  groups.push(["Runas", runes], ["Outros", items.filter((i) => !used.has(i))]);
  return el(
    "div",
    { class: "egroups" },
    ...groups
      .filter(([, list]) => list.length)
      .map(([title, list]) => el("section", { class: "egroup" }, el("h3", { text: title }), el("div", { class: "items" }, ...list.map((i) => itemCard(i, true))))),
  );
}

// Detalhes dos itens: chegam todos logo depois da página (armory_items) e
// ficam guardados com ela, para o quadro abrir na hora.
const itemDetails = new Map(); // `${personagem}|${lugar}|${item}|${encantamento}` → detalhes
const itemKey = (charId, item) => `${charId}|${item.slotPos}|${item.id}|${item.enchantLevel}`;
let itemsLoading = null; // a busca de todos os itens da página aberta

function prefetchItems() {
  const page = current;
  if (!page) return;
  for (const [key, value] of Object.entries(page.items ?? {})) itemDetails.set(`${page.hit.id}|${key}`, value);
  const equipped = page.equipment?.equipment?.equipmentList ?? [];
  if (equipped.every((item) => itemDetails.has(itemKey(page.hit.id, item)))) return;
  itemsLoading = invoke("armory_items", { id: page.hit.id })
    .then((items) => {
      for (const [key, value] of Object.entries(items)) itemDetails.set(`${page.hit.id}|${key}`, value);
    })
    .catch(() => {})
    .finally(() => {
      if (current === page) itemsLoading = null;
      // Quem estava com o quadro aberto esperando vê os detalhes agora.
      tipOwner?.dispatchEvent(new Event("details"));
    });
}

// Um quadro ao lado de um item, nó ou atributo.
const tipEl = el("div", { class: "tip", role: "tooltip", hidden: true });
document.body.append(tipEl);
let tipOwner = null;

function placeTip(owner) {
  const rect = owner.getBoundingClientRect();
  const gap = 10;
  const width = tipEl.offsetWidth;
  const height = tipEl.offsetHeight;
  let left = rect.right + gap;
  if (left + width > window.innerWidth - 8) left = rect.left - width - gap;
  if (left < 8) left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.left));
  let top = rect.top;
  if (top + height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - height - 8);
  tipEl.style.left = `${left}px`;
  tipEl.style.top = `${top}px`;
}

function showTip(owner, content) {
  tipOwner = owner;
  tipEl.replaceChildren(...content);
  tipEl.hidden = false;
  placeTip(owner);
}

function hideTip(owner) {
  if (owner && tipOwner !== owner) return;
  tipOwner = null;
  tipEl.hidden = true;
}

function attachTip(target, content) {
  const open = () => showTip(target, content());
  target.addEventListener("mouseenter", open);
  target.addEventListener("focus", open);
  target.addEventListener("mouseleave", () => hideTip(target));
  target.addEventListener("blur", () => hideTip(target));
}

$("main").addEventListener("scroll", () => hideTip());
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") hideTip();
});

function attachItemTip(card, item) {
  const key = itemKey(current.hit.id, item);
  const open = async () => {
    showTip(card, itemTip(item, itemDetails.get(key)));
    if (itemDetails.has(key)) return;
    // A busca de todos já está a caminho: espera ela em vez de pedir de novo.
    if (itemsLoading) {
      await itemsLoading;
      if (itemDetails.has(key)) return;
    }
    const page = current;
    try {
      const details = await invoke("armory_item", {
        id: page.hit.id,
        serverId: page.hit.serverId,
        itemId: item.id,
        enchant: item.enchantLevel,
        slot: item.slotPos,
      });
      itemDetails.set(key, details);
    } catch (error) {
      itemDetails.set(key, { error: String(error) });
    }
    if (tipOwner === card) showTip(card, itemTip(item, itemDetails.get(key)));
  };
  card.addEventListener("mouseenter", open);
  card.addEventListener("focus", open);
  card.addEventListener("click", open);
  card.addEventListener("details", () => {
    if (tipOwner === card) showTip(card, itemTip(item, itemDetails.get(key)));
  });
  card.addEventListener("mouseleave", () => hideTip(card));
  card.addEventListener("blur", () => hideTip(card));
}

function tipStat(name, value, extra, cls) {
  return el("div", { class: `tip-stat ${cls ?? ""}` }, el("span", { text: name }), el("span", {}, el("b", { text: value }), extra ? el("span", { class: "plus", text: ` (+${extra})` }) : null));
}

function itemTip(item, details) {
  const head = el(
    "div",
    { class: `tip-head ${gradeClass(item.grade)}` },
    el("span", { class: "item-icon" }, el("img", { src: item.icon, alt: "" })),
    el("span", {}, el("b", { text: itemTitle(item) }), el("span", { class: "muted small", text: details?.gradeName ? `${details.gradeName} · ${details.categoryName ?? slotName(item.slotPosName)}` : slotName(item.slotPosName) })),
  );
  if (!details) return [head, spinner("Carregando os atributos", true)];
  if (details.error) return [head, el("p", { class: "muted small", text: details.error })];

  const out = [head];
  const required = details.equipLevel > 1 ? ` (requer ${details.equipLevel})` : "";
  const who = details.classNames?.length ? details.classNames.join(", ") : details.raceName ?? "";
  out.push(el("div", { class: "tip-line muted small" }, el("span", { text: `Nível ${details.level ?? "?"}${required}` }), el("span", { text: who })));
  if (details.mainStats?.length) {
    out.push(el("h4", { text: "Atributos base" }), ...details.mainStats.map((s) => tipStat(s.name, s.value, s.extra && s.extra !== "0" ? s.extra : null)));
  }
  if (details.soulBindRate) {
    const rate = Number(details.soulBindRate);
    out.push(
      el("div", { class: "tip-stat soul" }, el("span", { text: "Vínculo de alma" }), el("b", { text: `${String(details.soulBindRate).replace(".", ",")}%` })),
      el("div", { class: "soulbar" }, el("span", { style: `width: ${Math.min(100, rate)}%` })),
    );
  }
  if (details.subStats?.length) {
    out.push(el("h4", { text: "Atributos adicionais" }), ...details.subStats.map((s) => tipStat(s.name, `+${s.value}`, null, "bonus")));
  }
  if (details.magicStoneStat?.length) {
    out.push(
      el("h4", { text: `Pedras de mana (${details.magicStoneStat.length}/${details.magicStoneSlotCount ?? details.magicStoneStat.length})` }),
      // O site aponta para um ícone de pedra que não existe no CDN: um
      // losango na cor da raridade no lugar.
      ...details.magicStoneStat.map((m) => el("div", { class: `tip-stone ${gradeClass(m.grade)}` }, el("span", { class: "gem", "aria-hidden": "true", text: "◆" }), el("span", { text: `${m.name} ${m.value}` }))),
    );
  }
  if (details.sources?.length) out.push(el("p", { class: "muted small", text: `Onde conseguir: ${details.sources.join(", ")}` }));
  const flags = [!details.tradable && "Não negociável", details.storable === false && "Não vai para o armazém"].filter(Boolean);
  if (flags.length) out.push(el("p", { class: "tip-flags", text: flags.join(" · ") }));
  return out;
}

// ── skills ─────────────────────────────────────────────────

const SKILL_GROUPS = [
  ["Active", "Ativas"],
  ["Passive", "Passivas"],
  ["Dp", "Habilidades de PD"],
];

function skillsTab(page) {
  const skills = page.equipment?.skill?.skillList ?? [];
  if (skills.length === 0) return el("p", { class: "hint", text: "Sem skills." });
  const known = new Set(SKILL_GROUPS.map(([id]) => id));
  const groups = [...SKILL_GROUPS, ["", "Outras"]].map(([id, title]) => [title, skills.filter((s) => (id ? s.category === id : !known.has(s.category)))]);
  return el(
    "div",
    { class: "egroups" },
    ...groups
      .filter(([, list]) => list.length)
      .map(([title, list]) =>
        el(
          "section",
          { class: "egroup" },
          el("h3", {}, title, el("span", { class: "count", text: `${list.filter((s) => s.acquired).length}/${list.length}` })),
          el(
            "div",
            { class: "skills-grid" },
            ...[...list]
              .sort((a, b) => b.acquired - a.acquired || b.skillLevel - a.skillLevel)
              .map((s) =>
                el(
                  "div",
                  { class: `skill-card${s.acquired ? "" : " locked"}`, title: s.acquired ? s.name : `${s.name} (não aprendida)` },
                  el("img", { src: s.icon, alt: "", loading: "lazy" }),
                  el("span", {}, el("b", { text: s.name }), el("span", { class: "muted small", text: s.acquired ? `Nível ${s.skillLevel}` : "Não aprendida" })),
                ),
              ),
          ),
        ),
      ),
  );
}

// ── Daevanion ──────────────────────────────────────────────
// Como no site oficial: cada nó com o ícone do jogo (o da
// raridade, ou o da skill que ele melhora), apagado enquanto fechado.

const boards = new Map();

// "Luz da Cura +1" → a skill "Luz da Cura" do personagem, para o ícone.
function skillOf(page, desc) {
  const name = String(desc ?? "").replace(/\s*[+-]\d+%?$/, "").trim();
  return (page.equipment?.skill?.skillList ?? []).find((s) => s.name === name);
}

function daevanionTab(page) {
  const list = page.info?.daevanion?.boardList ?? [];
  if (list.length === 0) return el("p", { class: "hint", text: "Sem Daevanion." });
  charState.board ??= list.find((b) => b.openNodeCount > 0)?.id ?? list[0].id;
  const picker = el(
    "div",
    { class: "boards", role: "group", "aria-label": "Tabelas Daevanion" },
    ...list.map((b) =>
      el(
        "button",
        {
          class: "board",
          type: "button",
          "aria-pressed": String(b.id === charState.board),
          onclick: () => {
            charState.board = b.id;
            renderCharacter();
          },
        },
        el("b", { text: b.name }),
        el("span", { class: "muted small", text: `${b.openNodeCount}/${b.totalNodeCount}` }),
        el("span", { class: "board-bar" }, el("span", { style: `width: ${b.openPercent}%` })),
      ),
    ),
  );
  const area = el("div", { class: "board-area" }, el("div", { class: "egroup" }, spinner("Abrindo a tabela")));
  const key = `${page.hit.id}|${charState.board}`;
  const fill = (data) => area.replaceChildren(boardView(page, data));
  if (boards.has(key)) fill(boards.get(key));
  else {
    const board = charState.board;
    invoke("armory_daevanion", { id: page.hit.id, serverId: page.hit.serverId, board })
      .then((data) => {
        boards.set(key, data);
        if (charState.board === board && charState.tab === "daevanion") fill(data);
      })
      .catch((error) => area.replaceChildren(el("p", { class: "hint", text: `Não deu para abrir a tabela: ${error}` })));
  }
  return el("div", { class: "daevanion" }, picker, area);
}

function nodeIcon(page, node) {
  if (node.type === "Start") return `${SITE_IMG}/daevanion/board_icon_start_${page.hit.job || "cleric"}.png`;
  if (node.type === "SkillLevel") {
    const skill = skillOf(page, node.effectList?.[0]?.desc);
    if (skill?.icon) return skill.icon;
  }
  const grade = ["common", "rare", "legend", "unique"].includes(gradeKey(node.grade)) ? gradeKey(node.grade) : "common";
  return `${SITE_IMG}/daevanion/board_icon_${grade}${node.open ? "_open" : ""}.png`;
}

function boardView(page, data) {
  const nodes = (data.nodeList ?? []).filter((n) => n.type !== "None");
  if (nodes.length === 0) return el("p", { class: "hint", text: "Tabela vazia." });
  const rows = Math.max(...nodes.map((n) => n.row));
  const cols = Math.max(...nodes.map((n) => n.col));
  const grid = el("div", { class: "dgrid", style: `--rows: ${rows}; --cols: ${cols}`, role: "group", "aria-label": "Nós da tabela" });
  for (const n of nodes) {
    const effects = (n.effectList ?? []).map((e) => e.desc).join(", ");
    const name = n.name || (n.type === "Start" ? "Início" : "Nó");
    const tile = el(
      "button",
      {
        type: "button",
        class: `dtile ${gradeClass(n.grade)} ${n.type === "SkillLevel" ? "skill" : n.type === "Start" ? "start" : "stat"}${n.open ? " open" : ""}`,
        style: `grid-row: ${n.row}; grid-column: ${n.col}`,
        "aria-label": `${name}${effects ? `: ${effects}` : ""} (${n.open ? "aberto" : "fechado"})`,
      },
      el("img", { src: nodeIcon(page, n), alt: "", loading: "lazy" }),
    );
    attachTip(tile, () => [
      el("div", { class: `tip-head ${gradeClass(n.grade)}` }, el("span", { class: "item-icon" }, el("img", { src: nodeIcon(page, n), alt: "" })), el("span", {}, el("b", { text: name }), el("span", { class: "muted small", text: n.open ? "Aberto" : "Fechado" }))),
      ...(n.effectList ?? []).map((e) => el("div", { class: "tip-stat bonus" }, el("span", { text: e.desc }))),
    ]);
    grid.append(tile);
  }
  const skills = data.openSkillEffectList ?? [];
  const stats = data.openStatEffectList ?? [];
  const effects = el(
    "aside",
    { class: "deffects" },
    el("h3", {}, "Efeitos ativos", el("span", { class: "count", text: String(skills.length + stats.length) })),
    skills.length ? el("h4", { text: "Melhorias de skill" }) : null,
    ...skills.map((e) => {
      const skill = skillOf(page, e.desc);
      return el("div", { class: "effect skill" }, skill?.icon ? el("img", { src: skill.icon, alt: "" }) : el("span", { class: "gem", "aria-hidden": "true", text: "◆" }), el("span", { text: e.desc }));
    }),
    stats.length ? el("h4", { text: "Atributos" }) : null,
    ...stats.map((e) => el("div", { class: "effect" }, el("span", { class: "gem", "aria-hidden": "true", text: "◆" }), el("span", { text: e.desc }))),
    skills.length + stats.length === 0 ? el("p", { class: "muted", text: "Nenhum nó aberto nesta tabela." }) : null,
  );
  return el("div", { class: "board-layout" }, el("div", { class: "dboard" }, grid), effects);
}

// ── atributos ──────────────────────────────────────────────

const BASE_STATS = ["STR", "DEX", "INT", "CON", "AGI", "WIS"];
// O que cada ponto de atributo dá: 0,1% em cada efeito (Poder 32 = Ataque
// +3,2%). Em inglês o site manda essas linhas prontas; em português manda
// vazio, então elas saem daqui. Vitalidade e Determinação ficam de fora: o
// site não disse o que elas dão.
const STAT_EFFECTS = {
  STR: ["Ataque"],
  DEX: ["Evasão", "Bloqueio", "Resistência a Acerto Crítico"],
  INT: ["Chance de Efeito de Status"],
  AGI: ["Precisão", "Acerto Crítico"],
  Justice: ["Defesa", "Chance de Perfeito"],
  Freedom: ["Precisão", "Evasão"],
  Illusion: ["-Tempo de Recarga", "Penetração de Resistência"],
  Life: ["PV", "Regeneração"],
  Time: ["Velocidade de Combate", "Resistência a Duplo"],
  Destruction: ["Ataque", "Resistência a Perfeito"],
  Death: ["Acerto Crítico", "Penetração de Regeneração"],
  Wisdom: ["-Custo de PM", "Chance de Duplo"],
  Destiny: ["PM", "Resistência"],
  Space: ["Velocidade de Movimento", "Bloqueio"],
};
// Posição de cada um na roda do jogo, numa caixa de 500: os dez deuses em
// volta e os seis atributos no centro.
const RING_GODS = {
  Justice: [163, 99],
  Destruction: [338, 99],
  Death: [402, 163],
  Wisdom: [425, 251],
  Destiny: [402, 338],
  Space: [338, 402],
  Time: [163, 402],
  Life: [98, 338],
  Illusion: [75, 251],
  Freedom: [98, 163],
};
const RING_BASE = { STR: [250, 178], DEX: [312, 205], AGI: [312, 268], WIS: [250, 296], INT: [188, 268], CON: [188, 205] };
const TITLE_GROUPS = { Attack: "Ataque", Defense: "Defesa", Etc: "Outros" };

function statLines(stat) {
  if (stat.statSecondList?.length) return stat.statSecondList;
  const value = Number(stat.value) / 10;
  if (!value || !STAT_EFFECTS[stat.type]) return [];
  const amount = value.toLocaleString("pt-BR", { maximumFractionDigits: 1 });
  return STAT_EFFECTS[stat.type].map((name) => (name.startsWith("-") ? `${name.slice(1)} -${amount}%` : `${name} +${amount}%`));
}

function statTip(stat) {
  const lines = statLines(stat);
  return () => [
    el("div", { class: "tip-head" }, el("span", {}, el("b", { text: stat.name }), el("span", { class: "muted small", text: `${number(stat.value)} pontos` }))),
    ...(lines.length ? lines.map((line) => el("div", { class: "tip-stat bonus" }, el("span", { text: line }))) : [el("p", { class: "muted small", text: "Sem efeito com 0 pontos." })]),
  ];
}

function ringView(stats) {
  const ring = el("div", { class: "ring", role: "group", "aria-label": "Atributos divinos e atributos" }, el("img", { class: "ring-bg", src: "img/stat-ring.webp", alt: "" }));
  const at = ([x, y]) => `left: ${x / 5}%; top: ${y / 5}%`;
  for (const [type, pos] of Object.entries(RING_GODS)) {
    const stat = stats.find((s) => s.type === type);
    if (!stat) continue;
    const spot = el(
      "button",
      { type: "button", class: "ring-god", style: at(pos), "aria-label": `${stat.name}: ${stat.value}` },
      el("img", { src: `${SITE_IMG}/info/stat_lords_${type.toLowerCase()}.png`, alt: "" }),
      el("b", { text: String(stat.value) }),
    );
    attachTip(spot, statTip(stat));
    ring.append(spot);
  }
  for (const [type, pos] of Object.entries(RING_BASE)) {
    const stat = stats.find((s) => s.type === type);
    if (!stat) continue;
    const spot = el(
      "button",
      { type: "button", class: "ring-base", style: at(pos), "aria-label": `${stat.name}: ${stat.value}` },
      el("img", { src: `${SITE_IMG}/info/stat_${type.toLowerCase()}.png`, alt: "" }),
      el("span", { text: stat.name }),
      el("b", { text: String(stat.value) }),
    );
    attachTip(spot, statTip(stat));
    ring.append(spot);
  }
  return ring;
}

function statsList(stats) {
  const statRow = (s) =>
    el(
      "div",
      { class: "stat-row" },
      el("div", { class: "stat-main" }, el("span", { text: s.name }), el("b", { text: number(s.value) })),
      ...statLines(s).map((line) => el("span", { class: "muted small", text: line })),
    );
  return [
    el("section", { class: "egroup" }, el("h3", { text: "Atributos" }), el("div", { class: "stat-list" }, ...stats.filter((s) => BASE_STATS.includes(s.type)).map(statRow))),
    el("section", { class: "egroup" }, el("h3", { text: "Atributos divinos" }), el("div", { class: "stat-list" }, ...stats.filter((s) => !BASE_STATS.includes(s.type)).map(statRow))),
  ];
}

function titlesCard(title) {
  if (!title) return null;
  return el(
    "section",
    { class: "egroup" },
    el("h3", {}, "Títulos", el("span", { class: "count", text: `${title.ownedCount}/${title.totalCount}` })),
    ...(title.titleList ?? []).map((t) =>
      el(
        "div",
        { class: "title-row" },
        el("span", { text: TITLE_GROUPS[t.equipCategory] ?? t.equipCategory }),
        el("span", { class: "board-bar" }, el("span", { style: `width: ${t.ownedPercent}%` })),
        el("b", { text: `${t.ownedCount}/${t.totalCount}` }),
      ),
    ),
  );
}

function statsTab(page) {
  const stats = (page.info?.stat?.statList ?? []).filter((s) => s.type !== "ItemLevel");
  const views = [
    ["ring", "Roda"],
    ["list", "Lista"],
  ];
  const toggle = el(
    "div",
    { class: "segmented", role: "radiogroup", "aria-label": "Como mostrar os atributos" },
    ...views.map(([id, label]) =>
      el("button", {
        type: "button",
        class: "segment",
        role: "radio",
        "aria-checked": String(charState.statsView === id),
        text: label,
        onclick: () => {
          charState.statsView = id;
          savePref("chars.statsView", id);
          renderCharacter();
        },
      }),
    ),
  );
  const body =
    charState.statsView === "list"
      ? el("div", { class: "stats-layout" }, ...statsList(stats), titlesCard(page.info?.title))
      : el("div", { class: "ring-layout" }, el("div", { class: "ring-wrap" }, ringView(stats)), titlesCard(page.info?.title));
  return el("div", { class: "stats-tab" }, el("div", { class: "stats-toolbar" }, toggle, el("span", { class: "muted small", text: "Passe o mouse num atributo para ver o que ele dá." })), body);
}

// ── aparência ──────────────────────────────────────────────

function looksTab(page) {
  const skins = page.equipment?.equipment?.skinList ?? [];
  const wing = page.equipment?.petwing?.wingSkin;
  if (skins.length === 0 && !wing) return el("p", { class: "hint", text: "Sem aparência trocada." });
  const cards = skins.map((i) => itemCard(i, false));
  if (wing) cards.push(itemCard({ ...wing, slotPosName: "Asas", exceedLevel: 0 }, false));
  return el("section", { class: "egroup" }, el("h3", { text: "Aparência" }), el("div", { class: "items" }, ...cards));
}
