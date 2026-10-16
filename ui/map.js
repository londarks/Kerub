// O mapa de Atreia (o Rust baixa os dados e guarda: maps.rs).
//
// Leve de propósito. A imagem vem em quadrados de 256 px e só os que aparecem
// na tela são pedidos; enquanto um não chega, um pedaço do nível de cima,
// esticado, fica no lugar. Os pontos (até 27 mil num mapa) ficam em arrays
// tipados, na ordem de desenho, e são desenhados uma vez numa camada um pouco
// maior que a tela, com os ícones tirados de uma folha só: arrastar é copiar
// essa camada, e no meio de um zoom ela é esticada e refeita no fim. E nada
// roda parado: só redesenha quando algo muda (arrastar, zoom, um quadrado
// que chegou).

const MAP_ASSETS = "https://shugoggassets.blob.core.windows.net/assets";
const GAME_ICONS = "https://assets.playnccdn.com/static-aion2-gamedata/resources";
/// Quadrados guardados na memória (256 KB cada um, já decodificado).
const TILE_CACHE = 160;
const MAP_BG = "#0e1014";
const MAP_ACCENT = "#5b9dff";
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

const MAP_NAMES = {
  "reshanta-lower": "Reshanta Inferior",
  "reshanta-middle": "Reshanta Média",
  "reshanta-upper": "Reshanta Superior",
};
const MAP_RACES = [
  ["Light", "Elyos"],
  ["Dark", "Asmodianos"],
  ["All", "Abismo"],
];

const LAYER_GROUPS = {
  Highlights: "Destaques",
  Places: "Lugares",
  Travel: "Viagem",
  Dungeons: "Masmorras",
  Collectables: "Coletáveis",
  Resources: "Recursos",
  Services: "Serviços",
  NPCs: "NPCs",
  Quests: "Missões",
  Monsters: "Monstros",
  Objects: "Objetos",
  Events: "Eventos",
};

// Ordem de desenho: o que vem depois fica por cima.
const LAYER_DEPTH = { Monsters: 1, NPCs: 1, Objects: 1, Quests: 2, Collectables: 3, Resources: 3, Services: 4, Events: 5, Dungeons: 5, Travel: 6, Places: 7, Highlights: 8 };

const LAYER_NAMES = {
  Named: "Monstros nomeados",
  HiddenCube: "Cubos ocultos",
  FieldEvent: "Eventos",
  Rift: "Fendas espaço-temporais",
  Monolith: "Monólitos",
  AbyssArtifact: "Artefatos do Abismo",
  Village: "Vilas",
  BattleField: "Áreas de caça",
  Kibelisk: "Kibelisks",
  FlightRing: "Círculos de voo",
  Portal: "Portais",
  Updraft: "Correntes de ar",
  DungeonEntrance: "Entradas de masmorra",
  SealedDungeon: "Masmorras seladas",
  InstanceDoor: "Portas de instância",
  EmpyreanTrace: "Rastros Empíreos",
  Chest: "Baús",
  Merchant: "Mercadores",
  Storage: "Armazéns",
  Companion: "Companheiros",
  Citizen: "Moradores",
  QuestObject: "Objetos de missão",
  Elite: "Monstros de elite",
  Special: "Monstros especiais",
  Interactive: "Objetos interativos",
};

// Monstros comuns não têm ícone: um ponto da cor da raça. Nada de amarelo.
const LAYER_COLORS = { Cogni: "#ff5c5c", Fera: "#ff8f3d", Natura: "#4ade80", Varian: "#c084fc", Special: "#ff7ab8" };

const SUBTITLE_PARTS = {
  "Quest object": "Objeto de missão",
  Object: "Objeto",
  "Sealed dungeon": "Masmorra selada",
  Village: "Vila",
  "Hunting ground": "Área de caça",
  "Instance door": "Porta de instância",
  "Dungeon entrance": "Entrada de masmorra",
  "Instance entrance": "Entrada de instância",
  Merchant: "Mercador",
  Resource: "Recurso",
  Chest: "Baú",
  Updraft: "Corrente de ar",
  Companion: "Companheiro",
  Event: "Evento",
  "Abyss artifact": "Artefato do Abismo",
  "Abyss core": "Núcleo do Abismo",
  Monolith: "Monólito",
  "Storage manager": "Armazém",
  "Empyrean Trace": "Rastro Empíreo",
  "Flight circle": "Círculo de voo",
  "Teleportation portal": "Portal de teletransporte",
  "Hidden cube": "Cubo oculto",
  "Spacetime rift": "Fenda espaço-temporal",
  Named: "Nomeado",
};

const mapName = (map) => MAP_NAMES[map.key] ?? map.name;
const layerName = (cat) => LAYER_NAMES[cat.id] ?? cat.label ?? cat.id;
const layerIconUrl = (path) => (!path ? null : path.startsWith("/") ? `${MAP_ASSETS}${path}` : `${GAME_ICONS}/${path}.png`);
// Sem acento e em minúsculas, para a busca.
const fold = (text) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

function subtitleText(s = "") {
  return s
    .split(" · ")
    .map((part) => SUBTITLE_PARTS[part] ?? part.replace(/^Lv (\d+)$/, "Nível $1").replace(/^Gathering (\d+)$/, "Coleta $1"))
    .join(" · ");
}

// Alguns pontos só têm o nome interno do jogo (M_FE_Racing_…): no lugar, o
// nome da camada.
function pointName(points, t) {
  const template = points.templates[t];
  if (/^[A-Za-z0-9]+(_[A-Za-z0-9]+){2,}$/.test(template.n)) return layerName(points.categories[points.tplCat[t]]);
  return template.n;
}

// A resposta do Rust vem como bytes de JSON (maps.rs).
function readJson(answer) {
  if (typeof answer === "string") return JSON.parse(answer);
  if (answer instanceof ArrayBuffer || ArrayBuffer.isView(answer)) return JSON.parse(new TextDecoder().decode(answer));
  if (Array.isArray(answer)) return JSON.parse(new TextDecoder().decode(new Uint8Array(answer)));
  return answer;
}

// ── o canvas ───────────────────────────────────────────────

class MapCanvas {
  constructor(canvas, events) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false });
    this.events = events; // hover(i), select(i), area(area), frame()
    this.map = null;
    this.points = null;
    // Centro em px do mapa e zoom como log2 da escala (0 = 1 px da tela por px do mapa).
    this.cx = 0;
    this.cy = 0;
    this.z = 0;
    this.w = 0;
    this.h = 0;
    this.dpr = 1;
    this.fitted = false;
    this.raf = 0;
    this.lastStep = 0;
    this.zoomTo = null; // zoom suave da roda: { z, ax, ay }
    this.flight = null; // voo até um lugar: { from, to, start, ms }
    this.glide = null; // inércia depois de arrastar, em px da tela por ms
    this.drag = null;
    this.mouse = null;
    this.hoverRaf = 0;
    this.tiles = new Map();
    this.frameNo = 0;
    this.sprites = new Map();
    this.textWidths = new Map();
    this.hovered = -1;
    this.selected = -1;
    this.labels = [];
    this.sheetCache = null; // { size, image }: os ícones lado a lado
    this.layer = null; // os pontos já desenhados (drawPoints)

    canvas.addEventListener("pointerdown", (e) => this.onDown(e));
    canvas.addEventListener("pointermove", (e) => this.onMove(e));
    canvas.addEventListener("pointerup", (e) => this.onUp(e));
    canvas.addEventListener("pointercancel", () => (this.drag = null));
    canvas.addEventListener("pointerleave", () => {
      this.mouse = null;
      if (!this.drag) this.setHovered(-1);
    });
    canvas.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    canvas.addEventListener("dblclick", (e) => this.zoomBy(1, e.offsetX, e.offsetY));
    canvas.addEventListener("keydown", (e) => this.onKey(e));
    new ResizeObserver(([entry]) => this.resize(entry.contentRect)).observe(canvas.parentElement);
  }

  // ── estado ──

  setMap(map) {
    for (const tile of this.tiles.values()) if (!tile.ready) tile.img.src = "";
    this.tiles = new Map();
    this.map = map;
    this.points = null;
    this.hovered = this.selected = -1;
    this.layer = null;
    this.textWidths.clear();
    this.flight = this.zoomTo = this.glide = null;
    // O quadrado do nível 0 é o mapa inteiro pequeno: fica no lugar dos outros
    // enquanto eles chegam.
    this.tile(0, 0, 0);
    // Com a página escondida não há tamanho: enquadra quando ela aparecer.
    this.fitted = this.w > 0;
    this.fit(true);
  }

  setPoints(points) {
    this.points = points;
    this.sprites.clear();
    this.sheetCache = null;
    this.layer = null;
    this.hovered = this.selected = -1;
    if (points) points.images = points.categories.map((cat, c) => this.loadIcon(cat, c));
    this.redraw();
  }

  // Camadas ligadas ou desligadas, ou um filtro da busca: os pontos mudam.
  refreshPoints() {
    if (this.layer) this.layer.dirty = true;
    this.redraw();
  }

  loadIcon(cat, c) {
    const url = layerIconUrl(cat.icon);
    if (!url) return null;
    const icon = { img: new Image(), ready: false };
    const done = () => {
      icon.ready = true;
      this.dropSprites(c);
      this.redraw();
    };
    icon.img.decoding = "async";
    icon.img.src = url;
    icon.img.decode().then(done, () => {
      const fallback = layerIconUrl(cat.fallback);
      if (!fallback || icon.img.src === fallback) return;
      icon.img.src = fallback;
      icon.img.decode().then(done, () => {});
    });
    return icon;
  }

  dropSprites(c) {
    for (const key of this.sprites.keys()) if (key.startsWith(`${c}:`)) this.sprites.delete(key);
    this.sheetCache = null;
    if (this.layer) this.layer.dirty = true;
  }

  select(i) {
    if (this.selected === i) return;
    this.selected = i;
    this.events.select(i);
    this.redraw();
  }

  setHovered(i) {
    if (this.hovered === i) return;
    this.hovered = i;
    this.canvas.style.cursor = i >= 0 ? "pointer" : "";
    this.events.hover(i);
    this.redraw();
  }

  // ── vista ──

  get scale() {
    return 2 ** this.z;
  }

  limits() {
    const [w, h] = this.map.size;
    const fit = Math.log2(Math.min(this.w / w, this.h / h));
    return [fit - 0.6, 2];
  }

  clampView() {
    if (!this.map) return;
    const [min, max] = this.limits();
    this.z = Math.min(max, Math.max(min, this.z));
    this.cx = Math.min(this.map.size[0], Math.max(0, this.cx));
    this.cy = Math.min(this.map.size[1], Math.max(0, this.cy));
  }

  fit(instant = false) {
    if (!this.map || !this.w) return;
    const [w, h] = this.map.size;
    const z = Math.log2(Math.min(this.w / w, this.h / h) * 0.96);
    this.flyTo(w / 2, h / 2, z, instant);
  }

  flyTo(cx, cy, z, instant = false) {
    this.zoomTo = this.glide = null;
    if (instant || reducedMotion.matches) {
      this.flight = null;
      Object.assign(this, { cx, cy, z });
      this.clampView();
    } else {
      this.flight = { from: { cx: this.cx, cy: this.cy, z: this.z }, to: { cx, cy, z }, start: performance.now(), ms: 520 };
    }
    this.redraw();
  }

  // Um retângulo do mapa inteiro na tela, com folga.
  flyToBounds(x0, y0, x1, y1, maxZ = 0) {
    const pad = 1.35;
    const w = Math.max(64, (x1 - x0) * pad);
    const h = Math.max(64, (y1 - y0) * pad);
    const z = Math.min(maxZ, Math.log2(Math.min(this.w / w, this.h / h)));
    this.flyTo((x0 + x1) / 2, (y0 + y1) / 2, z);
  }

  zoomBy(delta, ax = this.w / 2, ay = this.h / 2) {
    if (!this.map) return;
    const [min, max] = this.limits();
    const z = Math.min(max, Math.max(min, (this.zoomTo?.z ?? this.z) + delta));
    this.flight = this.glide = null;
    if (reducedMotion.matches) {
      this.zoomAround(z, ax, ay);
      this.redraw();
      return;
    }
    this.zoomTo = { z, ax, ay };
    this.redraw();
  }

  // Muda o zoom sem tirar do lugar o ponto que está embaixo de (ax, ay).
  zoomAround(z, ax, ay) {
    const before = this.scale;
    const mx = this.cx + (ax - this.w / 2) / before;
    const my = this.cy + (ay - this.h / 2) / before;
    this.z = z;
    this.cx = mx - (ax - this.w / 2) / this.scale;
    this.cy = my - (ay - this.h / 2) / this.scale;
  }

  // Avança as animações; true se ainda há o que animar.
  step(now) {
    const dt = this.lastStep ? Math.min(50, now - this.lastStep) : 16;
    this.lastStep = now;
    let active = false;
    if (this.flight) {
      const { from, to, start, ms } = this.flight;
      const t = Math.min(1, (now - start) / ms);
      const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
      this.cx = from.cx + (to.cx - from.cx) * e;
      this.cy = from.cy + (to.cy - from.cy) * e;
      this.z = from.z + (to.z - from.z) * e;
      if (t < 1) active = true;
      else this.flight = null;
    }
    if (this.zoomTo) {
      const { z, ax, ay } = this.zoomTo;
      const next = Math.abs(z - this.z) < 0.003 ? z : this.z + (z - this.z) * (1 - Math.exp(-dt / 65));
      this.zoomAround(next, ax, ay);
      if (next === z) this.zoomTo = null;
      else active = true;
    }
    if (this.glide) {
      const s = this.scale;
      this.cx -= (this.glide.vx * dt) / s;
      this.cy -= (this.glide.vy * dt) / s;
      const decay = Math.exp(-dt / 180);
      this.glide.vx *= decay;
      this.glide.vy *= decay;
      if (Math.hypot(this.glide.vx, this.glide.vy) < 0.02) this.glide = null;
      else active = true;
    }
    this.clampView();
    return active;
  }

  redraw() {
    if (!this.raf) this.raf = requestAnimationFrame((now) => this.frame(now));
  }

  frame(now) {
    this.raf = 0;
    const active = this.step(now);
    this.draw();
    if (active) {
      this.redraw();
    } else {
      this.lastStep = 0;
      if (this.mouse && !this.drag) this.checkHover();
    }
  }

  resize({ width, height }) {
    const dpr = window.devicePixelRatio || 1;
    this.w = width;
    this.h = height;
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(width * dpr));
    this.canvas.height = Math.max(1, Math.round(height * dpr));
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.textWidths.clear();
    if (this.layer) this.layer.dirty = true;
    if (!this.fitted && this.map && width > 0) {
      this.fitted = true;
      this.fit(true);
    }
    this.redraw();
  }

  // ── desenho ──

  draw() {
    const { ctx } = this;
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    ctx.fillStyle = MAP_BG;
    ctx.fillRect(0, 0, cw, ch);
    if (!this.map || !this.w) return;
    this.frameNo++;
    const s = this.scale * this.dpr; // px do canvas por px do mapa
    const ox = cw / 2 - this.cx * s;
    const oy = ch / 2 - this.cy * s;
    this.drawTiles(s, ox, oy, cw, ch);
    const size = this.markerSize();
    this.drawPoints(s, ox, oy, cw, ch, size);
    this.drawLabels(s, ox, oy, cw, ch);
    for (const i of new Set([this.selected, this.hovered])) if (i >= 0) this.drawMark(i, s, ox, oy, size);
    this.pruneTiles();
    this.events.frame();
  }

  tile(level, x, y) {
    const key = `${level}/${x}/${y}`;
    let tile = this.tiles.get(key);
    if (!tile) {
      tile = { img: new Image(), ready: false, failed: false, used: 0, level };
      const t = tile;
      t.img.decoding = "async";
      t.img.src = `${MAP_ASSETS}/maps/${this.map.key}/tiles/${key}.webp`;
      // decode() antes de desenhar: a imagem chega pronta e o quadro não trava.
      t.img.decode().then(
        () => {
          t.ready = true;
          this.redraw();
        },
        () => (t.failed = true),
      );
      this.tiles.set(key, tile);
    }
    tile.used = this.frameNo;
    return tile;
  }

  drawTiles(s, ox, oy, cw, ch) {
    const { size, maxZoom, tileSize } = this.map;
    // O nível com pelo menos 1 px da imagem por px da tela: nítido sem baixar à toa.
    const level = Math.max(0, Math.min(maxZoom, Math.ceil(maxZoom + Math.log2(s) - 0.15)));
    const span = tileSize * 2 ** (maxZoom - level);
    const step = span * s;
    const nx = Math.ceil(size[0] / span);
    const ny = Math.ceil(size[1] / span);
    const x0 = Math.max(0, Math.floor(-ox / step));
    const x1 = Math.min(nx - 1, Math.floor((cw - ox) / step));
    const y0 = Math.max(0, Math.floor(-oy / step));
    const y1 = Math.min(ny - 1, Math.floor((ch - oy) / step));
    if (x1 < x0 || y1 < y0) return;

    // Do centro para fora: os do meio são pedidos primeiro.
    const midX = (cw / 2 - ox) / step;
    const midY = (ch / 2 - oy) / step;
    const wanted = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) wanted.push([x, y, (x + 0.5 - midX) ** 2 + (y + 0.5 - midY) ** 2]);
    wanted.sort((a, b) => a[2] - b[2]);

    const { ctx } = this;
    for (const [x, y] of wanted) {
      // Bordas arredondadas para o px: sem risquinho entre os quadrados.
      const dx = Math.round(ox + x * step);
      const dy = Math.round(oy + y * step);
      const dw = Math.round(ox + (x + 1) * step) - dx;
      const dh = Math.round(oy + (y + 1) * step) - dy;
      const tile = this.tile(level, x, y);
      if (tile.ready) ctx.drawImage(tile.img, dx, dy, dw, dh);
      else this.drawAncestor(level, x, y, dx, dy, dw, dh);
    }
  }

  // O pedaço de um quadrado de nível mais baixo que já chegou, esticado.
  drawAncestor(level, x, y, dx, dy, dw, dh) {
    const tileSize = this.map.tileSize;
    for (let up = 1; up <= level; up++) {
      const tile = this.tiles.get(`${level - up}/${x >> up}/${y >> up}`);
      if (!tile?.ready) continue;
      tile.used = this.frameNo;
      const f = 2 ** up;
      const sub = tileSize / f;
      this.ctx.drawImage(tile.img, (x % f) * sub, (y % f) * sub, sub, sub, dx, dy, dw, dh);
      return;
    }
  }

  // Quadrados que saíram da tela: os que ainda vinham são cancelados, e só os
  // TILE_CACHE mais recentes ficam na memória. O nível 0 fica sempre.
  pruneTiles() {
    for (const [key, tile] of this.tiles) {
      if (tile.level === 0 || tile.used === this.frameNo || tile.ready || tile.failed) continue;
      tile.img.src = "";
      this.tiles.delete(key);
    }
    if (this.tiles.size <= TILE_CACHE) return;
    const old = [...this.tiles].filter(([, t]) => t.level > 0 && t.used !== this.frameNo).sort((a, b) => a[1].used - b[1].used);
    for (const [key] of old.slice(0, this.tiles.size - TILE_CACHE)) this.tiles.delete(key);
  }

  // O tamanho dos ícones: cresce com o zoom e com o tamanho do texto.
  markerSize() {
    const steps = this.z >= 0 ? 28 : this.z >= -1 ? 23 : this.z >= -2 ? 18 : this.z >= -3 ? 14 : 12;
    return Math.round(steps * this.textScale() * this.dpr);
  }

  textScale() {
    return parseFloat(getComputedStyle(document.documentElement).fontSize) / 15 || 1;
  }

  sprite(c, size) {
    const key = `${c}:${size}`;
    let sprite = this.sprites.get(key);
    if (sprite) return sprite;
    sprite = document.createElement("canvas");
    sprite.width = sprite.height = size;
    const g = sprite.getContext("2d");
    const icon = this.points.images[c];
    if (icon?.ready) {
      // Contorno escuro: ícone claro (o de elite é branco) continua visível
      // em cima das partes claras do mapa.
      const pad = Math.round(size * 0.08);
      g.shadowColor = "rgba(6, 8, 12, 0.95)";
      g.shadowBlur = Math.max(2, size * 0.1);
      g.drawImage(icon.img, pad, pad, size - 2 * pad, size - 2 * pad);
      g.drawImage(icon.img, pad, pad, size - 2 * pad, size - 2 * pad);
    } else {
      const cat = this.points.categories[c];
      g.beginPath();
      g.arc(size / 2, size / 2, size * 0.27, 0, Math.PI * 2);
      g.fillStyle = LAYER_COLORS[cat.id] ?? "#9ec5ff";
      g.fill();
      g.lineWidth = Math.max(1.5, size * 0.09);
      g.strokeStyle = "rgba(8, 10, 14, 0.9)";
      g.stroke();
    }
    this.sprites.set(key, sprite);
    return sprite;
  }

  // Os ícones de todas as camadas lado a lado numa imagem só, no tamanho do
  // zoom: copiar pedaços de uma imagem é bem mais rápido que de várias.
  sheet(size) {
    if (this.sheetCache?.size === size) return this.sheetCache.image;
    this.sheetCache?.image.close();
    const count = this.points.categories.length;
    const canvas = new OffscreenCanvas(size * count, size);
    const g = canvas.getContext("2d");
    for (let c = 0; c < count; c++) g.drawImage(this.sprite(c, size), c * size, 0);
    this.sheetCache = { size, image: canvas.transferToImageBitmap() };
    return this.sheetCache.image;
  }

  // Os pontos vêm da camada já desenhada. Ela é refeita quando os pontos
  // mudam, quando a tela sai de cima dela e quando o zoom para num valor novo.
  drawPoints(s, ox, oy, cw, ch, size) {
    if (!this.points) return;
    const zooming = !!(this.flight || this.zoomTo);
    let layer = this.layer;
    let k = layer ? 2 ** (this.z - layer.z) : 1;
    let lx = layer ? ox - layer.ox * k : 0;
    let ly = layer ? oy - layer.oy * k : 0;
    const covers = layer && lx <= 0 && ly <= 0 && lx + layer.canvas.width * k >= cw && ly + layer.canvas.height * k >= ch;
    const stale = !layer || layer.dirty || !covers || Math.abs(this.z - layer.z) > 0.5 || (!zooming && (layer.z !== this.z || layer.size !== size));
    if (stale) {
      layer = this.buildLayer(s, ox, oy, cw, ch, size);
      [k, lx, ly] = [1, ox - layer.ox, oy - layer.oy];
    }
    if (k === 1) this.ctx.drawImage(layer.canvas, Math.round(lx), Math.round(ly));
    else this.ctx.drawImage(layer.canvas, lx, ly, layer.canvas.width * k, layer.canvas.height * k);
  }

  // Desenha na camada os pontos que caem na tela mais uma margem de 25% de
  // cada lado, e guarda quais foram (para achar o ponto embaixo do mouse).
  buildLayer(s, ox, oy, cw, ch, size) {
    const p = this.points;
    const mx = Math.round(cw * 0.25);
    const my = Math.round(ch * 0.25);
    const width = cw + 2 * mx;
    const height = ch + 2 * my;
    let layer = this.layer;
    if (!layer || layer.canvas.width !== width || layer.canvas.height !== height || layer.indices.length !== p.n) {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      layer = this.layer = { canvas, ctx: canvas.getContext("2d"), indices: new Int32Array(p.n), count: 0 };
    } else {
      layer.ctx.clearRect(0, 0, width, height);
    }
    Object.assign(layer, { z: this.z, size, ox: ox + mx, oy: oy + my, dirty: false });

    const sheet = this.sheet(size);
    const half = size / 2;
    const { xs, ys, cat, tpl, visible, filter } = p;
    const { ctx, indices } = layer;
    const x0 = layer.ox;
    const y0 = layer.oy;
    let count = 0;
    for (let i = 0; i < p.n; i++) {
      const c = cat[i];
      if (filter ? !filter[tpl[i]] : !visible[c]) continue;
      const x = x0 + xs[i] * s;
      if (x < -half || x > width + half) continue;
      const y = y0 + ys[i] * s;
      if (y < -half || y > height + half) continue;
      ctx.drawImage(sheet, c * size, 0, size, size, Math.round(x - half), Math.round(y - half), size, size);
      indices[count++] = i;
    }
    layer.count = count;
    return layer;
  }

  // O ponto escolhido ou embaixo do mouse: maior e com um anel azul.
  drawMark(i, s, ox, oy, size) {
    const p = this.points;
    if (!p || i >= p.n) return;
    const { ctx, dpr } = this;
    const x = ox + p.xs[i] * s;
    const y = oy + p.ys[i] * s;
    const big = Math.round(size * 1.3);
    ctx.beginPath();
    ctx.arc(x, y, big * 0.55 + 3 * dpr, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(91, 157, 255, 0.28)";
    ctx.fill();
    ctx.lineWidth = 5 * dpr;
    ctx.strokeStyle = "rgba(6, 8, 12, 0.85)";
    ctx.stroke();
    ctx.lineWidth = 2.5 * dpr;
    ctx.strokeStyle = MAP_ACCENT;
    ctx.stroke();
    ctx.drawImage(this.sprite(p.cat[i], big), Math.round(x - big / 2), Math.round(y - big / 2));
  }

  // Largura de um texto na fonte atual, medida uma vez por tamanho.
  textWidth(text, px) {
    const key = `${px}|${text}`;
    let width = this.textWidths.get(key);
    if (width === undefined) {
      width = this.ctx.measureText(text).width;
      this.textWidths.set(key, width);
    }
    return width;
  }

  // Nome das áreas (e, de perto, dos lugares dentro delas): texto branco com
  // contorno escuro, que se lê em cima de qualquer parte do mapa. Um nome que
  // cairia em cima de outro fica de fora.
  drawLabels(s, ox, oy, cw, ch) {
    const { ctx, dpr } = this;
    const root = 15 * this.textScale() * dpr;
    const placed = [];
    const fits = (r) => !placed.some((o) => r[0] < o[2] && r[2] > o[0] && r[1] < o[3] && r[3] > o[1]);
    const family = '"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    this.labels = [];

    const write = (text, x, y, px) => {
      ctx.lineWidth = Math.max(3, px * 0.3);
      ctx.strokeStyle = "rgba(8, 10, 14, 0.92)";
      ctx.strokeText(text, x, y);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(text, x, y);
    };

    const big = Math.round(root * 0.82);
    ctx.font = `700 ${big}px ${family}`;
    for (const area of this.map.areas) {
      if (!area.anchor) continue;
      const x = ox + area.anchor[0] * s;
      const y = oy + area.anchor[1] * s;
      if (x < -200 * dpr || x > cw + 200 * dpr || y < -40 || y > ch + 40) continue;
      const text = area.name.toUpperCase();
      const half = this.textWidth(text, big) / 2;
      const rect = [x - half - 4 * dpr, y - big * 0.7, x + half + 4 * dpr, y + big * 0.7];
      if (!fits(rect)) continue;
      placed.push(rect);
      write(text, x, y, big);
      this.labels.push({ rect, area });
    }

    if (this.z < -1.2) return;
    const small = Math.round(root * 0.78);
    ctx.font = `600 ${small}px ${family}`;
    for (const area of this.map.areas) {
      for (const region of area.regions ?? []) {
        if (region.x == null || region.name === area.name) continue;
        const x = ox + region.x * s;
        const y = oy + region.y * s;
        if (x < -200 * dpr || x > cw + 200 * dpr || y < -40 || y > ch + 40) continue;
        const half = this.textWidth(region.name, small) / 2;
        const rect = [x - half - 3 * dpr, y - small * 0.7, x + half + 3 * dpr, y + small * 0.7];
        if (!fits(rect)) continue;
        placed.push(rect);
        write(region.name, x, y, small);
      }
    }
  }

  // ── mouse e teclado ──

  // O ponto embaixo de (mx, my), entre os desenhados na camada; o de cima ganha.
  pointAt(mx, my) {
    const layer = this.layer;
    const p = this.points;
    if (!layer || !p) return -1;
    const s = this.scale * this.dpr;
    const x = mx * this.dpr - (this.canvas.width / 2 - this.cx * s);
    const y = my * this.dpr - (this.canvas.height / 2 - this.cy * s);
    const radius = (layer.size * 2 ** (this.z - layer.z)) / 2 + 3 * this.dpr;
    let best = -1;
    let bestD = radius * radius;
    for (let k = layer.count - 1; k >= 0; k--) {
      const i = layer.indices[k];
      const dx = p.xs[i] * s - x;
      const dy = p.ys[i] * s - y;
      const d = dx * dx + dy * dy;
      if (d <= bestD) {
        bestD = d;
        best = i;
        if (d < 4) break;
      }
    }
    return best;
  }

  labelAt(mx, my) {
    const x = mx * this.dpr;
    const y = my * this.dpr;
    return this.labels.find(({ rect }) => x >= rect[0] && x <= rect[2] && y >= rect[1] && y <= rect[3])?.area ?? null;
  }

  checkHover() {
    this.hoverRaf = 0;
    if (!this.mouse || this.drag) return;
    const [mx, my] = this.mouse;
    const i = this.pointAt(mx, my);
    this.setHovered(i);
    if (i < 0) this.canvas.style.cursor = this.labelAt(mx, my) ? "pointer" : "";
  }

  onDown(e) {
    if (e.button !== 0) return;
    this.canvas.setPointerCapture(e.pointerId);
    this.drag = { x: e.clientX, y: e.clientY, t: e.timeStamp, moved: false, vx: 0, vy: 0 };
    this.flight = this.zoomTo = this.glide = null;
  }

  onMove(e) {
    this.mouse = [e.offsetX, e.offsetY];
    const drag = this.drag;
    if (!drag) {
      if (!this.hoverRaf && !this.raf) this.hoverRaf = requestAnimationFrame(() => this.checkHover());
      return;
    }
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved) {
      if (dx * dx + dy * dy < 16) return;
      drag.moved = true;
      this.canvas.style.cursor = "grabbing";
      this.setHovered(-1);
    }
    const s = this.scale;
    this.cx -= dx / s;
    this.cy -= dy / s;
    const dt = Math.max(1, e.timeStamp - drag.t);
    drag.vx = drag.vx * 0.6 + (dx / dt) * 0.4;
    drag.vy = drag.vy * 0.6 + (dy / dt) * 0.4;
    drag.x = e.clientX;
    drag.y = e.clientY;
    drag.t = e.timeStamp;
    this.clampView();
    this.redraw();
  }

  onUp(e) {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    this.canvas.style.cursor = "";
    if (!drag.moved) {
      const i = this.pointAt(e.offsetX, e.offsetY);
      if (i >= 0) return this.select(i);
      const area = this.labelAt(e.offsetX, e.offsetY);
      if (area) this.events.area(area);
      this.select(-1);
      return;
    }
    // Soltou ainda em movimento: o mapa desliza um pouco.
    if (!reducedMotion.matches && e.timeStamp - drag.t < 80 && Math.hypot(drag.vx, drag.vy) > 0.25) {
      this.glide = { vx: drag.vx, vy: drag.vy };
    }
    this.redraw();
  }

  onWheel(e) {
    // Ctrl + roda é o tamanho do texto do client inteiro.
    if (e.ctrlKey || !this.map) return;
    e.preventDefault();
    const delta = -e.deltaY * (e.deltaMode === 1 ? 0.12 : 0.004);
    this.zoomBy(Math.max(-0.7, Math.min(0.7, delta)), e.offsetX, e.offsetY);
  }

  onKey(e) {
    const pan = (dx, dy) => {
      this.flight = this.zoomTo = this.glide = null;
      this.cx += dx / this.scale;
      this.cy += dy / this.scale;
      this.clampView();
      this.redraw();
    };
    const keys = {
      "+": () => this.zoomBy(1),
      "=": () => this.zoomBy(1),
      "-": () => this.zoomBy(-1),
      0: () => this.fit(),
      Home: () => this.fit(),
      ArrowLeft: () => pan(-120, 0),
      ArrowRight: () => pan(120, 0),
      ArrowUp: () => pan(0, -120),
      ArrowDown: () => pan(0, 120),
      Escape: () => this.select(-1),
    };
    if (e.altKey || e.ctrlKey || !keys[e.key]) return;
    e.preventDefault();
    keys[e.key]();
  }

  // Onde um ponto está na tela, em px CSS.
  screenOf(i) {
    const p = this.points;
    const s = this.scale;
    return [(p.xs[i] - this.cx) * s + this.w / 2, (p.ys[i] - this.cy) * s + this.h / 2];
  }
}

// ── a página ───────────────────────────────────────────────

const atlas = {
  index: null,
  map: null,
  points: null,
  view: null,
  seq: 0,
  race: null,
};

function openMap() {
  show("map"); // client.js
  if (!atlas.view) startMap();
  else atlas.view.redraw();
}

function startMap() {
  atlas.view = new MapCanvas($("map-canvas"), {
    hover: () => placeMapTip(),
    select: () => placeMapTip(),
    area: (area) => flyToArea(area),
    frame: () => placeMapTip(),
  });
  $("map-zoom-in").addEventListener("click", () => atlas.view.zoomBy(1));
  $("map-zoom-out").addEventListener("click", () => atlas.view.zoomBy(-1));
  $("map-fit").addEventListener("click", () => atlas.view.fit());
  let typing = 0;
  $("map-search").addEventListener("input", () => {
    clearTimeout(typing);
    typing = setTimeout(renderMapSearch, 120);
  });
  $("map-search").addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    $("map-search").value = "";
    renderMapSearch();
  });
  loadMapIndex();
}

function mapBusy(on) {
  $("map-loading").replaceChildren(...(on ? [spinner("Carregando o mapa")] : []));
  $("map-loading").hidden = !on;
}

function mapError(message) {
  $("map-error").replaceChildren(el("h3", { text: "Não deu para abrir o mapa" }), el("p", { text: message }), el("button", { class: "button", text: "Tentar de novo", onclick: () => (atlas.index ? openMapKey(atlas.map.key) : loadMapIndex()) }));
  $("map-error").hidden = false;
}

async function loadMapIndex() {
  $("map-error").hidden = true;
  mapBusy(true);
  $("map-layers").replaceChildren(skeleton("map-sk", "map-sk", "map-sk", "map-sk"));
  try {
    atlas.index = readJson(await invoke("map_index"));
  } catch (error) {
    mapBusy(false);
    $("map-layers").replaceChildren();
    mapError(`${error}. O mapa precisa da internet na primeira vez; depois funciona sem ela.`);
    return;
  }
  const maps = atlas.index.maps;
  const saved = loadPref("map.key");
  const first = maps.find((m) => m.key === saved) ?? maps.find((m) => m.key === "verteron") ?? maps[0];
  openMapKey(first.key);
}

async function openMapKey(key) {
  const map = atlas.index.maps.find((m) => m.key === key);
  if (!map) return;
  const seq = ++atlas.seq;
  atlas.map = map;
  atlas.race = map.race;
  savePref("map.key", key);
  savePref(`map.key.${map.race}`, key);
  $("map-error").hidden = true;
  $("map-search").value = "";
  clearMapFilter();
  renderMapHead();
  atlas.view.setMap(map);
  atlas.points = null;
  atlas.view.setPoints(null);
  $("map-results").hidden = true;
  $("map-layers").hidden = false;
  $("map-layers").replaceChildren(skeleton("map-sk", "map-sk", "map-sk", "map-sk"));
  mapBusy(true);
  try {
    const data = readJson(await invoke("map_markers", { key, generated: atlas.index.generatedAt }));
    if (seq !== atlas.seq) return;
    atlas.points = buildPoints(data);
    atlas.view.setPoints(atlas.points);
    renderMapHead();
    renderLayers();
  } catch (error) {
    if (seq !== atlas.seq) return;
    $("map-layers").replaceChildren();
    mapError(`${error}`);
  } finally {
    if (seq === atlas.seq) mapBusy(false);
  }
}

// Os pontos em arrays tipados, já na ordem de desenho.
function buildPoints(data) {
  const categories = data.categories.map((cat) => ({ ...cat }));
  const catIndex = new Map(categories.map((cat, c) => [cat.id, c]));
  const templates = data.templates;
  const tplCat = new Uint8Array(templates.length);
  templates.forEach((t, i) => {
    let c = catIndex.get(t.c);
    if (c === undefined) {
      c = categories.length;
      categories.push({ id: t.c, label: t.c, group: "Objects", count: 0, on: false });
      catIndex.set(t.c, c);
    }
    tplCat[i] = c;
  });

  const raw = data.points;
  const n = raw.length;
  const xs = new Float32Array(n);
  const ys = new Float32Array(n);
  const tpl = new Uint16Array(n);
  const cat = new Uint8Array(n);
  const tplCount = new Uint32Array(templates.length);
  const depth = (point) => LAYER_DEPTH[categories[tplCat[point[0]]].group] ?? 1;
  const depths = [...new Set(Object.values(LAYER_DEPTH))].sort((a, b) => a - b);
  let k = 0;
  for (const d of depths) {
    for (const point of raw) {
      if (depth(point) !== d) continue;
      xs[k] = point[1];
      ys[k] = point[2];
      tpl[k] = point[0];
      cat[k] = tplCat[point[0]];
      tplCount[point[0]]++;
      k++;
    }
  }

  let saved = {};
  try {
    saved = JSON.parse(loadPref("map.layers") ?? "{}");
  } catch {
    // Escolhas estragadas: valem as do mapa.
  }
  const visible = new Uint8Array(categories.map((c) => ((saved[c.id] ?? c.on) ? 1 : 0)));
  const names = templates.map((t) => fold(`${t.n} ${t.e ?? ""}`));
  return { categories, templates, tplCat, n: k, xs, ys, tpl, cat, tplCount, names, visible, filter: null, images: [] };
}

function saveLayers() {
  const p = atlas.points;
  let saved = {};
  try {
    saved = JSON.parse(loadPref("map.layers") ?? "{}");
  } catch {
    saved = {};
  }
  p.categories.forEach((cat, c) => (saved[cat.id] = !!p.visible[c]));
  savePref("map.layers", JSON.stringify(saved));
}

// ── painel ─────────────────────────────────────────────────

// O mapa que abre ao trocar de facção: o último visto nela, ou o que tem mais
// áreas (Verteron, Altgard, Reshanta Inferior).
function raceMap(race) {
  const maps = atlas.index.maps.filter((m) => m.race === race);
  const saved = loadPref(`map.key.${race}`);
  if (maps.some((m) => m.key === saved)) return saved;
  return maps.reduce((best, m) => (m.areas.length > best.areas.length ? m : best)).key;
}

function renderMapHead() {
  const map = atlas.map;
  const race = MAP_RACES.find(([r]) => r === map.race)?.[1] ?? "";
  $("map-title").textContent = mapName(map);
  const parts = [race, `${map.areas.length} áreas`];
  if (atlas.points) parts.push(`${number(atlas.points.n)} pontos`);
  $("map-sub").textContent = parts.join(" · ");

  $("map-race").replaceChildren(
    ...MAP_RACES.filter(([r]) => atlas.index.maps.some((m) => m.race === r)).map(([r, label]) =>
      el("button", {
        class: "segment",
        role: "radio",
        "aria-checked": String(r === atlas.race),
        text: label,
        onclick: () => r !== atlas.map.race && openMapKey(raceMap(r)),
      }),
    ),
  );
  $("map-list").replaceChildren(
    ...atlas.index.maps
      .filter((m) => m.race === atlas.race)
      .map((m) =>
        el("button", {
          class: "map-chip",
          "aria-pressed": String(m.key === map.key),
          text: mapName(m),
          onclick: () => m.key !== atlas.map.key && openMapKey(m.key),
        }),
      ),
  );
}

function layerIcon(cat) {
  const url = layerIconUrl(cat.icon);
  if (!url) return el("span", { class: "map-dot", style: `--dot: ${LAYER_COLORS[cat.id] ?? "#9ec5ff"}`, "aria-hidden": "true" });
  const img = el("img", { class: "map-layer-icon", src: url, alt: "", loading: "lazy" });
  img.addEventListener("error", () => {
    const fallback = layerIconUrl(cat.fallback);
    if (fallback && img.src !== fallback) img.src = fallback;
    else img.replaceWith(el("span", { class: "map-dot", "aria-hidden": "true" }));
  });
  return img;
}

function renderLayers() {
  const p = atlas.points;
  const groups = new Map();
  p.categories.forEach((cat, c) => {
    if (!cat.count) return;
    if (!groups.has(cat.group)) groups.set(cat.group, []);
    groups.get(cat.group).push(c);
  });

  const setAll = (on) => {
    p.visible.fill(on ? 1 : 0);
    saveLayers();
    renderLayers();
    atlas.view.refreshPoints();
  };

  $("map-layers").replaceChildren(
    el(
      "div",
      { class: "map-layers-head" },
      el("span", { class: "map-label", text: "Camadas" }),
      el("button", { class: "link", text: "Todas", title: "Mostrar todas as camadas", onclick: () => setAll(true) }),
      el("button", { class: "link", text: "Nenhuma", title: "Esconder todas as camadas", onclick: () => setAll(false) }),
    ),
    ...[...groups].map(([group, list]) =>
      el(
        "section",
        { class: "map-group" },
        el("h3", {}, el("span", { text: LAYER_GROUPS[group] ?? group }), el("span", { class: "map-count", text: number(list.reduce((sum, c) => sum + p.categories[c].count, 0)) })),
        el("div", { class: "map-layer-list" }, ...list.map((c) => layerButton(c))),
      ),
    ),
  );
}

function layerButton(c) {
  const p = atlas.points;
  const cat = p.categories[c];
  const name = layerName(cat);
  const button = el(
    "button",
    { class: "map-layer", "aria-pressed": String(!!p.visible[c]), title: `${name}: ${number(cat.count)}` },
    el("span", { class: "map-check", "aria-hidden": "true" }),
    layerIcon(cat),
    el("span", { class: "map-layer-name", text: name }),
    el("span", { class: "map-count", text: number(cat.count) }),
  );
  button.addEventListener("click", () => {
    p.visible[c] ^= 1;
    button.setAttribute("aria-pressed", String(!!p.visible[c]));
    saveLayers();
    atlas.view.refreshPoints();
  });
  return button;
}

// ── busca ──────────────────────────────────────────────────

function renderMapSearch() {
  const query = fold($("map-search").value.trim());
  const box = $("map-results");
  if (!query) {
    box.hidden = true;
    $("map-layers").hidden = false;
    clearMapFilter();
    return;
  }
  $("map-layers").hidden = true;
  box.hidden = false;
  const p = atlas.points;
  const map = atlas.map;

  const areas = map.areas.filter((a) => [a.name, ...(a.subzones ?? []), ...(a.regions ?? []).map((r) => r.name)].some((name) => fold(name).includes(query))).slice(0, 8);

  // Pontos com o mesmo nome e camada viram uma linha só, com quantos são.
  const groups = new Map();
  if (p) {
    p.names.forEach((name, t) => {
      if (!name.includes(query) || !p.tplCount[t]) return;
      const key = `${p.tplCat[t]}|${p.templates[t].n}`;
      let group = groups.get(key);
      if (!group) {
        group = { c: p.tplCat[t], name: pointName(p, t), sub: p.templates[t].s, tpls: [], count: 0, starts: name.startsWith(query) };
        groups.set(key, group);
      }
      group.tpls.push(t);
      group.count += p.tplCount[t];
    });
  }
  const found = [...groups.values()].sort((a, b) => b.starts - a.starts || b.count - a.count || a.name.localeCompare(b.name, "pt-BR")).slice(0, 40);

  const out = [];
  if (areas.length) {
    out.push(el("span", { class: "map-label", text: "Áreas" }));
    for (const area of areas) {
      out.push(
        el(
          "button",
          { class: "map-result", onclick: () => flyToArea(area) },
          el("span", { class: "map-result-icon area", "aria-hidden": "true" }),
          el("span", { class: "map-result-text" }, el("b", { text: area.name }), el("small", { text: (area.subzones ?? []).filter((s) => s !== area.name).slice(0, 3).join(" · ") || "Área" })),
        ),
      );
    }
  }
  if (found.length) {
    out.push(el("span", { class: "map-label", text: "Pontos" }));
    for (const group of found) {
      const cat = p.categories[group.c];
      out.push(
        el(
          "button",
          { class: "map-result", onclick: () => showOnly(group) },
          layerIcon(cat),
          el("span", { class: "map-result-text" }, el("b", { text: group.name }), el("small", { text: subtitleText(group.sub) || layerName(cat) })),
          el("span", { class: "map-count", text: number(group.count) }),
        ),
      );
    }
  }
  if (!out.length) out.push(el("p", { class: "map-none", text: "Nada com esse nome neste mapa." }));
  box.replaceChildren(...out);
}

function flyToArea(area) {
  const view = atlas.view;
  if (area.bbox) {
    const [x0, y0, x1, y1] = area.bbox;
    view.flyToBounds(x0, y0, x1, y1, 0);
  } else if (area.anchor) {
    view.flyTo(area.anchor[0], area.anchor[1], Math.max(view.z, -1));
  }
}

// Só os pontos de uma linha da busca, mesmo de camadas escondidas.
function showOnly(group) {
  const p = atlas.points;
  p.filter = new Uint8Array(p.templates.length);
  for (const t of group.tpls) p.filter[t] = 1;
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  let only = -1;
  for (let i = 0; i < p.n; i++) {
    if (!p.filter[p.tpl[i]]) continue;
    only = only === -1 ? i : -2;
    x0 = Math.min(x0, p.xs[i]);
    y0 = Math.min(y0, p.ys[i]);
    x1 = Math.max(x1, p.xs[i]);
    y1 = Math.max(y1, p.ys[i]);
  }
  $("map-filter").replaceChildren(
    el("span", {}, "Só ", el("b", { text: group.name }), ` (${number(group.count)})`),
    el("button", { class: "map-filter-close", title: "Mostrar as camadas de novo", "aria-label": "Tirar o filtro", text: "✕", onclick: () => clearMapFilter() }),
  );
  $("map-filter").hidden = false;
  atlas.view.select(only >= 0 ? only : -1);
  if (x0 !== Infinity) atlas.view.flyToBounds(x0, y0, x1, y1, 0);
  atlas.view.refreshPoints();
}

function clearMapFilter() {
  $("map-filter").hidden = true;
  if (!atlas.points?.filter) return;
  atlas.points.filter = null;
  atlas.view.select(-1);
  atlas.view.refreshPoints();
}

// ── quadro do ponto ────────────────────────────────────────

let tipShown = -1;
let tipSize = [0, 0];

function placeMapTip() {
  const view = atlas.view;
  const tip = $("map-tip");
  const i = view.hovered >= 0 ? view.hovered : view.selected;
  const p = atlas.points;
  if (i < 0 || !p) {
    tip.hidden = true;
    tipShown = -1;
    return;
  }
  if (i !== tipShown) {
    const t = p.tpl[i];
    const template = p.templates[t];
    const cat = p.categories[p.cat[i]];
    const name = pointName(p, t);
    const lines = [el("b", { text: name }), el("span", { text: subtitleText(template.s) || layerName(cat) })];
    if (template.e && template.e !== name) lines.push(el("small", { text: template.e }));
    tip.replaceChildren(layerIcon(cat), el("span", { class: "map-tip-text" }, ...lines));
    tip.hidden = false;
    tipShown = i;
    // Medido uma vez por ponto: durante a animação só a posição muda.
    tipSize = [tip.offsetWidth, tip.offsetHeight];
  }
  const [x, y] = view.screenOf(i);
  if (x < -40 || y < -40 || x > view.w + 40 || y > view.h + 40) {
    tip.style.visibility = "hidden";
    return;
  }
  tip.style.visibility = "";
  // Em cima do ponto; perto do topo, embaixo.
  const [width, height] = tipSize;
  const below = y < height + 40;
  const gap = view.markerSize() / view.dpr / 2 + 10;
  const left = Math.min(view.w - width / 2 - 8, Math.max(width / 2 + 8, x));
  tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(below ? y + gap : y - gap)}px) translate(-50%, ${below ? "0" : "-100%"})`;
}
