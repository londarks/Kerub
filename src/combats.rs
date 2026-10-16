//! As lutas que não são contra chefe nem no boneco: monstros comuns, uma
//! masmorra diária, uma missão. O motor só grava as de chefe; aqui fica o
//! resto, para nenhum dano se perder quando a tela passa para outro alvo.
//!
//! Os alvos em que você ou o seu grupo bateram são juntados em blocos. Numa
//! dungeon, a passagem inteira, do primeiro ao último golpe e com os chefes
//! (a luta de cada chefe continua gravada à parte); fora dela, os golpes com
//! até `GAP_OPEN_MS` de intervalo, sem os chefes, que já têm a luta deles.
//! Cada bloco vira um registro como o de um chefe, com todos os alvos juntos.

use std::collections::{HashMap, HashSet};

use motor::combat::data_storage::{DataStorage, TargetCombatData};
use motor::combat::dps_calculator::DpsCalculator;
use motor::combat::fight_buffs;
use motor::combat::ping_tracker::PingTracker;
use motor::entity::details_context::{DetailSkillEntry, DetailsActorSummary, PingPoint, TargetDetailsResponse};
use motor::entity::fight_record::{APP_VERSION, FightRecord};
use motor::entity::job_class::JobClass;
use motor::entity::summon_resolver;
use motor::i18n::lookup::{NpcLookup, SkillLookup};

use crate::history::{self, SavedFight};

/// Fora de dungeon, mais que isso sem bater em nada começa outra luta.
const GAP_OPEN_MS: i64 = 60_000;
/// Numa dungeon a passagem só se divide numa pausa bem longa: trocar de zona
/// já separa uma passagem da outra.
const GAP_DUNGEON_MS: i64 = 10 * 60_000;
/// Uma luta comum fora de dungeon não passa disso: farmando sem parar, cada
/// 10 minutos viram uma luta.
const MAX_OPEN_MS: i64 = 10 * 60_000;
/// Numa dungeon, uma passagem bem longa também se divide.
const MAX_DUNGEON_MS: i64 = 60 * 60_000;
/// Lutas mais curtas que isso não ficam.
const MIN_MS: i64 = 5_000;
/// Uma luta que ainda não acabou é gravada a primeira vez com essa duração.
const FIRST_SAVE_MS: i64 = 15_000;
/// E de novo neste intervalo, enquanto continua.
const RESAVE_MS: i64 = 60_000;

/// Alvos que viraram um bloco, do primeiro ao último golpe.
#[derive(Debug, PartialEq)]
pub struct Block {
    pub targets: Vec<i32>,
    pub start: i64,
    pub end: i64,
}

/// Junta os alvos `(id, primeiro golpe, último golpe)` em blocos: um alvo
/// atingido até `gap` depois do último golpe do bloco entra nele, se o bloco
/// ainda não tem `max` de duração.
pub fn blocks(mut targets: Vec<(i32, i64, i64)>, gap: i64, max: i64) -> Vec<Block> {
    targets.sort_by_key(|&(id, first, _)| (first, id));
    let mut out: Vec<Block> = Vec::new();
    for (id, first, last) in targets {
        match out.last_mut() {
            Some(block) if first <= block.end + gap && first - block.start < max => {
                block.targets.push(id);
                block.end = block.end.max(last);
            }
            _ => out.push(Block { targets: vec![id], start: first, end: last }),
        }
    }
    out
}

/// O que já foi gravado: o começo de cada bloco, com o último golpe gravado e
/// a hora da gravação; e os detalhes de cada alvo, com o último golpe dele,
/// para não montar de novo, a cada gravação, os alvos que já acabaram.
#[derive(Default)]
pub struct Combats {
    saved: HashMap<i64, (i64, i64)>,
    details: HashMap<i32, (i64, TargetDetailsResponse)>,
}

/// Quem é "nós": você, as suas invocações e o seu grupo.
struct Us {
    ids: HashSet<i32>,
    party: HashSet<String>,
    nicknames: HashMap<i32, String>,
    summons: HashMap<i32, i32>,
}

impl Us {
    fn load(storage: &DataStorage) -> Self {
        let summons = storage.get_summon_data();
        let mut ids = HashSet::new();
        if let Some(local) = storage.local_player_id().and_then(|id| i32::try_from(id).ok()) {
            ids.insert(local);
            ids.extend(summons.keys().copied().filter(|&s| summon_resolver::resolve(s, &summons) == local));
        }
        Self { ids, party: storage.get_party_members().into_keys().collect(), nicknames: storage.get_nicknames(), summons }
    }

    fn known(&self) -> bool {
        !self.ids.is_empty() || !self.party.is_empty()
    }

    /// Você ou alguém do grupo bateu neste alvo.
    fn hit(&self, target: &TargetCombatData) -> bool {
        target.actors.keys().any(|&actor| {
            let owner = summon_resolver::resolve(actor, &self.summons);
            self.ids.contains(&actor)
                || self.ids.contains(&owner)
                || self.nicknames.get(&owner).is_some_and(|name| self.party.contains(name))
        })
    }

    /// O nome de um id, como o motor resolve.
    fn name(&self, id: i32) -> String {
        self.nicknames
            .get(&id)
            .or_else(|| self.nicknames.get(&summon_resolver::resolve(id, &self.summons)))
            .cloned()
            .unwrap_or_else(|| id.to_string())
    }
}

impl Combats {
    /// As lutas comuns para gravar agora: as que acabaram, e as longas que
    /// ainda estão rolando de minuto em minuto. `force` grava todas, antes de
    /// os dados sumirem (zerar, trocar de zona, fechar o meter).
    #[allow(clippy::too_many_arguments)]
    pub fn snapshot(
        &mut self,
        storage: &DataStorage,
        calc: &DpsCalculator,
        npcs: &NpcLookup,
        skills: &SkillLookup,
        ping: &PingTracker,
        force: bool,
        now: i64,
    ) -> Vec<SavedFight> {
        let us = Us::load(storage);
        let dungeon = storage.current_dungeon_id() > 0;
        // Fora de dungeon, sem saber quem você é, não dá para separar as suas
        // lutas das de quem passa do lado.
        if !dungeon && !us.known() {
            return Vec::new();
        }
        let (gap, max) = if dungeon { (GAP_DUNGEON_MS, MAX_DUNGEON_MS) } else { (GAP_OPEN_MS, MAX_OPEN_MS) };
        let combat = storage.get_combat_snapshot_light();
        let candidates: Vec<(i32, i64, i64)> = combat
            .values()
            .filter(|t| t.total_damage > 0)
            .filter(|t| {
                let code = storage.mob_code(t.target_id);
                let dummy = code.map_or_else(|| storage.is_hp_reset_dummy(t.target_id), |c| npcs.is_training_dummy(c));
                let boss = code.is_some_and(|c| npcs.is_boss(c));
                // Numa instância só tem o seu grupo: tudo é seu.
                !dummy && (dungeon || (!boss && us.hit(t)))
            })
            .map(|t| (t.target_id, t.first_damage_time, t.last_damage_time))
            .collect();

        // Detalhes de alvo que saiu da memória (zerou, trocou de zona) não
        // servem mais.
        self.details.retain(|id, _| combat.contains_key(id));
        let mut out = Vec::new();
        for block in blocks(candidates, gap, max) {
            if block.end - block.start < MIN_MS {
                continue;
            }
            let ended = now - block.end >= gap;
            match self.saved.get(&block.start) {
                Some(&(end, _)) if end >= block.end => continue,
                Some(&(_, at)) if !force && !ended && now - at < RESAVE_MS => continue,
                None if !force && !ended && block.end - block.start < FIRST_SAVE_MS => continue,
                _ => {}
            }
            let details: Vec<TargetDetailsResponse> = block
                .targets
                .iter()
                .map(|&t| {
                    let last = combat.get(&t).map_or(0, |c| c.last_damage_time);
                    match self.details.get(&t) {
                        Some((at, details)) if *at == last => details.clone(),
                        _ => {
                            let details = calc.get_target_details(t, None);
                            self.details.insert(t, (last, details.clone()));
                            details
                        }
                    }
                })
                .collect();
            let record = record(storage, npcs, skills, ping, &us, &combat, &block, &details);
            out.push(SavedFight::of_targets(storage, record, &block.targets, history::COMBAT));
            self.saved.insert(block.start, (block.end, now));
            // Gravada pela última vez: os detalhes dela não voltam a ser usados.
            if ended {
                for t in &block.targets {
                    self.details.remove(t);
                }
            }
        }
        self.saved.retain(|_, (end, _)| now - *end < 6 * 3_600_000);
        out
    }
}

/// Uma skill zerada, com o nome, a classe e o código da outra.
fn zeroed(skill: &DetailSkillEntry) -> DetailSkillEntry {
    DetailSkillEntry {
        time: 0,
        dmg: 0,
        multi_hit_count: 0,
        multi_hit_damage: 0,
        multi_hit_hits: 0,
        min_dmg: 0,
        max_dmg: 0,
        crit: 0,
        shield_block: 0,
        parry: 0,
        back: 0,
        frontal: 0,
        perfect: 0,
        double: 0,
        iron_wall: 0,
        regeneration: 0,
        perfect_block: 0,
        miss: 0,
        resist: 0,
        regen: 0,
        hit_timestamps: Vec::new(),
        ..skill.clone()
    }
}

/// Soma uma skill de um alvo na mesma skill do bloco; os horários passam a
/// contar do começo do bloco (`offset`).
fn add(into: &mut DetailSkillEntry, skill: &DetailSkillEntry, offset: i64) {
    into.time += skill.time;
    into.dmg = into.dmg.saturating_add(skill.dmg);
    into.multi_hit_count += skill.multi_hit_count;
    into.multi_hit_damage = into.multi_hit_damage.saturating_add(skill.multi_hit_damage);
    into.multi_hit_hits += skill.multi_hit_hits;
    if skill.min_dmg > 0 && (into.min_dmg == 0 || skill.min_dmg < into.min_dmg) {
        into.min_dmg = skill.min_dmg;
    }
    into.max_dmg = into.max_dmg.max(skill.max_dmg);
    into.crit += skill.crit;
    into.shield_block += skill.shield_block;
    into.parry += skill.parry;
    into.back += skill.back;
    into.frontal += skill.frontal;
    into.perfect += skill.perfect;
    into.double += skill.double;
    into.iron_wall += skill.iron_wall;
    into.regeneration += skill.regeneration;
    into.perfect_block += skill.perfect_block;
    into.miss += skill.miss;
    into.resist += skill.resist;
    into.regen = into.regen.saturating_add(skill.regen);
    into.hit_timestamps.extend(skill.hit_timestamps.iter().map(|t| t + offset));
    for (i, &spec) in skill.specs.iter().enumerate() {
        if let Some(flag) = into.specs.get_mut(i) {
            *flag |= spec;
        }
    }
}

/// A cura feita dentro do bloco, por jogador e skill. A cura fica guardada
/// por quem curou, a sessão inteira: só conta o que caiu no bloco.
fn heals(storage: &DataStorage, skills: &SkillLookup, us: &Us, damage: &[DetailSkillEntry], block: &Block) -> Vec<DetailSkillEntry> {
    // A cura cai na mesma linha do dano de quem curou.
    let ids_by_name: HashMap<String, i32> = damage.iter().map(|s| (us.name(s.actor_id), s.actor_id)).collect();
    let mut out: HashMap<(i32, i32, bool), DetailSkillEntry> = HashMap::new();
    for (actor, by_skill) in storage.get_heal_snapshot() {
        let owner = summon_resolver::resolve(actor, &us.summons);
        if owner <= 0 || !storage.is_known_player(owner) {
            continue;
        }
        let id = ids_by_name.get(&us.name(owner)).copied().unwrap_or(owner);
        for ((code, hot), heal) in by_skill {
            let ticks: Vec<&(i64, i64)> = heal.ticks.iter().filter(|(t, _)| (block.start..=block.end).contains(t)).collect();
            if ticks.is_empty() {
                continue;
            }
            let entry = out.entry((id, code, hot)).or_insert_with(|| {
                let mut name = skills.lookup_skill_name(code);
                if hot && !name.is_empty() {
                    name.push_str(" - HoT");
                }
                let job = JobClass::convert_from_skill(code).map(|j| j.class_name().to_string()).unwrap_or_default();
                DetailSkillEntry {
                    actor_id: id,
                    code,
                    name,
                    time: 0,
                    dmg: 0,
                    multi_hit_count: 0,
                    multi_hit_damage: 0,
                    multi_hit_hits: 0,
                    min_dmg: 0,
                    max_dmg: 0,
                    crit: 0,
                    shield_block: 0,
                    parry: 0,
                    back: 0,
                    frontal: 0,
                    perfect: 0,
                    double: 0,
                    iron_wall: 0,
                    regeneration: 0,
                    perfect_block: 0,
                    miss: 0,
                    resist: 0,
                    regen: 0,
                    job,
                    is_dot: hot,
                    hit_timestamps: Vec::new(),
                    specs: Vec::new(),
                }
            });
            for &&(t, amount) in &ticks {
                entry.time += 1;
                entry.dmg = entry.dmg.saturating_add(amount.min(i64::from(i32::MAX)) as i32);
                entry.hit_timestamps.push(t - block.start);
            }
        }
    }
    out.into_values().collect()
}

/// O registro de um bloco, como o motor grava um chefe: as skills de todos
/// os alvos juntas, a cura, o ping, os buffs e quem lutou.
#[allow(clippy::too_many_arguments)]
fn record(
    storage: &DataStorage,
    npcs: &NpcLookup,
    skills: &SkillLookup,
    ping: &PingTracker,
    us: &Us,
    combat: &HashMap<i32, TargetCombatData>,
    block: &Block,
    details: &[TargetDetailsResponse],
) -> FightRecord {
    let mut merged: HashMap<(i32, i32, bool), DetailSkillEntry> = HashMap::new();
    for target in details {
        let offset = target.start_time - block.start;
        for skill in &target.skills {
            let entry = merged.entry((skill.actor_id, skill.code, skill.is_dot)).or_insert_with(|| zeroed(skill));
            add(entry, skill, offset);
        }
    }
    let mut damage: Vec<DetailSkillEntry> = merged.into_values().collect();
    for skill in &mut damage {
        skill.hit_timestamps.sort_unstable();
    }
    let heal = heals(storage, skills, us, &damage, block);

    let damage_of = |t: &i32| combat.get(t).map_or(0, |c| c.total_damage);
    let total: i64 = block.targets.iter().map(damage_of).sum();
    let top = block.targets.iter().copied().max_by_key(damage_of).unwrap_or(0);
    let mob_code = storage.mob_code(top).unwrap_or(0);
    let duration = block.end - block.start;

    // Quem lutou: cada id das skills, com a classe, o que levou e curou nos
    // alvos do bloco, e o nível e o poder da lista do grupo.
    let party = storage.get_party_members();
    let mut ids: Vec<i32> = damage.iter().chain(&heal).map(|s| s.actor_id).collect();
    ids.sort_unstable();
    ids.dedup();
    let actors: Vec<DetailsActorSummary> = ids
        .iter()
        .map(|&id| {
            let nickname = us.name(id);
            let class = damage
                .iter()
                .chain(&heal)
                .filter(|s| s.actor_id == id)
                .find_map(|s| JobClass::convert_from_skill(s.code));
            let (mut party_heal, mut regen, mut received, mut hits) = (0, 0, 0, 0);
            for target in block.targets.iter().filter_map(|t| combat.get(t)) {
                if let Some(actor) = target.actors.get(&id) {
                    party_heal += actor.party_heal;
                    regen += actor.regen;
                    received += actor.damage_received;
                    hits += actor.hits_received;
                }
            }
            let member = party.get(nickname.trim());
            DetailsActorSummary {
                actor_id: id,
                job: class.map(|c| c.class_name().to_string()).unwrap_or_default(),
                job_id: class.map_or(0, |c| c.class_prefix()),
                party_heal,
                regen,
                damage_received: received,
                hits_received: hits,
                dbid: member.map_or(0, |m| m.dbid),
                server_id: member.map_or(0, |m| m.server_id),
                is_supporter: false,
                level: member.map_or(0, |m| m.level),
                gear_score: member.map_or(0, |m| m.gear_score),
                combat_power: member.map_or(0, |m| m.combat_power),
                nickname,
            }
        })
        .collect();
    let mut jobs: Vec<String> = actors.iter().map(|a| a.job.clone()).filter(|j| !j.is_empty()).collect();
    jobs.sort();
    jobs.dedup();
    let mut job_ids: Vec<i32> = actors.iter().map(|a| a.job_id).filter(|&j| j > 0).collect();
    job_ids.sort_unstable();
    job_ids.dedup();

    let ping_history = ping
        .get_ping_history(block.start, block.end)
        .into_iter()
        .map(|(t, ms)| PingPoint { ts_ms: t - block.start, ping_ms: ms })
        .collect();
    let buffs = fight_buffs::for_fight(storage, top, block.start, block.end, ids.iter().copied());
    let total = total.min(i64::from(i32::MAX)) as i32;
    FightRecord {
        id: format!("combate_{}", block.start),
        boss_name: npcs.get_npc_name(mob_code),
        target_id: top,
        start_time_ms: block.start,
        duration_ms: duration,
        total_damage: total,
        jobs,
        job_ids,
        details: TargetDetailsResponse {
            target_id: top,
            max_hp: 0,
            total_target_damage: total,
            battle_time: duration,
            start_time: block.start,
            skills: damage,
            ping_history,
            heal_skills: heal,
        },
        actors,
        is_train: false,
        app_version: APP_VERSION.to_string(),
        mob_code,
        dungeon_id: storage.current_dungeon_id(),
        server_id: storage.fight_server_id(),
        buffs: Some(buffs),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alvos_proximos_viram_uma_luta() {
        let targets = vec![(3, 50_000, 58_000), (1, 0, 10_000), (2, 20_000, 40_000), (4, 200_000, 210_000)];
        let out = blocks(targets, 30_000, i64::MAX);
        assert_eq!(
            out,
            [
                Block { targets: vec![1, 2, 3], start: 0, end: 58_000 },
                Block { targets: vec![4], start: 200_000, end: 210_000 },
            ]
        );
    }

    #[test]
    fn um_alvo_longo_segura_o_bloco() {
        // O 2 começa 50 s depois do começo, mas o 1 ainda estava apanhando.
        let out = blocks(vec![(1, 0, 100_000), (2, 50_000, 60_000)], 10_000, i64::MAX);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].end, 100_000);
    }

    #[test]
    fn farmar_sem_parar_divide_a_luta() {
        // Um monstro a cada 20 s por 30 min, com blocos de no máximo 10 min.
        let targets: Vec<(i32, i64, i64)> = (0..90).map(|i| (i, i64::from(i) * 20_000, i64::from(i) * 20_000 + 15_000)).collect();
        let out = blocks(targets, 60_000, 600_000);
        assert_eq!(out.len(), 3);
        assert!(out.iter().all(|b| b.targets.len() == 30));
    }
}
