//! A luta que está acontecendo: uma linha por jogador, com dano, cura e dano
//! recebido, como o overlay e a página "Ao vivo" mostram.

use std::collections::{HashMap, HashSet};

use motor::combat::data_storage::{DataStorage, PartyMember, TargetCombatData};
use motor::entity::dps_data::DpsData;
use motor::entity::job_class::JobClass;
use motor::entity::summon_resolver;
use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub id: i32,
    pub name: String,
    /// A classe em inglês, como os ícones (`gladiator`); vazia se não se sabe.
    pub job: String,
    pub damage: f64,
    pub dps: f64,
    pub share: f64,
    /// Golpes críticos ÷ golpes diretos, em % (DoT não crita). Sem golpes, nada.
    pub crit: Option<f64>,
    /// Cura feita, nele mesmo ou nos outros.
    pub heal: f64,
    /// Cura recebida, de qualquer um (dele mesmo também).
    pub healed: f64,
    /// Dano levado de monstros.
    pub taken: f64,
    pub me: bool,
    /// Nível, nível de item e poder de combate, como a lista do grupo manda;
    /// 0 para quem não está no seu grupo.
    pub level: i32,
    pub gear: i32,
    pub power: i64,
}

impl Row {
    /// Uma linha sem nada ainda.
    pub fn empty(id: i32, name: &str, me: bool) -> Self {
        Self {
            id,
            name: name.to_string(),
            job: String::new(),
            damage: 0.0,
            dps: 0.0,
            share: 0.0,
            crit: None,
            heal: 0.0,
            healed: 0.0,
            taken: 0.0,
            me,
            level: 0,
            gear: 0,
            power: 0,
        }
    }
}

/// A classe pelo nome coreano que o motor usa, como os ícones se chamam.
pub fn class_key(korean: &str) -> &'static str {
    match korean {
        "검성" => "gladiator",
        "수호성" => "templar",
        "궁성" => "ranger",
        "살성" => "assassin",
        "마도성" => "sorcerer",
        "치유성" => "cleric",
        "정령성" => "elementalist",
        "호법성" => "chanter",
        "권성" => "fighter",
        _ => "",
    }
}

/// A luta que está na tela: os alvos que o motor escolheu e quem é quem.
pub struct Fight {
    pub targets: Vec<TargetCombatData>,
    summons: HashMap<i32, i32>,
    nicknames: HashMap<i32, String>,
    players: HashSet<i32>,
    /// O id de cada nome nas linhas de dano, o mesmo que o motor escolheu.
    ids_by_name: HashMap<String, i32>,
}

impl Fight {
    pub fn load(storage: &DataStorage, data: &DpsData) -> Self {
        let mut fight = Self::of_targets(storage, &detail_targets(data));
        fight.ids_by_name = data.map.iter().map(|(&id, p)| (p.nickname.clone(), id)).collect();
        fight
    }

    /// A luta contra estes alvos, sem as linhas do overlay: para gravar uma
    /// luta, quando só o nome de cada um importa.
    pub fn of_targets(storage: &DataStorage, target_ids: &[i32]) -> Self {
        Self {
            targets: target_ids.iter().filter_map(|&id| storage.get_target_snapshot_light(id)).collect(),
            summons: storage.get_summon_data(),
            nicknames: storage.get_nicknames(),
            players: storage.get_known_player_ids(),
            ids_by_name: HashMap::new(),
        }
    }

    /// A linha (id, nome) do jogador por trás de um id do parser: uma invocação
    /// conta para o dono, e um id antigo do mesmo personagem para a linha atual,
    /// como o `get_dps` do motor faz com o dano.
    pub fn player_of(&self, actor: i32) -> Option<(i32, String)> {
        let owner = summon_resolver::resolve(actor, &self.summons);
        if owner <= 0 {
            return None;
        }
        let name = self.nicknames.get(&owner).cloned().unwrap_or_else(|| owner.to_string());
        let id = self.ids_by_name.get(&name).copied().unwrap_or(owner);
        Some((id, name))
    }

    /// O nome de um id do parser, ou o próprio id quando o jogo não disse.
    pub fn name_of(&self, actor: i32) -> String {
        self.player_of(actor).map_or_else(|| actor.to_string(), |(_, name)| name)
    }

    /// Um jogador, ou a invocação de um.
    pub fn is_player(&self, id: i32) -> bool {
        self.players.contains(&summon_resolver::resolve(id, &self.summons))
    }

    fn is_summon(&self, actor: i32) -> bool {
        summon_resolver::resolve(actor, &self.summons) != actor
    }

    /// Do primeiro ao último golpe da luta, no relógio da captura.
    pub fn window(&self) -> Option<(i64, i64)> {
        let from = self.targets.iter().map(|t| t.first_damage_time).min()?;
        let to = self.targets.iter().map(|t| t.last_damage_time).max()?;
        Some((from, to))
    }
}

/// Os alvos por trás das linhas: um chefe pode ter várias partes.
pub fn detail_targets(data: &DpsData) -> Vec<i32> {
    if data.detail_target_ids.is_empty() {
        if data.target_id > 0 { vec![data.target_id] } else { Vec::new() }
    } else {
        data.detail_target_ids.clone()
    }
}

/// Cura ou dano recebido de um jogador, com o nome e a classe que se sabe.
#[derive(Default)]
pub struct Tally {
    pub name: String,
    pub job: Option<JobClass>,
    pub amount: f64,
}

/// Crítico de cada jogador nos alvos da tela. O `get_dps` do motor monta as
/// linhas só com totais e deixa os dados por skill vazios, então a contagem
/// vem dos agregados de combate. Invocações ficam de fora: é o crítico dos
/// golpes do próprio jogador.
fn crit_rates(fight: &Fight) -> HashMap<i32, f64> {
    let mut counts: HashMap<i32, (i64, i64)> = HashMap::new();
    for target in &fight.targets {
        for (&actor, combat) in &target.actors {
            if fight.is_summon(actor) {
                continue;
            }
            let Some((id, _)) = fight.player_of(actor) else { continue };
            let (hits, crits) = counts.entry(id).or_default();
            for skill in combat.skills.values().filter(|s| !s.is_dot) {
                *hits += i64::from(skill.hit_count);
                *crits += i64::from(skill.crit_count);
            }
        }
    }
    counts
        .into_iter()
        .filter(|(_, (hits, _))| *hits > 0)
        .map(|(id, (hits, crits))| (id, crits as f64 / hits as f64 * 100.0))
        .collect()
}

/// Cura feita dentro da janela da luta. O motor guarda a cura da sessão
/// inteira, golpe a golpe, então só conta o que caiu entre o primeiro e o
/// último golpe nos alvos da tela.
pub fn heal_by_player(storage: &DataStorage, fight: &Fight) -> HashMap<i32, Tally> {
    let mut tallies: HashMap<i32, Tally> = HashMap::new();
    let Some((from, to)) = fight.window() else { return tallies };
    for (actor, skills) in storage.get_heal_snapshot() {
        let Some((id, name)) = fight.player_of(actor) else { continue };
        for (&(skill_code, _), heal) in &skills {
            let healed: i64 = heal.ticks.iter().filter(|(t, _)| (from..=to).contains(t)).map(|(_, amount)| amount).sum();
            if healed <= 0 {
                continue;
            }
            let tally = tallies.entry(id).or_default();
            tally.name.clone_from(&name);
            tally.job = tally.job.or_else(|| JobClass::convert_from_skill(skill_code));
            tally.amount += healed as f64;
        }
    }
    tallies
}

/// Cura que cada jogador recebeu dentro da janela da luta, de qualquer um.
/// Monstros que se curam ficam de fora. O motor só guarda quem recebeu a
/// cura com `patches/motor-recebidos.patch`.
pub fn heal_received_by_player(storage: &DataStorage, fight: &Fight) -> HashMap<i32, Tally> {
    let mut tallies: HashMap<i32, Tally> = HashMap::new();
    let Some((from, to)) = fight.window() else { return tallies };
    for (target, ticks) in storage.get_heal_received_snapshot() {
        if !fight.is_player(target) {
            continue;
        }
        let Some((id, name)) = fight.player_of(target) else { continue };
        let healed: i64 = ticks.iter().filter(|(t, _)| (from..=to).contains(t)).map(|(_, amount)| amount).sum();
        if healed > 0 {
            let tally = tallies.entry(id).or_default();
            tally.name = name;
            tally.amount += healed as f64;
        }
    }
    tallies
}

/// Dano que cada jogador levou de monstros nos alvos da tela. Fica anotado na
/// luta do jogador contra o monstro que bateu nele; o motor só passa a ler
/// esse dano com `patches/motor-recebidos.patch`.
pub fn taken_by_player(fight: &Fight) -> HashMap<i32, Tally> {
    let mut tallies: HashMap<i32, Tally> = HashMap::new();
    for target in &fight.targets {
        for (&actor, combat) in &target.actors {
            if combat.damage_received <= 0 {
                continue;
            }
            let Some((id, name)) = fight.player_of(actor) else { continue };
            let tally = tallies.entry(id).or_default();
            tally.name = name;
            tally.job = tally.job.or(combat.job);
            tally.amount += combat.damage_received as f64;
        }
    }
    tallies
}

/// Cura feita e recebida, que percorrem cada golpe de cura da sessão.
#[derive(Default)]
pub struct Heals {
    pub done: HashMap<i32, Tally>,
    pub received: HashMap<i32, Tally>,
}

impl Heals {
    pub fn load(storage: &DataStorage, fight: &Fight) -> Self {
        Self { done: heal_by_player(storage, fight), received: heal_received_by_player(storage, fight) }
    }
}

/// Uma linha por jogador com dano, cura ou dano recebido, por DPS. `party` é
/// a lista do grupo, com o nível e o poder de cada um.
pub fn rows(data: &DpsData, fight: &Fight, heals: &Heals, party: &HashMap<String, PartyMember>) -> Vec<Row> {
    let crits = crit_rates(fight);
    let me = data.local_player_id;
    let mut rows: HashMap<i32, Row> = data
        .map
        .iter()
        .filter(|(_, p)| p.amount > 0.0)
        .map(|(&id, p)| {
            let row = Row {
                job: class_key(&p.job).to_string(),
                damage: p.amount,
                dps: p.dps,
                share: p.damage_contribution,
                crit: crits.get(&id).copied(),
                ..Row::empty(id, &p.nickname, me == Some(i64::from(id)))
            };
            (id, row)
        })
        .collect();

    // Quem só curou, foi curado ou apanhou também ganha linha.
    let mut add = |id: i32, tally: &Tally, set: fn(&mut Row, f64)| {
        let row = rows.entry(id).or_insert_with(|| Row::empty(id, &tally.name, me == Some(i64::from(id))));
        if row.job.is_empty() {
            if let Some(job) = tally.job {
                row.job = class_key(job.class_name()).to_string();
            }
        }
        set(row, tally.amount);
    };
    for (&id, tally) in &heals.done {
        add(id, tally, |row, amount| row.heal = amount);
    }
    for (&id, tally) in &heals.received {
        add(id, tally, |row, amount| row.healed = amount);
    }
    for (&id, tally) in &taken_by_player(fight) {
        add(id, tally, |row, amount| row.taken = amount);
    }

    let mut rows: Vec<Row> = rows.into_values().collect();
    for row in &mut rows {
        if let Some(member) = party.get(row.name.trim()) {
            row.level = member.level;
            row.gear = member.gear_score;
            row.power = member.combat_power;
        }
    }
    rows.sort_by(|a, b| {
        b.dps.total_cmp(&a.dps).then(b.heal.total_cmp(&a.heal)).then(b.taken.total_cmp(&a.taken))
    });
    rows
}
