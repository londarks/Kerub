//! O que a pessoa escolhe no client e vale para o overlay também: se o overlay
//! abre, quais colunas ele mostra e a cor de cada classe. Fica no banco
//! (`db.rs`), e cada mudança vai para as duas janelas na hora.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// O que medir: só o chefe, todos os alvos ou o boneco de treino.
pub const MODES: [&str; 3] = ["bossTargets", "allTargets", "trainTargets"];

/// Colunas que o overlay pode mostrar, na ordem da tabela.
pub const COLUMNS: [&str; 7] = ["dps", "share", "damage", "crit", "heal", "healed", "taken"];

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    /// O overlay por cima do jogo. Desligado, o meter só grava e mostra no
    /// client: em PC mais fraco o overlay pesa.
    pub overlay: bool,
    /// Colunas do overlay, de `COLUMNS`.
    pub columns: Vec<String>,
    /// Cor da barra de cada classe (`gladiator`: `#0e7490`). A que não está
    /// aqui usa a cor padrão.
    pub colors: BTreeMap<String, String>,
    /// "≈ 3:32 restantes neste DPS" embaixo do HP do chefe.
    pub time_left: bool,
    /// Máximo de linhas no overlay; o resto vira "+N jogadores".
    pub max_rows: u32,
    /// Um de `MODES`.
    pub mode: String,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            overlay: true,
            columns: ["dps", "share", "damage", "crit"].map(String::from).to_vec(),
            colors: BTreeMap::new(),
            time_left: true,
            max_rows: 10,
            mode: MODES[0].to_string(),
        }
    }
}

impl Config {
    /// Sem coluna desconhecida, repetida ou fora de ordem, sem cor que não seja
    /// `#rrggbb` e com um número de linhas razoável: vem da tela.
    pub fn cleaned(mut self) -> Self {
        self.columns = COLUMNS.iter().filter(|c| self.columns.iter().any(|x| x == *c)).map(|c| c.to_string()).collect();
        self.colors.retain(|_, color| {
            color.len() == 7 && color.starts_with('#') && color[1..].chars().all(|c| c.is_ascii_hexdigit())
        });
        self.max_rows = self.max_rows.clamp(3, 30);
        if !MODES.contains(&self.mode.as_str()) {
            self.mode = MODES[0].to_string();
        }
        self
    }
}
