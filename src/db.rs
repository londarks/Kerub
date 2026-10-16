//! O banco do meter: um arquivo SQLite em `%APPDATA%\local.kerub`, com as
//! lutas gravadas, as escolhas do client e os personagens procurados
//! (favoritos, vistos por último e a última página de cada um).
//!
//! Cada luta é uma linha: o resumo em colunas, para a lista e os recordes, e
//! a luta inteira em JSON (o registro do motor tem o horário de cada golpe,
//! uns 70 KB). Passando de `MAX_DETAILED` lutas de chefe (ou `MAX_COMBATS`
//! lutas comuns), as mais antigas perdem só o JSON: o resumo fica, e com ele
//! os recordes.

use std::collections::BTreeMap;
use std::path::Path;

use parking_lot::Mutex;
use rusqlite::{Connection, OptionalExtension, params};

use crate::armory::{Hit, Profile};
use crate::config::Config;
use crate::history::{SavedFight, Summary};

/// Lutas de chefe e de boneco com todos os detalhes.
const MAX_DETAILED: i64 = 1000;
/// Lutas comuns (`combats.rs`) com todos os detalhes: são muitas mais.
const MAX_COMBATS: i64 = 500;

const SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS lutas (
        id           TEXT PRIMARY KEY,
        chefe        TEXT NOT NULL,
        mob_code     INTEGER NOT NULL,
        dungeon_id   INTEGER NOT NULL,
        dungeon      TEXT NOT NULL,
        inicio_ms    INTEGER NOT NULL,
        duracao_ms   INTEGER NOT NULL,
        dano_total   REAL NOT NULL,
        dps_grupo    REAL NOT NULL,
        derrotado    INTEGER NOT NULL,
        boneco       INTEGER NOT NULL,
        eu           TEXT NOT NULL,
        meu_dps      REAL NOT NULL,
        minha_classe TEXT NOT NULL,
        -- A classe de cada jogador, do maior DPS ao menor: [\"sorcerer\", ...]
        classes      TEXT NOT NULL,
        -- A luta inteira (history::SavedFight); NULL depois de MAX_DETAILED.
        luta         TEXT,
        -- history::BOSS, TRAIN ou COMBAT; alvos e quantos morreram.
        tipo         TEXT NOT NULL DEFAULT 'boss',
        alvos        INTEGER NOT NULL DEFAULT 1,
        abatidos     INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS lutas_por_inicio ON lutas (inicio_ms);
    CREATE TABLE IF NOT EXISTS escolhas (
        chave TEXT PRIMARY KEY,
        valor TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS personagens (
        -- characterId da API do site oficial.
        id        TEXT PRIMARY KEY,
        -- armory::Hit: nome, classe, nível, servidor, retrato.
        resumo    TEXT NOT NULL,
        favorito  INTEGER NOT NULL DEFAULT 0,
        -- Quando a página dele foi aberta pela última vez (ms), 0 se nunca.
        visto_ms  INTEGER NOT NULL DEFAULT 0,
        -- armory::Profile da última vez, para abrir na hora.
        perfil    TEXT
    );
";

/// Personagens vistos por último que a tela lista.
const MAX_RECENT: i64 = 12;
const MAX_FAVORITES: i64 = 200;

/// Um personagem guardado: favorito, visto há pouco ou os dois.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SavedCharacter {
    #[serde(flatten)]
    pub hit: Hit,
    pub favorite: bool,
    pub viewed_ms: i64,
}

pub struct Db {
    conn: Mutex<Connection>,
}

fn sql(e: rusqlite::Error) -> String {
    format!("erro no banco do histórico: {e}")
}

impl Db {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        Self::with(Connection::open(path).map_err(sql)?)
    }

    #[cfg(test)]
    pub fn in_memory() -> Self {
        Self::with(Connection::open_in_memory().unwrap()).unwrap()
    }

    fn with(conn: Connection) -> Result<Self, String> {
        // WAL: gravar uma luta não trava a leitura da lista, e uma queda no meio
        // da gravação não estraga o banco.
        conn.pragma_update(None, "journal_mode", "WAL").map_err(sql)?;
        conn.pragma_update(None, "synchronous", "NORMAL").map_err(sql)?;
        conn.execute_batch(SCHEMA).map_err(sql)?;
        Self::migrate(&conn)?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    /// Um banco de antes das lutas comuns ganha as colunas delas.
    fn migrate(conn: &Connection) -> Result<(), String> {
        let mut query = conn.prepare("SELECT name FROM pragma_table_info('lutas')").map_err(sql)?;
        let columns: Vec<String> = query.query_map([], |row| row.get(0)).map_err(sql)?.collect::<Result<_, _>>().map_err(sql)?;
        if columns.iter().any(|c| c == "tipo") {
            return Ok(());
        }
        conn.execute_batch(
            "ALTER TABLE lutas ADD COLUMN tipo TEXT NOT NULL DEFAULT 'boss';
             ALTER TABLE lutas ADD COLUMN alvos INTEGER NOT NULL DEFAULT 1;
             ALTER TABLE lutas ADD COLUMN abatidos INTEGER NOT NULL DEFAULT 0;
             UPDATE lutas SET tipo = 'train' WHERE boneco = 1;
             UPDATE lutas SET abatidos = derrotado;",
        )
        .map_err(sql)
    }

    // ── escolhas ───────────────────────────────────────────────

    pub fn load_config(&self) -> Config {
        let conn = self.conn.lock();
        conn.query_row("SELECT valor FROM escolhas WHERE chave = 'config'", [], |row| row.get::<_, String>(0))
            .optional()
            .ok()
            .flatten()
            .and_then(|json| serde_json::from_str::<Config>(&json).ok())
            .unwrap_or_default()
            .cleaned()
    }

    pub fn save_config(&self, config: &Config) -> Result<(), String> {
        let json = serde_json::to_string(config).map_err(|e| e.to_string())?;
        self.conn
            .lock()
            .execute(
                "INSERT INTO escolhas (chave, valor) VALUES ('config', ?1)
                 ON CONFLICT (chave) DO UPDATE SET valor = excluded.valor",
                [json],
            )
            .map_err(sql)?;
        Ok(())
    }

    // ── personagens ────────────────────────────────────────────

    fn upsert_hit(conn: &Connection, hit: &Hit) -> Result<(), String> {
        let json = serde_json::to_string(hit).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO personagens (id, resumo) VALUES (?1, ?2)
             ON CONFLICT (id) DO UPDATE SET resumo = excluded.resumo",
            params![hit.id, json],
        )
        .map_err(sql)?;
        Ok(())
    }

    pub fn set_favorite(&self, hit: &Hit, favorite: bool) -> Result<(), String> {
        let conn = self.conn.lock();
        Self::upsert_hit(&conn, hit)?;
        conn.execute("UPDATE personagens SET favorito = ?2 WHERE id = ?1", params![hit.id, favorite]).map_err(sql)?;
        Ok(())
    }

    /// Favoritos (por nome) e os vistos por último (o mais recente primeiro).
    pub fn saved_characters(&self) -> Result<(Vec<SavedCharacter>, Vec<SavedCharacter>), String> {
        let conn = self.conn.lock();
        let read = |query: &str, limit: i64| -> Result<Vec<SavedCharacter>, String> {
            let mut query = conn.prepare(query).map_err(sql)?;
            let rows = query
                .query_map([limit], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?, row.get::<_, i64>(2)?))
                })
                .map_err(sql)?;
            let mut out = Vec::new();
            for row in rows {
                let (json, favorite, viewed_ms) = row.map_err(sql)?;
                if let Ok(hit) = serde_json::from_str::<Hit>(&json) {
                    out.push(SavedCharacter { hit, favorite, viewed_ms });
                }
            }
            Ok(out)
        };
        let mut favorites = read("SELECT resumo, favorito, visto_ms FROM personagens WHERE favorito = 1 LIMIT ?1", MAX_FAVORITES)?;
        favorites.sort_by(|a, b| a.hit.name.to_lowercase().cmp(&b.hit.name.to_lowercase()));
        let recent = read("SELECT resumo, favorito, visto_ms FROM personagens WHERE visto_ms > 0 ORDER BY visto_ms DESC LIMIT ?1", MAX_RECENT)?;
        Ok((favorites, recent))
    }

    /// A página guardada de um personagem, se ele já foi aberto.
    pub fn cached_profile(&self, id: &str) -> Result<Option<(Profile, bool)>, String> {
        let row: Option<(Option<String>, bool)> = self
            .conn
            .lock()
            .query_row("SELECT perfil, favorito FROM personagens WHERE id = ?1", [id], |row| Ok((row.get(0)?, row.get(1)?)))
            .optional()
            .map_err(sql)?;
        Ok(row.and_then(|(json, favorite)| Some((serde_json::from_str(&json?).ok()?, favorite))))
    }

    /// Guarda a página que acabou de vir do site e marca como vista agora.
    pub fn save_profile(&self, profile: &Profile, viewed_ms: i64) -> Result<bool, String> {
        let json = serde_json::to_string(profile).map_err(|e| e.to_string())?;
        let conn = self.conn.lock();
        Self::upsert_hit(&conn, &profile.hit)?;
        conn.execute("UPDATE personagens SET perfil = ?2, visto_ms = ?3 WHERE id = ?1", params![profile.hit.id, json, viewed_ms])
            .map_err(sql)?;
        conn.query_row("SELECT favorito FROM personagens WHERE id = ?1", [&profile.hit.id], |row| row.get(0)).map_err(sql)
    }

    /// Junta detalhes de itens à página guardada e devolve todos os que ela
    /// tem. Se a página foi atualizada no meio (outro `fetched_ms`), os
    /// detalhes eram da antiga e não entram.
    pub fn merge_items(
        &self,
        id: &str,
        fetched_ms: i64,
        items: BTreeMap<String, serde_json::Value>,
    ) -> Result<BTreeMap<String, serde_json::Value>, String> {
        let conn = self.conn.lock();
        let json: Option<Option<String>> =
            conn.query_row("SELECT perfil FROM personagens WHERE id = ?1", [id], |row| row.get(0)).optional().map_err(sql)?;
        let Some(mut profile) = json.flatten().and_then(|j| serde_json::from_str::<Profile>(&j).ok()) else {
            return Ok(items);
        };
        if profile.fetched_ms != fetched_ms {
            return Ok(profile.items);
        }
        profile.items.extend(items);
        let json = serde_json::to_string(&profile).map_err(|e| e.to_string())?;
        conn.execute("UPDATE personagens SET perfil = ?2 WHERE id = ?1", params![id, json]).map_err(sql)?;
        Ok(profile.items)
    }

    pub fn mark_viewed(&self, id: &str, viewed_ms: i64) -> Result<(), String> {
        self.conn.lock().execute("UPDATE personagens SET visto_ms = ?2 WHERE id = ?1", params![id, viewed_ms]).map_err(sql)?;
        Ok(())
    }

    // ── lutas ──────────────────────────────────────────────────

    /// Grava ou atualiza a luta: uma luta longa é gravada de novo enquanto dura.
    pub fn save_fight(&self, fight: &SavedFight) -> Result<(), String> {
        let summary = Summary::of(&fight.view());
        let json = serde_json::to_string(fight).map_err(|e| e.to_string())?;
        let classes = serde_json::to_string(&summary.jobs).map_err(|e| e.to_string())?;
        let mut conn = self.conn.lock();
        let tx = conn.transaction().map_err(sql)?;
        tx.execute(
            "INSERT INTO lutas (id, chefe, mob_code, dungeon_id, dungeon, inicio_ms, duracao_ms, dano_total,
                                dps_grupo, derrotado, boneco, eu, meu_dps, minha_classe, classes, luta,
                                tipo, alvos, abatidos)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)
             ON CONFLICT (id) DO UPDATE SET
                chefe = excluded.chefe, mob_code = excluded.mob_code, dungeon_id = excluded.dungeon_id,
                dungeon = excluded.dungeon, inicio_ms = excluded.inicio_ms, duracao_ms = excluded.duracao_ms,
                dano_total = excluded.dano_total, dps_grupo = excluded.dps_grupo, derrotado = excluded.derrotado,
                boneco = excluded.boneco, eu = excluded.eu, meu_dps = excluded.meu_dps,
                minha_classe = excluded.minha_classe, classes = excluded.classes, luta = excluded.luta,
                tipo = excluded.tipo, alvos = excluded.alvos, abatidos = excluded.abatidos",
            params![
                summary.id,
                summary.boss,
                summary.mob_code,
                summary.dungeon_id,
                summary.dungeon,
                summary.start_ms,
                summary.duration_ms,
                summary.total_damage,
                summary.party_dps,
                summary.killed,
                summary.train,
                summary.me,
                summary.my_dps,
                summary.my_job,
                classes,
                json,
                summary.kind,
                summary.targets,
                summary.kills,
            ],
        )
        .map_err(sql)?;
        tx.execute(
            "UPDATE lutas SET luta = NULL WHERE id IN (
                SELECT id FROM lutas WHERE luta IS NOT NULL AND tipo != 'combat'
                ORDER BY inicio_ms DESC LIMIT -1 OFFSET ?1)",
            [MAX_DETAILED],
        )
        .map_err(sql)?;
        tx.execute(
            "UPDATE lutas SET luta = NULL WHERE id IN (
                SELECT id FROM lutas WHERE luta IS NOT NULL AND tipo = 'combat'
                ORDER BY inicio_ms DESC LIMIT -1 OFFSET ?1)",
            [MAX_COMBATS],
        )
        .map_err(sql)?;
        tx.commit().map_err(sql)
    }

    /// Da mais nova para a mais antiga.
    pub fn list(&self) -> Result<Vec<Summary>, String> {
        let conn = self.conn.lock();
        let mut query = conn
            .prepare(
                "SELECT id, chefe, mob_code, dungeon_id, dungeon, inicio_ms, duracao_ms, dano_total, dps_grupo,
                        derrotado, boneco, eu, meu_dps, minha_classe, classes, luta IS NOT NULL,
                        tipo, alvos, abatidos
                 FROM lutas ORDER BY inicio_ms DESC",
            )
            .map_err(sql)?;
        let rows = query
            .query_map([], |row| {
                Ok(Summary {
                    id: row.get(0)?,
                    boss: row.get(1)?,
                    mob_code: row.get(2)?,
                    dungeon_id: row.get(3)?,
                    dungeon: row.get(4)?,
                    start_ms: row.get(5)?,
                    duration_ms: row.get(6)?,
                    total_damage: row.get(7)?,
                    party_dps: row.get(8)?,
                    killed: row.get(9)?,
                    train: row.get(10)?,
                    me: row.get(11)?,
                    my_dps: row.get(12)?,
                    my_job: row.get(13)?,
                    jobs: serde_json::from_str(&row.get::<_, String>(14)?).unwrap_or_default(),
                    detailed: row.get(15)?,
                    kind: row.get(16)?,
                    targets: row.get(17)?,
                    kills: row.get(18)?,
                })
            })
            .map_err(sql)?;
        rows.collect::<Result<_, _>>().map_err(sql)
    }

    pub fn load(&self, id: &str) -> Result<SavedFight, String> {
        let json: Option<Option<String>> = self
            .conn
            .lock()
            .query_row("SELECT luta FROM lutas WHERE id = ?1", [id], |row| row.get(0))
            .optional()
            .map_err(sql)?;
        match json {
            None => Err("Essa luta não está mais no histórico.".into()),
            Some(None) => Err("Os detalhes dessa luta foram apagados para economizar espaço; o resumo continua na lista.".into()),
            Some(Some(json)) => serde_json::from_str(&json).map_err(|e| format!("Os dados dessa luta estão estragados ({e}).")),
        }
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        self.conn.lock().execute("DELETE FROM lutas WHERE id = ?1", [id]).map_err(sql)?;
        Ok(())
    }
}
