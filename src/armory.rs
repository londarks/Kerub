//! Personagens do AION 2 pela API do site oficial: busca por nome e a página
//! do personagem (equipamento, skills, Daevanion, atributos).
//!
//! São as mesmas rotas que o aion2.plaync.com usa, abertas e sem login. Sites
//! de fora passam por um proxy só porque o navegador bloqueia a chamada
//! direta (CORS); daqui, do Rust, a chamada vai direto para a NC. O
//! HTTP é o WinHTTP do próprio Windows: nenhuma biblioteca a mais no exe.
//!
//! Cada chamada leva de 1 a 4 s, então o perfil fica guardado no banco
//! (`db.rs`) e abre na hora da segunda vez; o resto fica na memória por um
//! tempo.

use std::collections::{BTreeMap, HashMap};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicUsize, Ordering};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

const SEARCH_HOST: &str = "api-search.plaync.com";
const SITE_HOST: &str = "aion2.plaync.com";
/// Nomes de itens, skills e atributos em português.
const LANG: &str = "pt-BR";
/// Quanto tempo um item ou uma tabela Daevanion vale na memória.
const MEMORY_TTL_MS: i64 = 30 * 60 * 1000;
/// Detalhes de itens buscados ao mesmo tempo. Com 6, o site às vezes responde
/// 404 para o segundo de dois itens iguais (os dois anéis) pedidos juntos;
/// com 4 os 19 itens de um personagem chegam em uns 10 s.
const ITEM_WORKERS: usize = 4;

/// As regiões do AION 2 global e o segundo dígito do id do servidor de cada
/// uma (1404 é Kaisinel, Elyos, na América do Sul).
pub const REGIONS: [(&str, i32); 5] = [("nae", 1), ("naw", 2), ("eu", 3), ("la", 4), ("as", 5)];

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

/// A região de um servidor, pelo id.
pub fn region_of(server_id: i32) -> &'static str {
    let digit = server_id / 100 % 10;
    REGIONS.iter().find(|(_, d)| *d == digit).map_or("la", |(r, _)| r)
}

/// A classe pelo `pcId` da busca, que é o mesmo número de classe da lista do
/// grupo no jogo: blocos de quatro a partir do 5 (29 a 32 é Clérigo).
pub fn class_of(pc_id: i64) -> &'static str {
    const ORDER: [&str; 9] =
        ["gladiator", "templar", "ranger", "assassin", "elementalist", "sorcerer", "cleric", "chanter", "fighter"];
    if pc_id < 5 {
        return "";
    }
    ORDER.get(((pc_id - 5) / 4) as usize).copied().unwrap_or("")
}

/// Um valor numa URL: letras e números ficam, o resto vira %XX.
fn encode(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.~".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// O contrário de `encode`: a busca devolve o id já com %3D no lugar do "=".
fn decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(byte) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Tira as marcas de HTML que a busca põe no nome (`<strong>Lon</strong>darks`).
fn strip_tags(text: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for c in text.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out
}

// ── HTTP ───────────────────────────────────────────────────────

#[cfg(windows)]
pub(crate) mod http {
    use std::sync::OnceLock;

    use windows::Win32::Networking::WinHttp::*;
    use windows::core::{HSTRING, PCWSTR};

    /// A sessão do WinHTTP, aberta uma vez. Ela pode ser usada por várias
    /// threads ao mesmo tempo.
    struct Session(*mut core::ffi::c_void);
    unsafe impl Send for Session {}
    unsafe impl Sync for Session {}

    /// Fecha o handle quando sai de escopo.
    struct Handle(*mut core::ffi::c_void);
    impl Drop for Handle {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    let _ = WinHttpCloseHandle(self.0);
                }
            }
        }
    }

    fn session() -> Result<*mut core::ffi::c_void, String> {
        static SESSION: OnceLock<Session> = OnceLock::new();
        let session = SESSION.get_or_init(|| unsafe {
            let agent = HSTRING::from(concat!("Kerub/", env!("CARGO_PKG_VERSION")));
            let handle = WinHttpOpen(&agent, WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, PCWSTR::null(), PCWSTR::null(), 0);
            if !handle.is_null() {
                // Resolver, conectar, mandar e receber, em ms.
                let _ = WinHttpSetTimeouts(handle, 10_000, 10_000, 15_000, 25_000);
                // Respostas comprimidas: a tabela Daevanion tem 40 KB em JSON.
                let flags = (WINHTTP_DECOMPRESSION_FLAG_GZIP | WINHTTP_DECOMPRESSION_FLAG_DEFLATE).to_le_bytes();
                let _ = WinHttpSetOption(Some(handle), WINHTTP_OPTION_DECOMPRESSION, Some(&flags));
            }
            Session(handle)
        });
        if session.0.is_null() {
            Err("o Windows não abriu a conexão com a internet".into())
        } else {
            Ok(session.0)
        }
    }

    /// GET em https://`host``path`, devolvendo o corpo da resposta 200.
    pub fn get(host: &str, path: &str) -> Result<String, String> {
        let offline = |e: windows::core::Error| format!("sem resposta do site do AION 2 ({})", e.message().trim());
        unsafe {
            let session = session()?;
            let connect = Handle(WinHttpConnect(session, &HSTRING::from(host), INTERNET_DEFAULT_HTTPS_PORT, 0));
            if connect.0.is_null() {
                return Err(offline(windows::core::Error::from_win32()));
            }
            let request = Handle(WinHttpOpenRequest(
                connect.0,
                &HSTRING::from("GET"),
                &HSTRING::from(path),
                PCWSTR::null(),
                PCWSTR::null(),
                std::ptr::null(),
                WINHTTP_FLAG_SECURE,
            ));
            if request.0.is_null() {
                return Err(offline(windows::core::Error::from_win32()));
            }
            let headers: Vec<u16> = "Accept: application/json\r\n".encode_utf16().collect();
            WinHttpSendRequest(request.0, Some(&headers), None, 0, 0, 0).map_err(offline)?;
            WinHttpReceiveResponse(request.0, std::ptr::null_mut()).map_err(offline)?;

            let mut status: u32 = 0;
            let mut size = std::mem::size_of::<u32>() as u32;
            WinHttpQueryHeaders(
                request.0,
                WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                PCWSTR::null(),
                Some(&mut status as *mut u32 as *mut core::ffi::c_void),
                &mut size,
                std::ptr::null_mut(),
            )
            .map_err(offline)?;

            let mut body = Vec::new();
            let mut chunk = vec![0u8; 64 * 1024];
            loop {
                let mut read: u32 = 0;
                WinHttpReadData(request.0, chunk.as_mut_ptr().cast(), chunk.len() as u32, &mut read).map_err(offline)?;
                if read == 0 {
                    break;
                }
                body.extend_from_slice(&chunk[..read as usize]);
            }
            if status != 200 {
                return Err(format!("o site do AION 2 respondeu {status}"));
            }
            String::from_utf8(body).map_err(|_| "resposta estranha do site do AION 2".into())
        }
    }
}

#[cfg(not(windows))]
pub(crate) mod http {
    pub fn get(_host: &str, _path: &str) -> Result<String, String> {
        Err("a busca de personagens só existe no Windows".into())
    }
}

/// Respostas guardadas na memória, por endereço.
fn memory() -> &'static Mutex<HashMap<String, (i64, Value)>> {
    static MEMORY: OnceLock<Mutex<HashMap<String, (i64, Value)>>> = OnceLock::new();
    MEMORY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn get_json(host: &str, path: &str) -> Result<Value, String> {
    let body = http::get(host, path)?;
    serde_json::from_str(&body).map_err(|_| "resposta estranha do site do AION 2".to_string())
}

/// `get_json`, mas guardado na memória por `MEMORY_TTL_MS`.
fn get_json_cached(host: &str, path: &str) -> Result<Value, String> {
    let key = format!("{host}{path}");
    let now = now_ms();
    if let Some((at, value)) = memory().lock().get(&key) {
        if now - at < MEMORY_TTL_MS {
            return Ok(value.clone());
        }
    }
    let value = get_json(host, path)?;
    let mut memory = memory().lock();
    memory.retain(|_, (at, _)| now - *at < MEMORY_TTL_MS);
    memory.insert(key, (now, value.clone()));
    Ok(value)
}

// ── busca ──────────────────────────────────────────────────────

/// Um personagem como a busca e as listas mostram.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    /// O `characterId` da API, já sem %3D.
    pub id: String,
    pub name: String,
    /// A classe em inglês, como os ícones (`cleric`).
    pub job: String,
    pub level: i64,
    /// 1 Elyos, 2 Asmodiano.
    pub race: i64,
    pub server_id: i32,
    pub server: String,
    pub region: String,
    /// Retrato do personagem, do site oficial.
    pub image: String,
}

impl Hit {
    fn from_search(entry: &Value) -> Option<Self> {
        let server_id = entry["serverId"].as_i64()? as i32;
        let image = entry["profileImageUrl"].as_str().unwrap_or_default();
        Some(Self {
            id: decode(entry["characterId"].as_str()?),
            name: strip_tags(entry["name"].as_str()?),
            job: class_of(entry["pcId"].as_i64().unwrap_or(0)).to_string(),
            level: entry["level"].as_i64().unwrap_or(0),
            race: entry["race"].as_i64().unwrap_or(0),
            server_id,
            server: entry["serverName"].as_str().unwrap_or_default().to_string(),
            region: region_of(server_id).to_string(),
            image: if image.starts_with('/') { format!("https://profileimg.plaync.com{image}") } else { image.to_string() },
        })
    }

    /// O mesmo personagem pelo `profile` da página dele, que é mais novo.
    fn from_profile(profile: &Value) -> Option<Self> {
        let server_id = profile["serverId"].as_i64()? as i32;
        Some(Self {
            id: profile["characterId"].as_str()?.to_string(),
            name: profile["characterName"].as_str()?.to_string(),
            job: class_of(profile["pcId"].as_i64().unwrap_or(0)).to_string(),
            level: profile["characterLevel"].as_i64().unwrap_or(0),
            race: profile["raceId"].as_i64().unwrap_or(0),
            server_id,
            server: profile["serverName"].as_str().unwrap_or_default().to_string(),
            region: region_of(server_id).to_string(),
            image: profile["profileImage"].as_str().unwrap_or_default().to_string(),
        })
    }
}

fn search_region(keyword: &str, region: &str) -> Result<Vec<Hit>, String> {
    let path = format!(
        "/aion2global/search/v2/character?keyword={}&page=1&size=50&localeInfo=en-US&region={region}&serverId=",
        encode(keyword)
    );
    let value = get_json(SEARCH_HOST, &path)?;
    Ok(value["list"].as_array().map(|list| list.iter().filter_map(Hit::from_search).collect()).unwrap_or_default())
}

/// Personagens com esse nome. Sem região, procura nas cinco ao mesmo tempo.
/// O nome exato vem primeiro, depois o de nível mais alto.
pub fn search(keyword: &str, region: Option<&str>) -> Result<Vec<Hit>, String> {
    let keyword = keyword.trim();
    if keyword.chars().count() < 2 {
        return Err("Digite pelo menos 2 letras.".into());
    }
    let regions: Vec<&str> = match region {
        Some(r) if REGIONS.iter().any(|(code, _)| *code == r) => vec![r],
        _ => REGIONS.iter().map(|(code, _)| *code).collect(),
    };
    let results: Vec<Result<Vec<Hit>, String>> = std::thread::scope(|scope| {
        let jobs: Vec<_> = regions.iter().map(|r| scope.spawn(move || search_region(keyword, r))).collect();
        jobs.into_iter().map(|job| job.join().unwrap_or_else(|_| Err("falha na busca".into()))).collect()
    });
    // Uma região fora do ar não esconde as outras; só sem nenhuma é erro.
    let mut hits = Vec::new();
    let mut error = None;
    for result in results {
        match result {
            Ok(found) => hits.extend(found),
            Err(e) => error = Some(e),
        }
    }
    if hits.is_empty() {
        if let Some(e) = error {
            return Err(e);
        }
    }
    let wanted = keyword.to_lowercase();
    hits.sort_by(|a, b| {
        let exact = |h: &Hit| h.name.to_lowercase() != wanted;
        exact(a).cmp(&exact(b)).then(b.level.cmp(&a.level)).then(a.name.cmp(&b.name))
    });
    Ok(hits)
}

// ── página do personagem ───────────────────────────────────────

fn character_query(id: &str, server_id: i32) -> String {
    format!("lang={LANG}&characterId={}&serverId={server_id}&region={}", encode(id), region_of(server_id))
}

/// O que a página do personagem mostra de cara: perfil, atributos, títulos,
/// tabelas Daevanion (resumo), equipamento, aparência, pet, asa e skills.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub hit: Hit,
    pub info: Value,
    pub equipment: Value,
    /// Quando veio do site, em ms desde 1970.
    pub fetched_ms: i64,
    /// Os detalhes de cada item equipado, por `item_key`. Chegam logo depois
    /// da página (`items`) e ficam guardados com ela.
    #[serde(default)]
    pub items: BTreeMap<String, Value>,
}

/// Busca o perfil e o equipamento ao mesmo tempo.
pub fn profile(id: &str, server_id: i32) -> Result<Profile, String> {
    let query = character_query(id, server_id);
    let (info, equipment) = std::thread::scope(|scope| {
        let info = scope.spawn(|| get_json(SITE_HOST, &format!("/api/character/info?{query}")));
        let equipment = scope.spawn(|| get_json(SITE_HOST, &format!("/api/character/equipment?{query}")));
        (
            info.join().unwrap_or_else(|_| Err("falha ao abrir o personagem".into())),
            equipment.join().unwrap_or_else(|_| Err("falha ao abrir o personagem".into())),
        )
    });
    let info = info?;
    let hit = Hit::from_profile(&info["profile"]).ok_or("O site do AION 2 não achou esse personagem.")?;
    Ok(Profile { hit, info, equipment: equipment?, fetched_ms: now_ms(), items: BTreeMap::new() })
}

/// Uma das tabelas Daevanion (`board` 71 a 76).
pub fn daevanion(id: &str, server_id: i32, board: i32) -> Result<Value, String> {
    get_json_cached(SITE_HOST, &format!("/api/character/daevanion/detail?{}&boardId={board}", character_query(id, server_id)))
}

/// Os detalhes de um item equipado: atributos, pedras de mana, de onde vem.
pub fn item(id: &str, server_id: i32, item_id: i64, enchant: i64, slot: i64) -> Result<Value, String> {
    get_json_cached(
        SITE_HOST,
        &format!("/api/character/equipment/item?id={item_id}&enchantLevel={enchant}&slotPos={slot}&{}", character_query(id, server_id)),
    )
}

/// A chave dos detalhes de um item: o lugar, o item e o encantamento (um +10
/// tem outros atributos que o mesmo item +9).
pub fn item_key(slot: i64, item_id: i64, enchant: i64) -> String {
    format!("{slot}|{item_id}|{enchant}")
}

/// Os itens equipados de uma página: (item, encantamento, lugar).
pub fn equipped(profile: &Profile) -> Vec<(i64, i64, i64)> {
    profile.equipment["equipment"]["equipmentList"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|i| Some((i["id"].as_i64()?, i["enchantLevel"].as_i64().unwrap_or(0), i["slotPos"].as_i64()?)))
                .collect()
        })
        .unwrap_or_default()
}

/// Os detalhes de vários itens, `ITEM_WORKERS` por vez, e depois mais uma
/// tentativa, um por vez, para os que o site recusou. Um item que ainda assim
/// não vier fica de fora; a tela pede ele de novo se alguém olhar.
pub fn items(id: &str, server_id: i32, wanted: &[(i64, i64, i64)]) -> BTreeMap<String, Value> {
    let next = AtomicUsize::new(0);
    let found = Mutex::new(BTreeMap::new());
    std::thread::scope(|scope| {
        for _ in 0..ITEM_WORKERS.min(wanted.len()) {
            scope.spawn(|| {
                while let Some(&(item_id, enchant, slot)) = wanted.get(next.fetch_add(1, Ordering::Relaxed)) {
                    if let Ok(value) = item(id, server_id, item_id, enchant, slot) {
                        found.lock().insert(item_key(slot, item_id, enchant), value);
                    }
                }
            });
        }
    });
    let mut found = found.into_inner();
    for &(item_id, enchant, slot) in wanted {
        let key = item_key(slot, item_id, enchant);
        if !found.contains_key(&key) {
            if let Ok(value) = item(id, server_id, item_id, enchant, slot) {
                found.insert(key, value);
            }
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classe_regiao_e_nome_da_busca() {
        assert_eq!((class_of(30), class_of(28), class_of(14), class_of(9)), ("cleric", "sorcerer", "ranger", "templar"));
        assert_eq!((region_of(1404), region_of(2406), region_of(1103), region_of(2314)), ("la", "la", "nae", "eu"));
        let hit = Hit::from_search(&serde_json::json!({
            "characterId": "uafES2bYUDar4sQQK-evzftz0kXIlWNRTcDRsjW0JDA%3D", "name": "<strong>Londarks</strong>",
            "race": 1, "pcId": 30, "level": 45, "serverId": 1404, "serverName": "Kaisinel",
            "profileImageUrl": "/game_profile_images/aion2global/images?gameServerKey=1404&charKey=1", "region": "la"
        }))
        .unwrap();
        assert_eq!(hit.id, "uafES2bYUDar4sQQK-evzftz0kXIlWNRTcDRsjW0JDA=");
        assert_eq!((hit.name.as_str(), hit.job.as_str(), hit.region.as_str()), ("Londarks", "cleric", "la"));
        assert!(hit.image.starts_with("https://profileimg.plaync.com/"));
        assert_eq!(encode("a b=ç"), "a%20b%3D%C3%A7");
    }

    /// Chama o site de verdade (precisa de internet): `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn busca_e_perfil_de_verdade() {
        let hits = search("londarks", None).unwrap();
        let hit = hits.iter().find(|h| h.server == "Kaisinel").expect("Londarks de Kaisinel");
        let profile = profile(&hit.id, hit.server_id).unwrap();
        assert_eq!(profile.hit.name, "Londarks");
        assert!(profile.equipment["equipment"]["equipmentList"].as_array().is_some_and(|l| !l.is_empty()));
        let board = daevanion(&hit.id, hit.server_id, 71).unwrap();
        assert!(board["nodeList"].as_array().is_some_and(|l| l.len() > 100));
        let wanted = equipped(&profile);
        let found = items(&hit.id, hit.server_id, &wanted);
        assert_eq!(found.len(), wanted.len(), "os detalhes de todos os itens equipados");
    }
}
