//! Cada luta fica gravada quando termina (chefe, boneco de treino ou qualquer
//! outro alvo, `combats.rs`) e o client mostra de novo: jogadores, skills de
//! cada um, buffs, ping e o DPS no tempo.
//!
//! O registro da luta é o do motor (`FightRecord`, com cada skill, o
//! horário de cada golpe, o ping e os buffs), com os nomes de verdade no
//! lugar dos mascarados e o que ele não guarda: quem foi curado, quanto cada
//! um apanhou e se o chefe morreu. Fica no banco (`db.rs`).

use std::collections::{BTreeMap, HashMap};
use std::sync::OnceLock;

use motor::combat::data_storage::DataStorage;
use motor::combat::fight_buffs::BuffTrack;
use motor::entity::details_context::{DetailSkillEntry, TargetDetailsResponse};
use motor::entity::fight_record::FightRecord;
use serde::{Deserialize, Serialize};

use crate::live::{self, Fight, Row, class_key};

/// Versão do arquivo de cada luta.
const FORMAT: u32 = 1;
/// Ícones de skill e de buff: o mesmo endereço que o site oficial usa.
const ICONS: &str = "https://assets.playnccdn.com/static-aion2-gamedata/resources";
/// Média móvel do DPS no gráfico, em segundos: golpe a golpe a linha vira
/// serrote.
const SMOOTH_S: usize = 5;

/// Tipos de luta: contra chefe, no boneco de treino, ou contra qualquer outro
/// alvo (monstros comuns, a passagem inteira por uma dungeon).
pub const BOSS: &str = "boss";
pub const TRAIN: &str = "train";
pub const COMBAT: &str = "combat";

// ── dados do jogo ──────────────────────────────────────────────

/// Nome da dungeon pelo id da instância, com a dificuldade quando o motor
/// sabe ("Fire Temple · Difícil"). Os nomes só existem em inglês e coreano.
pub fn dungeon_name(id: i32) -> String {
    #[derive(Deserialize)]
    struct Entry {
        name: String,
        #[serde(default)]
        difficulty: Option<String>,
    }
    static DUNGEONS: OnceLock<HashMap<i32, Entry>> = OnceLock::new();
    let dungeons = DUNGEONS.get_or_init(|| {
        let raw: HashMap<String, Entry> = serde_json::from_str(crate::DUNGEON_NAMES).unwrap_or_default();
        raw.into_iter().filter_map(|(id, entry)| Some((id.parse().ok()?, entry))).collect()
    });
    let Some(entry) = dungeons.get(&id) else { return String::new() };
    let difficulty = match entry.difficulty.as_deref() {
        Some("normal") => "Normal",
        Some("hard") => "Difícil",
        Some("exploration") => "Exploração",
        _ => return entry.name.clone(),
    };
    format!("{} · {difficulty}", entry.name)
}

/// Endereço do ícone de uma skill, pela mesma regra do motor
/// (`public/src/js/skillIcons.js`). Vazio para ataque básico ou skill sem
/// ícone conhecido: a tela mostra um símbolo no lugar.
pub fn skill_icon(code: i32) -> String {
    static MAP: OnceLock<HashMap<String, String>> = OnceLock::new();
    let map = MAP.get_or_init(|| serde_json::from_str(crate::SKILL_ICONS).unwrap_or_default());

    let mut digits = code.to_string();
    if digits.len() < 8 {
        digits.extend(std::iter::repeat_n('0', 8 - digits.len()));
    }
    let digits = &digits[..8];

    // Pedra divina (theostone): a qualidade e o desenho vêm no código.
    if digits.starts_with("30") {
        return match digits[5..7].parse::<u32>() {
            Ok(icon) if icon > 0 => format!("{ICONS}/Icon_Item_Usable_Godstone_WP_r_{icon:03x}.png"),
            _ => String::new(),
        };
    }
    let class = &digits[..2];
    let is_basic = ("11"..="18").contains(&class) && &digits[2..6] == "0000" && &digits[6..] != "00";
    if is_basic || digits.starts_with("1000") || digits.starts_with("1699") {
        return String::new();
    }
    if let Some(name) = map.get(&digits[..4]) {
        return format!("{ICONS}/{name}.png");
    }
    let class_code = match class {
        "11" => "GL",
        "12" => "TE",
        "13" => "AS",
        "14" => "RA",
        "15" => "SO",
        "16" => "EL",
        "17" => "CL",
        "18" => "CH",
        "19" => "GT",
        _ => return String::new(),
    };
    match digits[2..4].parse::<u32>() {
        Ok(sub) => format!("{ICONS}/ICON_{class_code}_SKILL_{sub:03}.png"),
        Err(_) => String::new(),
    }
}

/// Nome de cada skill em português, pelo código.
fn skill_names() -> &'static HashMap<i64, String> {
    static NAMES: OnceLock<HashMap<i64, String>> = OnceLock::new();
    NAMES.get_or_init(|| {
        let raw: HashMap<String, String> = serde_json::from_str(crate::SKILL_NAMES).unwrap_or_default();
        raw.into_iter().filter_map(|(code, name)| Some((code.parse().ok()?, name))).collect()
    })
}

/// Nome de um buff ou debuff (`SkillAbnormal`) em português. Sem nome na
/// tabela, o da skill que o aplicou, ou o de uma skill da mesma família
/// (17150001 é um dos códigos de "Aura Divina", que a tabela tem como
/// 17150000), como o motor faz.
pub fn buff_name(id: u32, skill: u32) -> String {
    static NAMES: OnceLock<HashMap<u32, String>> = OnceLock::new();
    let names = NAMES.get_or_init(|| {
        let raw: HashMap<String, String> = serde_json::from_str(crate::ABNORMAL_NAMES).unwrap_or_default();
        raw.into_iter().filter_map(|(id, name)| Some((id.parse().ok()?, name))).collect()
    });
    if let Some(name) = names.get(&id).filter(|n| !n.trim().is_empty()) {
        return name.clone();
    }
    let skills = skill_names();
    let skill = i64::from(skill);
    if skill > 0 {
        if let Some(name) = skills.get(&skill) {
            return name.clone();
        }
        let base = skill / 100 * 100;
        for d in 1..100 {
            for code in [skill - d, skill + d] {
                if (base..base + 100).contains(&code) {
                    if let Some(name) = skills.get(&code) {
                        return name.clone();
                    }
                }
            }
        }
    }
    format!("Efeito {id}")
}

/// Ícones possíveis de um buff, do melhor para o pior: o do buff, o mesmo sem
/// o "_Buff" (alguns não estão no site) e o da skill que o aplicou.
pub fn buff_icons(id: u32, skill: u32) -> Vec<String> {
    #[derive(Deserialize)]
    struct Entry {
        #[serde(default)]
        icon: String,
    }
    #[derive(Deserialize)]
    struct Table {
        abnormals: HashMap<String, Entry>,
    }
    static ICON: OnceLock<HashMap<u32, String>> = OnceLock::new();
    let icons = ICON.get_or_init(|| {
        let Ok(table) = serde_json::from_str::<Table>(crate::ABNORMAL_ICONS) else { return HashMap::new() };
        table.abnormals.into_iter().filter_map(|(id, e)| Some((id.parse().ok()?, e.icon))).collect()
    });
    let mut out = Vec::new();
    if let Some(icon) = icons.get(&id).filter(|i| !i.is_empty() && i.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')) {
        out.push(format!("{ICONS}/{icon}.png"));
        let plain = icon.trim_end_matches("_Buff").trim_end_matches("_Debuff");
        if plain != icon {
            out.push(format!("{ICONS}/{plain}.png"));
        }
    }
    if skill > 0 {
        let by_skill = skill_icon(skill as i32);
        if !by_skill.is_empty() && !out.contains(&by_skill) {
            out.push(by_skill);
        }
    }
    out
}

// ── a luta como a tela mostra ──────────────────────────────────

/// Uma skill de um jogador. Os resultados de golpe são contagens, como o
/// motor guarda: a tela divide pelos golpes.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SkillView {
    pub code: i32,
    pub name: String,
    pub icon: String,
    /// Dano, ou cura numa skill de cura.
    pub amount: f64,
    pub hits: i64,
    /// Críticos ÷ golpes, em %. DoT e cura não critam.
    pub crit: Option<f64>,
    pub dot: bool,
    /// O maior e o menor golpe (0 sem golpe).
    pub max: f64,
    pub min: f64,
    pub crits: i64,
    /// Pelas costas e de frente.
    pub back: i64,
    pub frontal: i64,
    pub perfect: i64,
    pub double: i64,
    /// Golpes que o alvo aparou com a arma, bloqueou com escudo, bloqueou
    /// perfeito, segurou com Muralha de Ferro ou regenerou.
    pub parry: i64,
    pub block: i64,
    pub perfect_block: i64,
    pub iron_wall: i64,
    pub regeneration: i64,
    /// Erros e resistidos: não são golpes, só contam.
    pub miss: i64,
    pub resist: i64,
    /// Golpes que vieram com golpes extras (no máximo os golpes), e o dano
    /// desses extras.
    pub multi: i64,
    pub multi_damage: f64,
    /// Vida que a skill devolveu a quem bateu (dreno).
    pub drain: f64,
    /// Horário de cada golpe, em ms desde o começo da luta.
    pub times: Vec<i64>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PlayerView {
    #[serde(flatten)]
    pub row: Row,
    pub skills: Vec<SkillView>,
    pub heals: Vec<SkillView>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Series {
    pub name: String,
    pub job: String,
    pub values: Vec<f64>,
}

/// DPS segundo a segundo, em média móvel de `SMOOTH_S`. O motor guarda o
/// horário de cada golpe, mas não o dano de cada um: cada golpe vale a média
/// da skill dele.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Timeline {
    pub step_ms: i64,
    pub party: Vec<f64>,
    pub players: Vec<Series>,
    /// HP do chefe em % no fim de cada segundo; vazio fora de luta de chefe.
    pub hp: Vec<f64>,
}

/// O ping num momento da luta (ms desde o começo dela).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PingView {
    pub t: i64,
    pub ms: i32,
}

/// Um buff ou debuff numa pessoa (ou no alvo), de quem o lançou, com cada
/// vez que ficou ativo na luta.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BuffView {
    pub id: u32,
    pub name: String,
    pub icons: Vec<String>,
    /// Em quem: o nome do jogador; `on_target` quando é no alvo da luta.
    pub on: String,
    pub on_target: bool,
    /// Numa invocação do jogador, não nele.
    pub summon: bool,
    /// Quem lançou e a classe dele; `by_target` quando foi o próprio alvo.
    pub by: String,
    pub by_job: String,
    pub by_target: bool,
    /// Ligado a luta toda, sem tempo: passiva.
    pub passive: bool,
    /// Cada pedaço: [início, fim, acúmulos, como acabou], em ms desde o
    /// começo da luta (`fight_buffs::end_code` do motor).
    pub segs: Vec<[i64; 4]>,
    /// Tempo ativo dentro da luta, em ms.
    pub up: i64,
}

/// Os buffs de uma luta prontos para a tela. `who` diz o nome e a classe de
/// um id de jogador; o alvo é `target_id`.
pub fn buff_views(tracks: &[BuffTrack], target_id: i32, who: &dyn Fn(i32) -> Option<(String, String)>) -> Vec<BuffView> {
    tracks
        .iter()
        .map(|t| {
            let on_target = t.on == target_id;
            let by_target = t.by != 0 && t.by == target_id;
            let (on, _) = if on_target { (String::new(), String::new()) } else { who(t.on).unwrap_or_else(|| (t.on.to_string(), String::new())) };
            let (by, by_job) = if by_target || t.by == 0 { (String::new(), String::new()) } else { who(t.by).unwrap_or_default() };
            BuffView {
                id: t.id,
                name: buff_name(t.id, t.skill),
                icons: buff_icons(t.id, t.skill),
                on,
                on_target,
                summon: t.summon,
                by,
                by_job,
                by_target,
                passive: t.passive,
                segs: t.segments().iter().map(|s| [s.start, s.end, i64::from(s.stacks), i64::from(s.how)]).collect(),
                up: t.up,
            }
        })
        .collect()
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FightView {
    /// Vazio na luta ao vivo.
    pub id: String,
    pub boss: String,
    pub mob_code: i32,
    pub dungeon_id: i32,
    pub dungeon: String,
    /// Relógio do Windows, em ms desde 1970.
    pub start_ms: i64,
    pub duration_ms: i64,
    pub killed: bool,
    pub train: bool,
    /// `BOSS`, `TRAIN` ou `COMBAT`.
    pub kind: String,
    /// Alvos na luta e quantos deles morreram.
    pub targets: u32,
    pub kills: u32,
    pub max_hp: i64,
    pub total_damage: f64,
    pub party_dps: f64,
    pub peak_dps: f64,
    pub low_dps: f64,
    pub heal: f64,
    pub taken: f64,
    pub players: Vec<PlayerView>,
    pub timeline: Timeline,
    pub ping: Vec<PingView>,
    /// Nada numa luta gravada antes de o meter guardar os buffs.
    pub buffs: Option<Vec<BuffView>>,
}

/// O que não vem dos detalhes do motor.
pub struct Meta {
    pub id: String,
    pub boss: String,
    pub mob_code: i32,
    pub dungeon_id: i32,
    pub start_ms: i64,
    pub duration_ms: i64,
    pub killed: bool,
    pub train: bool,
    pub kind: String,
    pub targets: u32,
    pub kills: u32,
    pub max_hp: i64,
    pub buffs: Option<Vec<BuffView>>,
}

/// Junta as skills de mesmo código de um jogador (um chefe com várias partes
/// tem um registro por parte) e põe a maior primeiro. Cada registro vem com o
/// quanto somar aos horários dos golpes para contar do começo da luta.
fn skills_by_player(
    entries: &[(i64, &DetailSkillEntry)],
    name_of: &dyn Fn(i32) -> String,
    heal: bool,
) -> HashMap<String, Vec<SkillView>> {
    let mut merged: HashMap<(String, i32, bool), SkillView> = HashMap::new();
    for &(offset, entry) in entries.iter().filter(|(_, e)| e.dmg > 0) {
        let key = (name_of(entry.actor_id), entry.code, entry.is_dot);
        let skill = merged.entry(key).or_insert_with(|| SkillView {
            code: entry.code,
            name: if entry.name.is_empty() { format!("Skill {}", entry.code) } else { entry.name.clone() },
            icon: skill_icon(entry.code),
            dot: entry.is_dot,
            ..SkillView::default()
        });
        skill.amount += f64::from(entry.dmg);
        skill.hits += i64::from(entry.time);
        skill.max = skill.max.max(f64::from(entry.max_dmg));
        if entry.min_dmg > 0 {
            let min = f64::from(entry.min_dmg);
            skill.min = if skill.min > 0.0 { skill.min.min(min) } else { min };
        }
        skill.crits += i64::from(entry.crit);
        skill.back += i64::from(entry.back);
        skill.frontal += i64::from(entry.frontal);
        skill.perfect += i64::from(entry.perfect);
        skill.double += i64::from(entry.double);
        skill.parry += i64::from(entry.parry);
        skill.block += i64::from(entry.shield_block);
        skill.perfect_block += i64::from(entry.perfect_block);
        skill.iron_wall += i64::from(entry.iron_wall);
        skill.regeneration += i64::from(entry.regeneration);
        skill.miss += i64::from(entry.miss);
        skill.resist += i64::from(entry.resist);
        skill.multi += i64::from(entry.multi_hit_count);
        skill.multi_damage += f64::from(entry.multi_hit_damage);
        skill.drain += f64::from(entry.regen);
        skill.times.extend(entry.hit_timestamps.iter().map(|t| t + offset));
    }
    let mut out: HashMap<String, Vec<SkillView>> = HashMap::new();
    for ((name, _, _), mut skill) in merged {
        if !heal && !skill.dot && skill.hits > 0 {
            skill.crit = Some(skill.crits as f64 / skill.hits as f64 * 100.0);
        }
        skill.times.sort_unstable();
        out.entry(name).or_default().push(skill);
    }
    for skills in out.values_mut() {
        skills.sort_by(|a, b| b.amount.total_cmp(&a.amount));
    }
    out
}

/// Média móvel centrada, em dano por segundo.
fn smooth(raw: &[f64]) -> Vec<f64> {
    let half = SMOOTH_S / 2;
    (0..raw.len())
        .map(|i| {
            let from = i.saturating_sub(half);
            let to = (i + half + 1).min(raw.len());
            raw[from..to].iter().sum::<f64>() / (to - from) as f64
        })
        .collect()
}

/// O começo da luta: o primeiro alvo atingido.
fn fight_start(targets: &[TargetDetailsResponse]) -> Option<i64> {
    targets.iter().map(|t| t.start_time).min()
}

/// O HP do chefe a cada segundo, em %, do dano que ele levou. Começa cheio e
/// chega a zero se ele morreu; vivo, cai só o que o dano tirou do HP máximo.
fn boss_hp(party_raw: &[f64], max_hp: f64, killed: bool) -> Vec<f64> {
    let total: f64 = party_raw.iter().sum();
    let base = if killed || max_hp <= 0.0 { total } else { max_hp.max(total) };
    if base <= 0.0 {
        return Vec::new();
    }
    let mut dealt = 0.0;
    party_raw
        .iter()
        .map(|d| {
            dealt += d;
            ((1.0 - dealt / base) * 100.0).clamp(0.0, 100.0)
        })
        .collect()
}

fn timeline(
    targets: &[TargetDetailsResponse],
    players: &[PlayerView],
    duration_ms: i64,
    name_of: &dyn Fn(i32) -> String,
    hp: Option<(f64, bool)>,
) -> Timeline {
    let Some(start) = fight_start(targets) else { return Timeline::default() };
    let seconds = (duration_ms.max(0) / 1000 + 1) as usize;
    let index: HashMap<&str, usize> = players.iter().enumerate().map(|(i, p)| (p.row.name.as_str(), i)).collect();
    let mut raw = vec![vec![0.0; seconds]; players.len()];
    for target in targets {
        let offset = target.start_time - start;
        for skill in target.skills.iter().filter(|s| s.time > 0 && s.dmg > 0) {
            let Some(&player) = index.get(name_of(skill.actor_id).as_str()) else { continue };
            let per_hit = f64::from(skill.dmg) / f64::from(skill.time);
            for &at in &skill.hit_timestamps {
                let second = ((offset + at).max(0) / 1000) as usize;
                if let Some(slot) = raw[player].get_mut(second) {
                    *slot += per_hit;
                }
            }
        }
    }
    let party: Vec<f64> = (0..seconds).map(|s| raw.iter().map(|p| p[s]).sum()).collect();
    Timeline {
        step_ms: 1000,
        hp: hp.map(|(max_hp, killed)| boss_hp(&party, max_hp, killed)).unwrap_or_default(),
        party: smooth(&party),
        players: players
            .iter()
            .zip(&raw)
            .filter(|(p, _)| p.row.damage > 0.0)
            .map(|(p, values)| Series { name: p.row.name.clone(), job: p.row.job.clone(), values: smooth(values) })
            .collect(),
    }
}

/// O ping da luta, contado do começo dela. Alvos da mesma luta repetem as
/// mesmas medidas: ficam uma vez só.
fn ping_of(targets: &[TargetDetailsResponse]) -> Vec<PingView> {
    let Some(start) = fight_start(targets) else { return Vec::new() };
    let mut out: Vec<PingView> = targets
        .iter()
        .flat_map(|t| t.ping_history.iter().map(move |p| PingView { t: p.ts_ms + t.start_time - start, ms: p.ping_ms }))
        .collect();
    out.sort_by_key(|p| p.t);
    out.dedup();
    out
}

/// Pico e vale do DPS do grupo. As pontas ficam de fora do vale: no começo e
/// no fim a média móvel pega segundos sem luta.
fn peak_and_low(party: &[f64]) -> (f64, f64) {
    let peak = party.iter().copied().fold(0.0, f64::max);
    let middle = if party.len() > 4 * SMOOTH_S { &party[SMOOTH_S..party.len() - SMOOTH_S] } else { party };
    let low = middle.iter().copied().fold(f64::INFINITY, f64::min);
    (peak, if low.is_finite() { low } else { 0.0 })
}

/// A luta pronta para a tela, com as linhas que se tem e as skills dos
/// detalhes do motor.
pub fn build(meta: Meta, rows: Vec<Row>, targets: &[TargetDetailsResponse], name_of: &dyn Fn(i32) -> String) -> FightView {
    let start = fight_start(targets).unwrap_or(0);
    let damage: Vec<(i64, &DetailSkillEntry)> =
        targets.iter().flat_map(|t| t.skills.iter().map(move |s| (t.start_time - start, s))).collect();
    let heal: Vec<(i64, &DetailSkillEntry)> =
        targets.iter().flat_map(|t| t.heal_skills.iter().map(move |s| (t.start_time - start, s))).collect();
    let mut skills = skills_by_player(&damage, name_of, false);
    let mut heals = skills_by_player(&heal, name_of, true);
    let players: Vec<PlayerView> = rows
        .into_iter()
        .map(|row| PlayerView {
            skills: skills.remove(&row.name).unwrap_or_default(),
            heals: heals.remove(&row.name).unwrap_or_default(),
            row,
        })
        .collect();

    // A linha do HP só numa luta contra um chefe só.
    let hp = (meta.kind == BOSS && targets.len() == 1).then_some((meta.max_hp as f64, meta.killed));
    let timeline = timeline(targets, &players, meta.duration_ms, name_of, hp);
    let (peak_dps, low_dps) = peak_and_low(&timeline.party);
    let total_damage: f64 = players.iter().map(|p| p.row.damage).sum();
    let seconds = meta.duration_ms as f64 / 1000.0;
    FightView {
        dungeon: dungeon_name(meta.dungeon_id),
        id: meta.id,
        boss: meta.boss,
        mob_code: meta.mob_code,
        dungeon_id: meta.dungeon_id,
        start_ms: meta.start_ms,
        duration_ms: meta.duration_ms,
        killed: meta.killed,
        train: meta.train,
        kind: meta.kind,
        targets: meta.targets,
        kills: meta.kills,
        max_hp: meta.max_hp,
        total_damage,
        party_dps: if seconds > 0.0 { total_damage / seconds } else { 0.0 },
        peak_dps,
        low_dps,
        heal: players.iter().map(|p| p.row.heal).sum(),
        taken: players.iter().map(|p| p.row.taken).sum(),
        players,
        timeline,
        ping: ping_of(targets),
        buffs: meta.buffs,
    }
}

// ── luta gravada ───────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Extra {
    /// O chefe morreu (ou o HP dele zerou); numa luta comum, todos os alvos.
    pub killed: bool,
    /// O seu personagem.
    pub me: String,
    /// Cura recebida, por nome.
    pub healed: BTreeMap<String, i64>,
    /// Dano levado deste alvo, por nome.
    pub taken: BTreeMap<String, i64>,
    /// `BOSS`, `TRAIN` ou `COMBAT`; vazio nas lutas gravadas antes de haver
    /// lutas comuns (chefe ou boneco, pelo registro).
    pub kind: String,
    /// Alvos numa luta comum e quantos morreram.
    pub targets: u32,
    pub kills: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SavedFight {
    pub format: u32,
    pub record: FightRecord,
    #[serde(default)]
    pub extra: Extra,
}

/// A linha de um nome numa luta gravada, criada vazia na primeira vez.
fn row_of<'a>(rows: &'a mut HashMap<String, Row>, name: &str, me: &str) -> &'a mut Row {
    rows.entry(name.to_string()).or_insert_with(|| Row::empty(0, name, !me.is_empty() && name == me))
}

fn my_name(storage: &DataStorage) -> String {
    storage
        .local_character_name()
        .or_else(|| {
            let id = i32::try_from(storage.local_player_id()?).ok()?;
            storage.get_nicknames().get(&id).cloned()
        })
        .unwrap_or_default()
}

/// Um alvo que morreu, ou cujo HP zerou.
pub fn is_dead(storage: &DataStorage, target: i32) -> bool {
    storage.is_entity_dead(target) || storage.get_mob_current_hp(target) == Some(0)
}

impl SavedFight {
    /// Um registro de chefe ou boneco do motor, com o que mais se sabe
    /// agora sobre a luta.
    pub fn new(storage: &DataStorage, record: FightRecord) -> Self {
        let kind = if record.is_train { TRAIN } else { BOSS };
        let target = record.target_id;
        Self::of_targets(storage, record, &[target], kind)
    }

    /// Um registro que junta `targets` (uma luta comum, `combats.rs`), ou de
    /// um alvo só.
    pub fn of_targets(storage: &DataStorage, mut record: FightRecord, targets: &[i32], kind: &str) -> Self {
        let fight = Fight::of_targets(storage, targets);
        // O motor mascara o nome dos outros ("Ka**h") porque os registros
        // dele podem ir para o site. Estes ficam só neste PC.
        for actor in &mut record.actors {
            if let Some((_, name)) = fight.player_of(actor.actor_id).filter(|(_, n)| !n.chars().all(|c| c.is_ascii_digit())) {
                actor.nickname = name;
            }
        }
        let by_name = |tallies: HashMap<i32, live::Tally>| -> BTreeMap<String, i64> {
            let mut out = BTreeMap::new();
            for tally in tallies.into_values() {
                *out.entry(tally.name).or_default() += tally.amount as i64;
            }
            out
        };
        let kills = targets.iter().filter(|&&t| is_dead(storage, t)).count() as u32;
        let killed = if kind == BOSS {
            let max_hp = i64::from(record.details.max_hp);
            is_dead(storage, record.target_id) || (max_hp > 0 && i64::from(record.total_damage) * 100 >= max_hp * 99)
        } else {
            kind == COMBAT && kills > 0 && kills as usize == targets.len()
        };
        let extra = Extra {
            killed,
            me: my_name(storage),
            healed: by_name(live::heal_received_by_player(storage, &fight)),
            taken: by_name(live::taken_by_player(&fight)),
            kind: kind.to_string(),
            targets: targets.len() as u32,
            kills,
        };
        Self { format: FORMAT, record, extra }
    }

    pub fn kind(&self) -> &str {
        match self.extra.kind.as_str() {
            "" if self.record.is_train => TRAIN,
            "" => BOSS,
            kind => kind,
        }
    }

    pub fn view(&self) -> FightView {
        let record = &self.record;
        let names: HashMap<i32, &str> = record.actors.iter().map(|a| (a.actor_id, a.nickname.as_str())).collect();
        let name_of = |id: i32| names.get(&id).map_or_else(|| id.to_string(), |n| n.to_string());
        let seconds = record.duration_ms as f64 / 1000.0;

        // Uma linha por nome, como no overlay: dano e crítico das skills, cura
        // das skills de cura, e o resto do que foi gravado à parte.
        let mut rows: HashMap<String, Row> = HashMap::new();
        let mut crits: HashMap<String, (i64, i64)> = HashMap::new();
        let me = self.extra.me.as_str();
        for skill in &record.details.skills {
            let name = name_of(skill.actor_id);
            let r = row_of(&mut rows, &name, me);
            r.id = skill.actor_id;
            r.damage += f64::from(skill.dmg);
            if r.job.is_empty() {
                r.job = class_key(&skill.job).to_string();
            }
            if !skill.is_dot {
                let (hits, c) = crits.entry(name).or_default();
                *hits += i64::from(skill.time);
                *c += i64::from(skill.crit);
            }
        }
        for skill in record.details.heal_skills.iter().filter(|s| s.dmg > 0) {
            let name = name_of(skill.actor_id);
            // Monstros que se curam não são linha.
            if !rows.contains_key(&name) && !record.actors.iter().any(|a| a.nickname == name) {
                continue;
            }
            row_of(&mut rows, &name, me).heal += f64::from(skill.dmg);
        }
        for (name, &amount) in &self.extra.healed {
            row_of(&mut rows, name, me).healed = amount as f64;
        }
        for (name, &amount) in &self.extra.taken {
            row_of(&mut rows, name, me).taken = amount as f64;
        }
        // Classe, nível, nível de item e poder de combate de quem estava no
        // grupo, como o jogo mandou no dia.
        for actor in &record.actors {
            if let Some(r) = rows.get_mut(&actor.nickname) {
                if r.job.is_empty() {
                    r.job = class_key(&actor.job).to_string();
                }
                r.level = r.level.max(actor.level);
                r.gear = r.gear.max(actor.gear_score);
                r.power = r.power.max(actor.combat_power);
            }
        }
        let total: f64 = rows.values().map(|r| r.damage).sum();
        let mut rows: Vec<Row> = rows
            .into_values()
            .map(|mut r| {
                if seconds > 0.0 {
                    r.dps = r.damage / seconds;
                }
                if total > 0.0 {
                    r.share = r.damage / total * 100.0;
                }
                r.crit = crits.get(&r.name).filter(|(hits, _)| *hits > 0).map(|(hits, c)| *c as f64 / *hits as f64 * 100.0);
                r
            })
            .collect();
        rows.sort_by(|a, b| b.dps.total_cmp(&a.dps).then(b.heal.total_cmp(&a.heal)).then(b.taken.total_cmp(&a.taken)));

        let jobs: HashMap<&str, String> = rows.iter().map(|r| (r.name.as_str(), r.job.clone())).collect();
        let who = |id: i32| -> Option<(String, String)> {
            let name: &str = names.get(&id)?;
            Some((name.to_string(), jobs.get(name).cloned().unwrap_or_default()))
        };
        let buffs = record.buffs.as_ref().map(|tracks| buff_views(tracks, record.target_id, &who));
        let kind = self.kind().to_string();
        let meta = Meta {
            id: record.id.clone(),
            boss: record.boss_name.clone(),
            mob_code: record.mob_code,
            dungeon_id: record.dungeon_id,
            start_ms: record.start_time_ms,
            duration_ms: record.duration_ms,
            killed: self.extra.killed,
            train: record.is_train,
            targets: self.extra.targets.max(1),
            kills: if kind == COMBAT { self.extra.kills } else { u32::from(self.extra.killed) },
            kind,
            max_hp: i64::from(record.details.max_hp),
            buffs,
        };
        build(meta, rows, std::slice::from_ref(&record.details), &name_of)
    }
}

/// Uma linha do histórico.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub id: String,
    pub boss: String,
    pub mob_code: i32,
    pub dungeon_id: i32,
    pub dungeon: String,
    pub start_ms: i64,
    pub duration_ms: i64,
    pub total_damage: f64,
    pub party_dps: f64,
    pub killed: bool,
    pub train: bool,
    /// `BOSS`, `TRAIN` ou `COMBAT`.
    pub kind: String,
    pub targets: u32,
    pub kills: u32,
    /// O seu personagem, o seu DPS e a sua classe nesta luta.
    pub me: String,
    pub my_dps: f64,
    pub my_job: String,
    /// A classe de cada jogador, do maior DPS ao menor.
    pub jobs: Vec<String>,
    /// Ainda tem os detalhes; as lutas mais antigas ficam só com o resumo.
    pub detailed: bool,
}

impl Summary {
    pub fn of(view: &FightView) -> Self {
        let me = view.players.iter().find(|p| p.row.me);
        Self {
            id: view.id.clone(),
            boss: view.boss.clone(),
            mob_code: view.mob_code,
            dungeon_id: view.dungeon_id,
            dungeon: view.dungeon.clone(),
            start_ms: view.start_ms,
            duration_ms: view.duration_ms,
            total_damage: view.total_damage,
            party_dps: view.party_dps,
            killed: view.killed,
            train: view.train,
            kind: view.kind.clone(),
            targets: view.targets,
            kills: view.kills,
            me: me.map(|p| p.row.name.clone()).unwrap_or_default(),
            my_dps: me.map_or(0.0, |p| p.row.dps),
            my_job: me.map(|p| p.row.job.clone()).unwrap_or_default(),
            jobs: view.players.iter().filter(|p| p.row.damage > 0.0 && !p.row.job.is_empty()).map(|p| p.row.job.clone()).collect(),
            detailed: true,
        }
    }
}
