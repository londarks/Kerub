//! Mapas de Atreia: a lista de mapas (com as áreas de cada um) e os pontos de
//! cada mapa (monstros, vilas, portais, recursos…), do site em `HOST`. A
//! imagem vem cortada em quadrados de 256 px que a tela pede direto do
//! armazenamento do site, só os que aparecem.
//!
//! O site não deixa a janela do app ler os dados (CORS), então eles vêm por
//! aqui e ficam na pasta `mapas`, ao lado do banco: a lista vale 6 horas e os
//! pontos valem até o site gerar outros (`generatedAt`). Sem internet, vale o
//! que estiver guardado.

use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;

use crate::armory::http;

const HOST: &str = "shugo.gg";
const INDEX_TTL: Duration = Duration::from_secs(6 * 3600);
/// Sobe quando a tradução dos pontos muda, para os guardados serem refeitos.
const FORMAT: u32 = 1;

/// Só letras minúsculas, números e "-": o nome vira parte de um caminho.
fn valid(name: &str) -> bool {
    !name.is_empty() && name.len() <= 40 && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn download(path: &str) -> Result<String, String> {
    http::get(HOST, path).map_err(|_| "sem resposta do servidor do mapa".to_string())
}

/// Grava num arquivo ao lado e troca: um app fechado no meio não deixa um
/// arquivo pela metade.
fn save(path: &Path, bytes: &[u8]) {
    let temp = path.with_extension("tmp");
    let saved = std::fs::write(&temp, bytes).and_then(|()| std::fs::rename(&temp, path));
    if let Err(e) = saved {
        tracing::warn!("não deu para guardar {}: {e}", path.display());
    }
}

/// A lista de mapas, como JSON.
pub fn index(dir: &Path) -> Result<Vec<u8>, String> {
    let path = dir.join("index.json");
    let age = std::fs::metadata(&path).and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok());
    if age.is_some_and(|age| age < INDEX_TTL) {
        if let Ok(bytes) = std::fs::read(&path) {
            return Ok(bytes);
        }
    }
    match download("/maps/index.json") {
        Ok(body) => {
            let _ = std::fs::create_dir_all(dir);
            save(&path, body.as_bytes());
            Ok(body.into_bytes())
        }
        Err(e) => std::fs::read(&path).map_err(|_| e),
    }
}

/// Os pontos de um mapa, como JSON, com o nome dos monstros em português.
pub fn markers(dir: &Path, key: &str, generated: &str, npc_names: &str) -> Result<Vec<u8>, String> {
    if !valid(key) || !valid(generated) {
        return Err("mapa desconhecido".into());
    }
    let path = dir.join(format!("{key}@{generated}.v{FORMAT}.json"));
    if let Ok(bytes) = std::fs::read(&path) {
        return Ok(bytes);
    }
    let body = download(&format!("/maps/{key}/markers.json"))?;
    let mut data: Value = serde_json::from_str(&body).map_err(|_| "o servidor mandou um mapa estranho".to_string())?;
    translate(&mut data, npc_names);
    let bytes = serde_json::to_vec(&data).map_err(|e| e.to_string())?;

    // Os pontos antigos deste mapa saem ("reshanta@" não pega "reshanta-lower@").
    let _ = std::fs::create_dir_all(dir);
    if let Ok(entries) = std::fs::read_dir(dir) {
        let prefix = format!("{key}@");
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().starts_with(&prefix) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    save(&path, &bytes);
    Ok(bytes)
}

#[derive(Deserialize)]
struct NpcName {
    name: String,
}

/// Troca o nome dos monstros com id (`"l": "/monsters/2100807"`) pelo nome em
/// português dos dados do motor. O nome em inglês fica em `e`, para a busca
/// achar pelos dois.
fn translate(data: &mut Value, npc_names: &str) {
    let Ok(names) = serde_json::from_str::<HashMap<String, NpcName>>(npc_names) else { return };
    let Some(templates) = data["templates"].as_array_mut() else { return };
    for template in templates {
        let Some(id) = template["l"].as_str().and_then(|l| l.strip_prefix("/monsters/")) else { continue };
        let Some(pt) = names.get(id).map(|n| n.name.trim()).filter(|n| !n.is_empty()) else { continue };
        if template["n"].as_str() != Some(pt) {
            let english = template["n"].take();
            template["e"] = english;
            template["n"] = Value::from(pt);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nomes_de_mapa_viram_caminho_com_cuidado() {
        assert!(valid("reshanta-lower"));
        assert!(valid("2026-10-02"));
        assert!(!valid("../historico"));
        assert!(!valid("Verteron"));
        assert!(!valid(""));
    }

    #[test]
    fn monstros_em_portugues() {
        let mut data = serde_json::json!({"templates": [
            {"c": "Elite", "n": "Eternal Kerubiel", "l": "/monsters/2101077"},
            {"c": "Named", "n": "Aulamus", "l": "/monsters?q=Aulamus"},
            {"c": "Village", "n": "Dawn Legion Base"}
        ]});
        translate(&mut data, r#"{"2101077": {"name": "Kerubiel da Eternidade", "isBoss": false}}"#);
        assert_eq!(data["templates"][0]["n"], "Kerubiel da Eternidade");
        assert_eq!(data["templates"][0]["e"], "Eternal Kerubiel");
        assert_eq!(data["templates"][1]["n"], "Aulamus");
        assert!(data["templates"][2].get("e").is_none());
    }

    /// Baixa a lista e os pontos de verdade. Precisa de internet:
    /// `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn mapa_de_verdade() {
        let dir = std::env::temp_dir().join(format!("kerub-mapas-{}", std::process::id()));
        let index: Value = serde_json::from_slice(&index(&dir).unwrap()).unwrap();
        let generated = index["generatedAt"].as_str().unwrap().to_string();
        let maps = index["maps"].as_array().unwrap();
        assert!(maps.iter().any(|m| m["key"] == "verteron"));

        let npc_names = crate::NPC_NAMES.to_string();
        let markers: Value = serde_json::from_slice(&markers(&dir, "verteron", &generated, &npc_names).unwrap()).unwrap();
        assert!(markers["points"].as_array().is_some_and(|p| p.len() > 1000));
        assert!(markers["templates"].as_array().unwrap().iter().any(|t| t["n"] == "Kerubiel da Eternidade"));
        // A segunda vez vem da pasta, sem internet.
        assert!(dir.join(format!("verteron@{generated}.v{FORMAT}.json")).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
