//! Kerub: medidor de dano do AION 2, com cura, dano recebido, histórico e a
//! página de qualquer personagem. O nome é o dos Kerubs, os bichinhos curiosos
//! de Atreia que ficam rodando e olhando tudo.
//!
//! Duas janelas: o client, onde fica a luta ao vivo, o histórico e as
//! escolhas, e o overlay por cima do jogo, que pode ficar desligado.
//!
//! Captura, parser do protocolo e cálculo de DPS vêm do motor de captura
//! (`motor` no Cargo.toml), usado como biblioteca. Quando um patch do jogo
//! quebrar o protocolo: `git pull` nele e um build novo aqui.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// Um arquivo da pasta `data` do motor, embutido no executável: o meter roda
/// sem nenhum arquivo do lado. Um build novo depois do `git pull` lá já pega os
/// dados novos.
macro_rules! motor_data {
    ($path:literal) => {
        include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../A2Tools-DPS-Meter/src/data/", $path))
    };
}

mod armory;
mod combats;
mod config;
mod db;
mod history;
mod live;
mod maps;

use std::collections::HashSet;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use motor::capture::captured_payload::CapturedPayload;
use motor::capture::combat_port_detector::CombatPortDetector;
use motor::capture::pcap_capturer::PcapCapturer;
use motor::combat::capture_dispatcher::CaptureDispatcher;
use motor::combat::data_storage::DataStorage;
use motor::combat::dps_calculator::DpsCalculator;
use motor::combat::ping_tracker::PingTracker;
use motor::entity::details_context::TargetDetailsResponse;
use motor::entity::dps_data::DpsData;
use motor::i18n::lookup::{NpcLookup, SkillLookup};
use motor::platform;
use parking_lot::Mutex;
use serde::Serialize;
use tauri::{App, AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tokio::sync::mpsc;

use combats::Combats;
use config::Config;
use db::Db;
use history::{FightView, SavedFight, Summary};
use live::{Fight, Heals, Row};

/// Nomes de skills e de chefes. Há também de, en, es, fr, ja, ko, ru, zh-Hans e
/// zh-Hant: troque o `pt` nos dois caminhos.
const SKILL_NAMES: &str = motor_data!("i18n/skills/pt.json");
const NPC_NAMES: &str = motor_data!("i18n/npcs/pt.json");
/// Skills que são dano ao longo do tempo (DoT).
const DOT_SKILL_IDS: &str = motor_data!("dot_skill_ids.json");
/// Ícone de cada skill, pelos 4 primeiros dígitos do código.
const SKILL_ICONS: &str = motor_data!("skill_icons.json");
/// Nome das dungeons; não há em português.
const DUNGEON_NAMES: &str = motor_data!("i18n/dungeons/en.json");
/// Nome dos buffs e debuffs, e o ícone e o máximo de acúmulos de cada um.
const ABNORMAL_NAMES: &str = motor_data!("i18n/abnormals/pt.json");
const ABNORMAL_ICONS: &str = motor_data!("abnormals.json");
/// Intervalo entre atualizações das janelas.
const TICK: Duration = Duration::from_millis(250);
/// Intervalo entre gravações de uma luta que ainda não acabou. A luta também é
/// gravada quando acaba, ao zerar, ao trocar de zona e ao fechar o meter.
const SAVE_EVERY: Duration = Duration::from_secs(15);
/// Intervalo entre leituras da tecla Del.
#[cfg(windows)]
const KEY_POLL: Duration = Duration::from_millis(25);

const CLIENT: &str = "client";
const OVERLAY: &str = "overlay";

struct Meter {
    calc: Mutex<DpsCalculator>,
    storage: Arc<DataStorage>,
    ports: Arc<CombatPortDetector>,
    ping: Arc<PingTracker>,
    npcs: Arc<NpcLookup>,
    skills: Arc<SkillLookup>,
    npcap: AtomicBool,
    /// A captura que espera o Npcap ser instalado para começar.
    pending_capture: Mutex<Option<PcapCapturer>>,
    /// A última luta que foi para as janelas, para os detalhes.
    last: Mutex<Option<(DpsData, Vec<Row>)>>,
    /// Histórico e escolhas.
    db: Db,
    /// Uma gravação por vez: a de 15 em 15 s e a de antes de zerar. Guarda
    /// as lutas comuns já gravadas.
    saving: Mutex<Combats>,
    config: Mutex<Config>,
}

#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
enum Status {
    NoNpcap,
    /// Ainda não achou a conexão do jogo.
    Waiting,
    Ok,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    status: Status,
    target: String,
    target_is_boss: bool,
    target_max_hp: i64,
    /// -1 quando o HP do alvo é desconhecido.
    target_hp: i64,
    battle_ms: i64,
    dungeon: String,
    /// A janela do AION 2 está aberta.
    game_running: bool,
    /// O ping com o servidor do jogo agora, em ms.
    ping: Option<i32>,
    rows: Vec<Row>,
}

/// Os rótulos que o motor põe no lugar do nome do alvo vêm em inglês.
fn target_label(name: &str) -> String {
    match name {
        "All Targets" => "Todos os alvos".to_string(),
        "Train" => "Boneco de treino".to_string(),
        _ => name.to_string(),
    }
}

impl Snapshot {
    fn new(data: &DpsData, status: Status, game_running: bool, ping: Option<i32>, rows: Vec<Row>) -> Self {
        let target_hp = if data.target_current_hp >= 0 {
            data.target_current_hp
        } else if data.target_max_hp > 0 {
            (data.target_max_hp - data.target_total_damage).max(0)
        } else {
            -1
        };
        Self {
            status,
            target: target_label(&data.target_name),
            target_is_boss: data.target_is_boss,
            target_max_hp: data.target_max_hp,
            target_hp,
            battle_ms: data.battle_time,
            dungeon: history::dungeon_name(data.dungeon_id),
            game_running,
            ping,
            rows,
        }
    }
}

// ── luta ao vivo ───────────────────────────────────────────────

/// Zera a luta atual, gravando antes a do chefe.
#[tauri::command]
fn reset(app: AppHandle, meter: State<Meter>) {
    save_fights(&app, true);
    meter.calc.lock().restart_target_selection(true);
}

/// A luta da tela com as skills de cada um e o DPS no tempo. Nada quando
/// ninguém bateu ainda. Sem `full`, vem sem os buffs e sem o horário de cada
/// golpe, que só a linha do tempo usa: a tela pede de segundo em segundo.
#[tauri::command]
async fn live_fight(meter: State<'_, Meter>, full: Option<bool>) -> Result<Option<FightView>, String> {
    let full = full.unwrap_or(false);
    let Some((data, rows)) = meter.last.lock().clone() else { return Ok(None) };
    if rows.is_empty() {
        return Ok(None);
    }
    let targets = live::detail_targets(&data);
    let fight = Fight::of_targets(&meter.storage, &targets);
    // Os buffs são os do alvo principal: o da tela, ou o que mais apanhou.
    let main = if data.target_id > 0 {
        data.target_id
    } else {
        fight.targets.iter().max_by_key(|t| t.total_damage).map_or(0, |t| t.target_id)
    };
    let (details, buffs) = {
        let calc = meter.calc.lock();
        let details: Vec<TargetDetailsResponse> = targets.iter().map(|&id| calc.get_target_details(id, None)).collect();
        (details, if full { calc.live_fight_buffs(main) } else { None })
    };
    let start_ms = details.iter().map(|d| d.start_time).filter(|&t| t > 0).min().unwrap_or(0);
    let jobs: std::collections::HashMap<&str, &str> = rows.iter().map(|r| (r.name.as_str(), r.job.as_str())).collect();
    let who = |id: i32| -> Option<(String, String)> {
        let (_, name) = fight.player_of(id)?;
        let job = jobs.get(name.as_str()).map(|j| j.to_string()).unwrap_or_default();
        Some((name, job))
    };
    let buffs = buffs.map(|b| {
        let mut views = history::buff_views(&b.buffs, main, &who);
        // Contados do primeiro golpe no alvo principal: passam a contar do
        // começo da luta.
        let offset = b.start_time_ms - start_ms;
        for seg in views.iter_mut().flat_map(|v| v.segs.iter_mut()) {
            seg[0] += offset;
            seg[1] += offset;
        }
        views
    });
    let train = data.target_mode == "trainTargets";
    let kind = if train {
        history::TRAIN
    } else if data.target_is_boss && targets.len() == 1 {
        history::BOSS
    } else {
        history::COMBAT
    };
    let kills = targets.iter().filter(|&&t| history::is_dead(&meter.storage, t)).count() as u32;
    let meta = history::Meta {
        id: String::new(),
        boss: target_label(&data.target_name),
        mob_code: data.target_mob_code,
        dungeon_id: data.dungeon_id,
        start_ms,
        duration_ms: data.battle_time,
        killed: data.target_id > 0 && meter.storage.is_entity_dead(data.target_id),
        train,
        kind: kind.to_string(),
        targets: targets.len() as u32,
        kills,
        max_hp: data.target_max_hp,
        buffs,
    };
    let mut view = history::build(meta, rows, &details, &|id| fight.name_of(id));
    if !full {
        for skill in view.players.iter_mut().flat_map(|p| p.skills.iter_mut().chain(p.heals.iter_mut())) {
            skill.times = Vec::new();
        }
    }
    Ok(Some(view))
}

// ── histórico ──────────────────────────────────────────────────

#[tauri::command]
async fn history_list(meter: State<'_, Meter>) -> Result<Vec<Summary>, String> {
    meter.db.list()
}

#[tauri::command]
async fn history_fight(meter: State<'_, Meter>, id: String) -> Result<FightView, String> {
    meter.db.load(&id).map(|fight| fight.view())
}

#[tauri::command]
fn history_delete(app: AppHandle, meter: State<Meter>, id: String) -> Result<(), String> {
    meter.db.delete(&id)?;
    let _ = app.emit("history", ());
    Ok(())
}

/// Grava as lutas que estão na memória: as de chefe e as comuns
/// (`combats.rs`), as que acabaram e as longas que ainda estão rolando.
/// `force` grava todas, antes de os dados sumirem.
fn save_fights(app: &AppHandle, force: bool) {
    let Some(meter) = app.try_state::<Meter>() else { return };
    let mut combats = meter.saving.lock();
    if meter.storage.damage_generation() <= 0 {
        return;
    }
    let fights: Vec<SavedFight> = {
        let mut calc = meter.calc.lock();
        let bosses = if force { calc.snapshot_boss_fights_force() } else { calc.snapshot_boss_fights() };
        let now = motor::clock::now_ms();
        let others = combats.snapshot(&meter.storage, &calc, &meter.npcs, &meter.skills, &meter.ping, force, now);
        bosses.into_iter().map(|record| SavedFight::new(&meter.storage, record)).chain(others).collect()
    };
    let mut saved = false;
    for fight in fights {
        match meter.db.save_fight(&fight) {
            Ok(()) => saved = true,
            Err(e) => tracing::warn!("não deu para gravar a luta {}: {e}", fight.record.id),
        }
    }
    if saved {
        let _ = app.emit("history", ());
    }
}

// ── personagens (site oficial) ─────────────────────────────────

/// Roda uma chamada ao site do AION 2 fora da thread das janelas.
async fn blocking<T: Send + 'static>(job: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(job).await.map_err(|e| e.to_string())?
}

/// Personagens pelo nome; `region` vazio procura nas cinco regiões.
#[tauri::command]
async fn armory_search(keyword: String, region: Option<String>) -> Result<Vec<armory::Hit>, String> {
    blocking(move || armory::search(&keyword, region.as_deref().filter(|r| !r.is_empty()))).await
}

#[derive(Serialize)]
struct SavedCharacters {
    favorites: Vec<db::SavedCharacter>,
    recent: Vec<db::SavedCharacter>,
}

#[tauri::command]
async fn armory_saved(meter: State<'_, Meter>) -> Result<SavedCharacters, String> {
    let (favorites, recent) = meter.db.saved_characters()?;
    Ok(SavedCharacters { favorites, recent })
}

#[tauri::command]
async fn armory_favorite(meter: State<'_, Meter>, hit: armory::Hit, favorite: bool) -> Result<(), String> {
    meter.db.set_favorite(&hit, favorite)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CharacterPage {
    #[serde(flatten)]
    profile: armory::Profile,
    favorite: bool,
}

/// A página de um personagem. A guardada serve se tiver até `max_age_s`
/// segundos; 0 busca no site de novo (botão de atualizar).
#[tauri::command]
async fn armory_profile(meter: State<'_, Meter>, id: String, server_id: i32, max_age_s: i64) -> Result<CharacterPage, String> {
    let now = armory::now_ms();
    if let Some((profile, favorite)) = meter.db.cached_profile(&id)? {
        if now - profile.fetched_ms <= max_age_s.saturating_mul(1000) {
            meter.db.mark_viewed(&id, now)?;
            return Ok(CharacterPage { profile, favorite });
        }
    }
    let profile = blocking(move || armory::profile(&id, server_id)).await?;
    let favorite = meter.db.save_profile(&profile, now)?;
    Ok(CharacterPage { profile, favorite })
}

/// Os detalhes de todos os itens equipados da página guardada: os que
/// faltam vêm do site agora, por trás, e ficam guardados com ela.
#[tauri::command]
async fn armory_items(
    meter: State<'_, Meter>,
    id: String,
) -> Result<std::collections::BTreeMap<String, serde_json::Value>, String> {
    let Some((profile, _)) = meter.db.cached_profile(&id)? else { return Ok(Default::default()) };
    let missing: Vec<(i64, i64, i64)> = armory::equipped(&profile)
        .into_iter()
        .filter(|&(item, enchant, slot)| !profile.items.contains_key(&armory::item_key(slot, item, enchant)))
        .collect();
    if missing.is_empty() {
        return Ok(profile.items);
    }
    let (server_id, fetched_ms) = (profile.hit.server_id, profile.fetched_ms);
    let character = id.clone();
    let found = blocking(move || Ok(armory::items(&character, server_id, &missing))).await?;
    meter.db.merge_items(&id, fetched_ms, found)
}

#[tauri::command]
async fn armory_daevanion(id: String, server_id: i32, board: i32) -> Result<serde_json::Value, String> {
    blocking(move || armory::daevanion(&id, server_id, board)).await
}

#[tauri::command]
async fn armory_item(id: String, server_id: i32, item_id: i64, enchant: i64, slot: i64) -> Result<serde_json::Value, String> {
    blocking(move || armory::item(&id, server_id, item_id, enchant, slot)).await
}

// ── mapas ──────────────────────────────────────────────────────

/// %APPDATA%\local.kerub\mapas: a cópia dos dados do mapa.
fn maps_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("mapas"))
}

/// A lista de mapas. Vai como bytes de JSON: a tela lê direto, sem o Tauri
/// converter de novo.
#[tauri::command]
async fn map_index(app: AppHandle) -> Result<tauri::ipc::Response, String> {
    let dir = maps_dir(&app)?;
    blocking(move || maps::index(&dir)).await.map(tauri::ipc::Response::new)
}

/// Os pontos de um mapa (meio MB nos maiores), também como bytes de JSON.
#[tauri::command]
async fn map_markers(app: AppHandle, key: String, generated: String) -> Result<tauri::ipc::Response, String> {
    let dir = maps_dir(&app)?;
    blocking(move || maps::markers(&dir, &key, &generated, NPC_NAMES)).await.map(tauri::ipc::Response::new)
}

// ── escolhas e janelas ─────────────────────────────────────────

#[tauri::command]
fn get_config(meter: State<Meter>) -> Config {
    meter.config.lock().clone()
}

/// Grava as escolhas, manda para as duas janelas, troca o que medir e abre
/// ou fecha o overlay.
#[tauri::command]
async fn set_config(app: AppHandle, meter: State<'_, Meter>, config: Config) -> Result<Config, String> {
    let config = config.cleaned();
    meter.db.save_config(&config)?;
    meter.calc.lock().set_target_selection_mode(&config.mode);
    *meter.config.lock() = config.clone();
    let _ = app.emit("config", &config);
    if config.overlay {
        open_overlay(&app).map_err(|e| e.to_string())?;
    } else if let Some(overlay) = app.get_webview_window(OVERLAY) {
        overlay.destroy().map_err(|e| e.to_string())?;
    }
    Ok(config)
}

/// O overlay já pôs o tamanho e o lugar salvos: aparece por cima do jogo sem
/// tirar o foco dele.
#[tauri::command]
fn overlay_ready(app: AppHandle) {
    if let Some(overlay) = app.get_webview_window(OVERLAY) {
        set_overlay_visible(&overlay, true);
    }
}

/// Mostra o overlay por cima do jogo sem tirar o foco dele, ou esconde.
fn set_overlay_visible(window: &tauri::WebviewWindow, visible: bool) {
    if visible {
        platform::window::show_on_top_without_focus(window);
        return;
    }
    #[cfg(windows)]
    if let Ok(hwnd) = window.hwnd() {
        use windows::Win32::UI::WindowsAndMessaging::{SW_HIDE, ShowWindow};
        unsafe {
            let _ = ShowWindow(windows::Win32::Foundation::HWND(hwnd.0), SW_HIDE);
        }
    }
    #[cfg(not(windows))]
    let _ = window.hide();
}

/// Traz o client para a frente (botão do overlay).
#[tauri::command]
fn show_client(app: AppHandle) {
    if let Some(client) = app.get_webview_window(CLIENT) {
        let _ = client.unminimize();
        let _ = client.show();
        let _ = client.set_focus();
    }
}

/// Um erro de JavaScript numa das janelas, para o log do meter.
#[tauri::command]
fn ui_error(window: tauri::WebviewWindow, message: String) {
    tracing::warn!("erro na janela {}: {message}", window.label());
}

/// Cria o overlay escondido; ele aparece em `overlay_ready`.
fn open_overlay(app: &AppHandle) -> tauri::Result<()> {
    if app.get_webview_window(OVERLAY).is_some() {
        return Ok(());
    }
    WebviewWindowBuilder::new(app, OVERLAY, WebviewUrl::App("overlay.html".into()))
        .title("Kerub · overlay")
        .inner_size(420.0, 230.0)
        .min_inner_size(260.0, 80.0)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .shadow(false)
        .skip_taskbar(true)
        .resizable(true)
        .visible(false)
        .build()?;
    Ok(())
}

// ── print ──────────────────────────────────────────────────────

/// Onde os prints ficam: Imagens\Kerub.
fn screenshot_dir() -> Option<std::path::PathBuf> {
    Some(platform::screenshot::default_folder()?.parent()?.join("Kerub"))
}

/// Um nome de arquivo sem nada que o Windows recuse.
fn file_name(name: &str) -> String {
    let clean: String = name.chars().map(|c| if c.is_alphanumeric() || " -_()".contains(c) { c } else { '_' }).collect();
    let clean = clean.trim();
    if clean.is_empty() { "Kerub".to_string() } else { clean.chars().take(120).collect() }
}

#[derive(Serialize)]
struct Shot {
    clipboard: bool,
    /// O PNG gravado, se deu.
    file: Option<String>,
}

/// Print de um pedaço da janela que pediu, em pixels da página (`scale` é o
/// `devicePixelRatio` dela): vai para a área de transferência e para
/// Imagens\Kerub\`name`.png. É o que está na tela: a janela precisa estar à
/// vista.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn screenshot(
    window: tauri::WebviewWindow,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    scale: f64,
    name: String,
) -> Result<Shot, String> {
    let path = screenshot_dir().map(|dir| dir.join(format!("{}.png", file_name(&name))));
    tauri::async_runtime::spawn_blocking(move || {
        let (clipboard, saved) = platform::screenshot::capture(&window, x, y, width, height, scale, None, path.as_deref());
        Shot { clipboard, file: path.filter(|_| saved).map(|p| p.display().to_string()) }
    })
    .await
    .map_err(|e| e.to_string())
}

/// Abre a pasta dos prints com a imagem escolhida.
#[tauri::command]
fn show_screenshot(file: String) -> Result<(), String> {
    let dir = screenshot_dir().ok_or("Não achei a pasta Imagens.")?;
    let path = std::path::PathBuf::from(&file);
    if path.parent() != Some(dir.as_path()) || !path.is_file() {
        return Err("Essa imagem não está mais na pasta.".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer")
            .raw_arg(format!("/select,\"{}\"", path.display()))
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ── Npcap ──────────────────────────────────────────────────────

/// Baixa o instalador do Npcap do npcap.com e abre. Quando ele fecha, a
/// captura começa se o Npcap carregar, sem abrir o meter de novo.
#[cfg(windows)]
#[tauri::command]
async fn install_npcap(meter: State<'_, Meter>) -> Result<(), String> {
    let installer = tauri::async_runtime::spawn_blocking(npcap::download).await.map_err(|e| e.to_string())??;
    let ran = {
        let installer = installer.clone();
        tauri::async_runtime::spawn_blocking(move || platform::pcap::run_installer(&installer))
            .await
            .map_err(|e| e.to_string())?
    };
    let _ = std::fs::remove_file(&installer);
    ran.map_err(|e| format!("O instalador do Npcap não abriu ({e})."))?;
    if !platform::pcap::library_available() {
        return Err("O Npcap ainda não está funcionando. Se o instalador foi fechado antes do fim, tente de novo.".into());
    }
    if let Some(capturer) = meter.pending_capture.lock().take() {
        capturer.start();
    }
    meter.npcap.store(true, Ordering::Relaxed);
    Ok(())
}

/// O instalador oficial do Npcap. A licença do Npcap gratuito não deixa ele vir
/// dentro de outro programa; baixar do npcap.com, como pede a licença, pode.
#[cfg(windows)]
mod npcap {
    use std::path::{Path, PathBuf};

    const SITE: &str = "https://npcap.com/";

    fn download_to(url: &str, path: &Path) -> Result<(), String> {
        use std::os::windows::ffi::OsStrExt;
        use windows::Win32::System::Com::Urlmon::URLDownloadToFileW;
        use windows::Win32::System::Com::{COINIT_APARTMENTTHREADED, CoInitializeEx, CoUninitialize, IBindStatusCallback};
        use windows::core::{IUnknown, PCWSTR};

        let url: Vec<u16> = url.encode_utf16().chain(Some(0)).collect();
        let file: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        // SAFETY: os dois textos terminam em zero e vivem durante a chamada.
        unsafe {
            let com = CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok();
            let result = URLDownloadToFileW(
                None::<&IUnknown>,
                PCWSTR(url.as_ptr()),
                PCWSTR(file.as_ptr()),
                0,
                None::<&IBindStatusCallback>,
            );
            if com {
                CoUninitialize();
            }
            result.map_err(|e| format!("não deu para baixar do npcap.com: {}", e.message()))
        }
    }

    /// O instalador mais novo que a página lista (`npcap-1.89.exe`). O OEM,
    /// pago, fica de fora.
    pub(crate) fn installer_name(page: &str) -> Option<String> {
        let version = |name: &str| -> Vec<u32> {
            name.trim_start_matches("npcap-").trim_end_matches(".exe").split('.').filter_map(|p| p.parse().ok()).collect()
        };
        page.match_indices("dist/npcap-")
            .filter_map(|(at, _)| {
                let rest = &page[at + "dist/".len()..];
                let name = &rest[..rest.find(".exe")? + ".exe".len()];
                let digits = &name["npcap-".len()..name.len() - ".exe".len()];
                (!digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit() || c == '.')).then(|| name.to_string())
            })
            .max_by_key(|name| version(name))
    }

    pub fn download() -> Result<PathBuf, String> {
        let dir = std::env::temp_dir();
        let page_path = dir.join("kerub-npcap.html");
        // O horário na URL evita uma página velha do cache do Windows.
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
        download_to(&format!("{SITE}?t={now}"), &page_path)?;
        let page = std::fs::read_to_string(&page_path).unwrap_or_default();
        let _ = std::fs::remove_file(&page_path);
        let name = installer_name(&page).ok_or("a página do npcap.com não mostrou o instalador")?;

        let path = dir.join(format!("kerub-{name}"));
        download_to(&format!("{SITE}dist/{name}"), &path)?;
        // Um programa do Windows, e do tamanho de um (o 1.89 tem 1,3 MB).
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        if bytes.len() < 200_000 || !bytes.starts_with(b"MZ") {
            let _ = std::fs::remove_file(&path);
            return Err("o arquivo baixado não é o instalador do Npcap".into());
        }
        Ok(path)
    }
}

// ── início ─────────────────────────────────────────────────────

/// O Kerub se chamava Aion Meter e guardava tudo em `local.aion-meter`. Na
/// primeira vez com o nome novo, o banco de lá vem para a pasta nova (lutas,
/// favoritos e escolhas). A pasta antiga fica como está.
fn bring_old_data(data_dir: &std::path::Path) {
    let Some(old_dir) = data_dir.parent().map(|parent| parent.join("local.aion-meter")) else { return };
    if data_dir.join("historico.db").exists() || !old_dir.join("historico.db").exists() {
        return;
    }
    if std::fs::create_dir_all(data_dir).is_err() {
        return;
    }
    for file in ["historico.db", "historico.db-wal", "historico.db-shm"] {
        if old_dir.join(file).exists() {
            if let Err(e) = std::fs::copy(old_dir.join(file), data_dir.join(file)) {
                tracing::warn!("não deu para trazer {file} da pasta antiga: {e}");
            }
        }
    }
}

fn setup(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    let skills = SkillLookup::new();
    skills.load_from_json(SKILL_NAMES);
    let npcs = NpcLookup::new();
    npcs.load_from_json(NPC_NAMES);
    let dot_ids: HashSet<i32> = serde_json::from_str::<Vec<i32>>(DOT_SKILL_IDS)?.into_iter().collect();
    let skills = Arc::new(skills);
    let npcs = Arc::new(npcs);

    let storage = Arc::new(DataStorage::new());
    storage.set_abnormal_stack_limits(motor::capture::abnormal::stack_limits(ABNORMAL_ICONS));
    let ping = Arc::new(PingTracker::with_perf_clock(platform::clock::perf_clock()));
    let ports = Arc::new(CombatPortDetector::new());
    let mut calc = DpsCalculator::new(storage.clone(), skills.clone(), npcs.clone(), ping.clone());

    let npcap = platform::pcap::library_available();
    let (tx, rx) = mpsc::channel::<CapturedPayload>(4096);
    let capturer = PcapCapturer::new(tx);
    if npcap {
        capturer.start();
    } else {
        tracing::error!("Npcap não está instalado: sem captura até instalar");
    }

    let mut dispatcher = CaptureDispatcher::new(storage.clone(), skills.clone(), npcs.clone(), ports.clone(), ping.clone());
    dispatcher.set_dot_skill_ids(dot_ids);
    tauri::async_runtime::spawn(async move { dispatcher.run(rx).await });

    // %APPDATA%\local.kerub\historico.db: lutas, escolhas e personagens.
    let data_dir = app.path().app_data_dir()?;
    bring_old_data(&data_dir);
    let db = Db::open(&data_dir.join("historico.db"))?;
    let config = db.load_config();
    calc.set_target_selection_mode(&config.mode);
    app.manage(Meter {
        calc: Mutex::new(calc),
        storage: storage.clone(),
        ports,
        ping,
        npcs,
        skills,
        npcap: AtomicBool::new(npcap),
        pending_capture: Mutex::new((!npcap).then_some(capturer)),
        last: Mutex::new(None),
        db,
        saving: Mutex::new(Combats::default()),
        config: Mutex::new(config.clone()),
    });

    // Trocar de zona ou sair do grupo zera a luta: grava antes.
    let handle = app.handle().clone();
    storage.set_before_reset(move || save_fights(&handle, true));

    if config.overlay {
        open_overlay(app.handle())?;
    }

    let handle = app.handle().clone();
    std::thread::spawn(move || emit_loop(handle));
    let handle = app.handle().clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(SAVE_EVERY);
            save_fights(&handle, false);
        }
    });
    #[cfg(windows)]
    {
        let handle = app.handle().clone();
        std::thread::spawn(move || hide_key_loop(handle));
    }
    Ok(())
}

/// Del esconde o overlay e Del de novo traz de volta, sem tirar o foco do jogo.
///
/// Só vale com o AION 2 ou o próprio overlay em primeiro plano, para o Del de
/// outros programas não mexer nele. A tecla é só lida, não capturada: o jogo e
/// os outros programas continuam recebendo o Del normalmente.
#[cfg(windows)]
fn hide_key_loop(handle: AppHandle) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_DELETE};
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

    let mut was_down = false;
    loop {
        std::thread::sleep(KEY_POLL);
        let down = unsafe { GetAsyncKeyState(i32::from(VK_DELETE.0)) } < 0;
        let pressed = down && !was_down;
        was_down = down;
        if !pressed {
            continue;
        }
        // O overlay pode ter sido fechado e aberto de novo: a janela é outra.
        let Some(window) = handle.get_webview_window(OVERLAY) else { continue };
        let Ok(hwnd) = window.hwnd() else { continue };
        let hwnd = HWND(hwnd.0);
        let overlay_focused = unsafe { GetForegroundWindow() } == hwnd;
        if !overlay_focused && !platform::window_detector::is_aion2_foreground() {
            continue;
        }
        let visible = window.is_visible().unwrap_or(false);
        set_overlay_visible(&window, !visible);
    }
}

/// Calcula o DPS e manda para as janelas a cada `TICK`.
fn emit_loop(handle: AppHandle) {
    let mut heals = Heals::default();
    let mut game_running = false;
    for tick in 0u64.. {
        std::thread::sleep(TICK);
        let meter = handle.state::<Meter>();
        let data = meter.calc.lock().get_dps();
        // O motor já conta dano antes de travar na conexão (ele espera uns
        // segundos para preferir o loopback de VPN/ExitLag), então dado na tela
        // também conta como conectado.
        let status = if !meter.npcap.load(Ordering::Relaxed) {
            Status::NoNpcap
        } else if meter.ports.current_port().is_none() && data.map.is_empty() {
            Status::Waiting
        } else {
            Status::Ok
        };
        let fight = Fight::load(&meter.storage, &data);
        // A cura percorre cada golpe de cura da sessão: uma vez por segundo basta.
        if tick % 4 == 0 {
            heals = Heals::load(&meter.storage, &fight);
        }
        // Procurar a janela do jogo a cada 2 s basta.
        #[cfg(windows)]
        if tick % 8 == 0 {
            game_running = platform::window_detector::find_aion2_window();
        }
        let rows = live::rows(&data, &fight, &heals, &meter.storage.get_party_members());
        let running = game_running || matches!(status, Status::Ok);
        let ping = meter.ping.current_ping_ms();
        let _ = handle.emit("meter", &Snapshot::new(&data, status, running, ping, rows.clone()));
        *meter.last.lock() = Some((data, rows));
    }
}

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn")),
        )
        .init();

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            reset,
            live_fight,
            history_list,
            history_fight,
            history_delete,
            armory_search,
            armory_saved,
            armory_favorite,
            armory_profile,
            armory_items,
            armory_daevanion,
            armory_item,
            map_index,
            map_markers,
            get_config,
            set_config,
            overlay_ready,
            show_client,
            ui_error,
            screenshot,
            show_screenshot,
            install_npcap
        ])
        .setup(setup)
        .on_window_event(|window, event| {
            // Fechar o client fecha o meter, gravando antes a luta que estiver
            // na memória. O overlay sozinho não segura o meter aberto.
            if window.label() == CLIENT && matches!(event, WindowEvent::CloseRequested { .. }) {
                let app = window.app_handle();
                save_fights(app, true);
                app.exit(0);
            }
        })
        .run(tauri::generate_context!())
        .expect("falha ao iniciar o Kerub");
}

#[cfg(test)]
mod tests {
    use super::*;
    use motor::capture::framing;
    use motor::capture::stream_processor::StreamProcessor;
    use motor::entity::details_context::DetailSkillEntry;

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    /// Um registro `04 38` (os bytes depois do opcode), num frame como o
    /// stream do jogo traz.
    fn frame(record: &str) -> Vec<u8> {
        let mut body = vec![0x04, 0x38];
        body.extend(hex(record));
        let mut length = framing::length_value(body.len());
        let mut out = Vec::new();
        loop {
            let byte = (length & 0x7F) as u8;
            length >>= 7;
            if length == 0 {
                out.push(byte);
                break;
            }
            out.push(byte | 0x80);
        }
        out.extend(body);
        out
    }

    #[test]
    fn instalador_mais_novo_e_sem_oem() {
        let page = r#"<a href="dist/npcap-1.9.exe"> <a href="dist/npcap-1.10.exe"> <a href="dist/npcap-1.10-oem.exe">"#;
        assert_eq!(npcap::installer_name(page).as_deref(), Some("npcap-1.10.exe"));
        assert_eq!(npcap::installer_name("sem instalador"), None);
    }

    /// Baixa de verdade do npcap.com (precisa de internet): `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn baixa_o_instalador_do_npcap() {
        let path = npcap::download().unwrap();
        let size = std::fs::metadata(&path).unwrap().len();
        let _ = std::fs::remove_file(&path);
        assert!(size > 200_000, "{} tem {size} bytes", path.display());
    }

    /// Cura numa luta: só a que cai entre o primeiro e o último golpe conta, e
    /// a recebida vai para quem foi curado.
    #[test]
    fn cura_recebida_vai_para_quem_foi_curado() {
        let storage = Arc::new(DataStorage::new());
        let mut parser = StreamProcessor::new(storage.clone(), Arc::new(SkillLookup::new()), Arc::new(NpcLookup::new()));
        parser.set_override_timestamp(Some(1_000));
        parser.consume_stream(&frame("b1ea011600f30a40c0f40063028000010b199b5f01000000ac52d007"));
        storage.append_heal_received(1395, 500, 1_000);
        storage.append_heal_received(1395, 700, 99_000);
        storage.append_heal_received(30001, 900, 1_000);

        let mut data = DpsData::new();
        data.target_id = 30001;
        let fight = Fight::load(&storage, &data);
        let received = live::heal_received_by_player(&storage, &fight);
        assert_eq!(received.len(), 1, "o monstro curado fica de fora");
        assert_eq!(received[&1395].amount, 500.0, "a cura fora da luta fica de fora");
    }

    /// Um golpe real de jogador (o do teste `additional_hits_are_read_from_the_record_tail`
    /// do motor: jogador 1395 no monstro 30001, 976 de dano) e o mesmo
    /// registro ao contrário, com uma skill de monstro (1200001): o monstro
    /// batendo no jogador. Isso é dano recebido, e não é dano de ninguém.
    #[test]
    fn golpe_de_monstro_em_jogador_e_dano_recebido() {
        let storage = Arc::new(DataStorage::new());
        let mut parser = StreamProcessor::new(storage.clone(), Arc::new(SkillLookup::new()), Arc::new(NpcLookup::new()));
        parser.set_override_timestamp(Some(1_000));
        parser.consume_stream(&frame("b1ea011600f30a40c0f40063028000010b199b5f01000000ac52d007"));
        parser.consume_stream(&frame("f30a1600b1ea01814f120063028000010b199b5f01000000ac52d007"));

        let fight = storage.get_target_snapshot_light(30001).expect("a luta contra o monstro");
        let player = &fight.actors[&1395];
        assert_eq!((player.total_damage, player.damage_received, player.hits_received), (976, 976, 1));
        assert_eq!(fight.actors.len(), 1, "o monstro não vira linha de dano");
        assert!(storage.get_target_snapshot_light(1395).is_none(), "o jogador não vira alvo");
    }

    fn skill(actor: i32, code: i32, dmg: i32, hits: &[i64], crit: i32, dot: bool) -> DetailSkillEntry {
        serde_json::from_value(serde_json::json!({
            "actorId": actor, "code": code, "name": format!("skill {code}"), "time": hits.len(),
            "dmg": dmg, "multiHitCount": 0, "multiHitDamage": 0, "maxDmg": dmg, "crit": crit,
            "parry": 0, "back": 0, "perfect": 0, "double": 0, "regen": 0, "isDot": dot,
            "hitTimestamps": hits,
        }))
        .unwrap()
    }

    /// Uma luta gravada de 10 s: dois jogadores, um deles curando. Os nomes
    /// mascarados do motor já foram trocados pelos de verdade.
    fn saved_fight() -> SavedFight {
        let record = serde_json::json!({
            "id": "auto_7_1000", "bossName": "Chefe", "targetId": 7, "startTimeMs": 1_700_000_000_000i64,
            "durationMs": 10_000, "totalDamage": 3000, "jobs": [], "jobIds": [], "mobCode": 99, "dungeonId": 600021,
            "details": {"targetId": 7, "maxHp": 3000, "totalTargetDamage": 3000, "battleTime": 10_000,
                        "startTime": 1_700_000_000_000i64, "skills": [], "healSkills": []},
            "actors": [
                {"actorId": 1, "nickname": "Kaelith", "job": "마도성"},
                {"actorId": 2, "nickname": "Draemor", "job": "치유성"}
            ],
        });
        let mut record: motor::entity::fight_record::FightRecord = serde_json::from_value(record).unwrap();
        record.details.skills = vec![
            skill(1, 15010000, 1000, &[0, 1000, 2000, 3000], 2, false),
            skill(1, 15020000, 1000, &[5000, 6000], 0, true),
            skill(2, 17010000, 1000, &[9000], 1, false),
        ];
        record.details.heal_skills = vec![skill(2, 17100000, 800, &[4000, 8000], 0, false)];
        SavedFight {
            format: 1,
            record,
            extra: history::Extra {
                killed: true,
                me: "Draemor".into(),
                healed: [("Kaelith".to_string(), 800)].into(),
                taken: [("Kaelith".to_string(), 450)].into(),
                ..Default::default()
            },
        }
    }

    #[test]
    fn luta_gravada_vira_linhas_skills_e_grafico() {
        let view = saved_fight().view();
        assert_eq!((view.boss.as_str(), view.killed, view.duration_ms), ("Chefe", true, 10_000));
        assert_eq!(view.dungeon, "Fire Temple");
        assert_eq!(view.total_damage, 3000.0);
        assert_eq!(view.party_dps, 300.0);

        let names: Vec<&str> = view.players.iter().map(|p| p.row.name.as_str()).collect();
        assert_eq!(names, ["Kaelith", "Draemor"], "por DPS");
        let kaelith = &view.players[0];
        assert_eq!((kaelith.row.job.as_str(), kaelith.row.dps, kaelith.row.taken, kaelith.row.healed), ("sorcerer", 200.0, 450.0, 800.0));
        assert_eq!(kaelith.row.crit, Some(50.0), "2 críticos em 4 golpes; o DoT fica fora");
        assert_eq!(kaelith.skills.len(), 2);
        let draemor = &view.players[1];
        assert!(draemor.row.me);
        assert_eq!((draemor.row.heal, draemor.heals.len()), (800.0, 1));

        let party: f64 = view.timeline.party.iter().sum::<f64>();
        assert!((party - 3000.0).abs() < 600.0, "o gráfico soma perto do dano total: {party}");
        assert_eq!(view.timeline.players.len(), 2);
    }

    #[test]
    fn historico_grava_lista_e_apaga() {
        let db = Db::in_memory();
        db.save_fight(&saved_fight()).unwrap();
        db.save_fight(&saved_fight()).unwrap();
        let list = db.list().unwrap();
        assert_eq!(list.len(), 1, "a mesma luta gravada de novo não repete");
        let fight = &list[0];
        assert_eq!((fight.me.as_str(), fight.my_dps, fight.killed, fight.detailed), ("Draemor", 100.0, true, true));
        assert_eq!(fight.jobs, ["sorcerer", "cleric"]);

        assert_eq!(db.load("auto_7_1000").unwrap().record.boss_name, "Chefe");
        assert!(db.load("outra").is_err());
        db.delete("auto_7_1000").unwrap();
        assert!(db.list().unwrap().is_empty());
    }

    #[test]
    fn escolhas_voltam_do_banco() {
        let db = Db::in_memory();
        assert_eq!(db.load_config(), Config::default());
        let mut config = Config::default();
        config.overlay = false;
        config.columns = vec!["crit".into(), "dps".into(), "inventada".into()];
        config.colors.insert("cleric".into(), "#123456".into());
        config.colors.insert("ranger".into(), "amarelo".into());
        db.save_config(&config.clone().cleaned()).unwrap();
        let back = db.load_config();
        assert!(!back.overlay);
        assert_eq!(back.columns, ["dps", "crit"], "na ordem da tabela, sem a inventada");
        assert_eq!(back.colors.len(), 1, "cor que não é #rrggbb sai");
    }

    #[test]
    fn detalhes_dos_itens_ficam_com_a_pagina() {
        let db = Db::in_memory();
        let hit: armory::Hit = serde_json::from_value(serde_json::json!({
            "id": "abc=", "name": "Londarks", "job": "cleric", "level": 45, "race": 1,
            "serverId": 1404, "server": "Kaisinel", "region": "la", "image": ""
        }))
        .unwrap();
        let profile = armory::Profile {
            hit,
            info: serde_json::json!({}),
            equipment: serde_json::json!({"equipment": {"equipmentList": [{"id": 7, "enchantLevel": 10, "slotPos": 1}]}}),
            fetched_ms: 1_000,
            items: Default::default(),
        };
        db.save_profile(&profile, 1_000).unwrap();
        assert_eq!(armory::equipped(&profile), [(7, 10, 1)]);

        let key = armory::item_key(1, 7, 10);
        let found = [(key.clone(), serde_json::json!({"name": "Maça"}))].into();
        assert_eq!(db.merge_items("abc=", 1_000, found).unwrap().len(), 1);
        let (cached, _) = db.cached_profile("abc=").unwrap().unwrap();
        assert_eq!(cached.items[&key]["name"], "Maça");

        // Detalhes de uma página que já foi trocada por uma nova não entram.
        let old = [(armory::item_key(2, 8, 0), serde_json::json!({}))].into();
        assert_eq!(db.merge_items("abc=", 999, old).unwrap().len(), 1);
    }

    #[test]
    fn icones_de_skill() {
        assert_eq!(history::skill_icon(11_000_001), "", "ataque básico");
        assert!(history::skill_icon(15_010_000).starts_with("https://assets.playnccdn.com/"));
    }

    #[test]
    fn nome_e_icone_de_buff() {
        assert_eq!(history::buff_name(100, 0), "Atordoamento");
        assert_eq!(history::buff_name(999_999_999, 0), "Efeito 999999999");
        assert!(history::buff_icons(100, 0)[0].ends_with("/ICON_Abnormal_DotMp.png"));
        assert!(history::buff_icons(999_999_999, 0).is_empty());
    }

    /// Uma luta comum gravada: tipo, alvos, buffs e ping chegam na tela.
    #[test]
    fn luta_comum_com_buffs_e_ping() {
        let mut fight = saved_fight();
        fight.extra.kind = history::COMBAT.into();
        fight.extra.targets = 3;
        fight.extra.kills = 2;
        fight.record.details.ping_history =
            serde_json::from_value(serde_json::json!([{"tsMs": 1000, "pingMs": 20}, {"tsMs": 6000, "pingMs": 35}])).unwrap();
        fight.record.buffs = Some(
            serde_json::from_value(serde_json::json!([
                {"on": 1, "id": 100, "by": 2, "skill": 17010000, "segs": "-500,4000,1,1;6000,10000,2,10", "up": 8000},
                {"on": 7, "id": 100, "by": 1, "segs": "0,3000,1,1", "up": 3000}
            ]))
            .unwrap(),
        );
        let view = fight.view();
        assert_eq!((view.kind.as_str(), view.targets, view.kills), ("combat", 3, 2));
        assert!(view.timeline.hp.is_empty(), "luta comum não tem HP de chefe");
        assert_eq!(view.ping, [history::PingView { t: 1000, ms: 20 }, history::PingView { t: 6000, ms: 35 }]);
        let buffs = view.buffs.unwrap();
        assert_eq!((buffs[0].on.as_str(), buffs[0].by.as_str(), buffs[0].by_job.as_str()), ("Kaelith", "Draemor", "cleric"));
        assert_eq!(buffs[0].segs, [[-500, 4000, 1, 1], [6000, 10000, 2, 10]]);
        assert!(buffs[1].on_target);

        let db = Db::in_memory();
        db.save_fight(&fight).unwrap();
        let summary = &db.list().unwrap()[0];
        assert_eq!((summary.kind.as_str(), summary.targets, summary.kills), ("combat", 3, 2));
    }

    #[test]
    fn hp_do_chefe_no_grafico() {
        let view = saved_fight().view();
        let hp = &view.timeline.hp;
        assert_eq!(hp.len(), 11);
        assert!(hp[0] < 100.0 && hp[0] > 50.0, "o primeiro segundo já tirou HP: {}", hp[0]);
        assert_eq!(*hp.last().unwrap(), 0.0, "morreu: termina em zero");
    }

    /// O banco de antes das lutas comuns ganha as colunas novas.
    #[test]
    fn banco_antigo_ganha_colunas() {
        let path = std::env::temp_dir().join(format!("kerub-migra-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE lutas (id TEXT PRIMARY KEY, chefe TEXT NOT NULL, mob_code INTEGER NOT NULL,
                    dungeon_id INTEGER NOT NULL, dungeon TEXT NOT NULL, inicio_ms INTEGER NOT NULL,
                    duracao_ms INTEGER NOT NULL, dano_total REAL NOT NULL, dps_grupo REAL NOT NULL,
                    derrotado INTEGER NOT NULL, boneco INTEGER NOT NULL, eu TEXT NOT NULL, meu_dps REAL NOT NULL,
                    minha_classe TEXT NOT NULL, classes TEXT NOT NULL, luta TEXT);
                 INSERT INTO lutas VALUES ('a', 'Boneco', 1, 0, '', 1, 1000, 1, 1, 0, 1, '', 0, '', '[]', NULL);
                 INSERT INTO lutas VALUES ('b', 'Chefe', 2, 0, '', 2, 1000, 1, 1, 1, 0, '', 0, '', '[]', NULL);",
            )
            .unwrap();
        }
        let db = Db::open(&path).unwrap();
        let list = db.list().unwrap();
        let kinds: Vec<(&str, u32)> = list.iter().map(|s| (s.kind.as_str(), s.kills)).collect();
        assert_eq!(kinds, [("boss", 1), ("train", 0)]);
        drop(db);
        let _ = std::fs::remove_file(&path);
    }

    /// As lutas do banco deste PC (uma cópia), como a tela recebe:
    /// `cargo test banco_de_verdade -- --ignored --nocapture`. Com
    /// `KERUB_DUMP=pasta`, grava o JSON da mais nova de cada tipo lá.
    #[test]
    #[ignore]
    fn banco_de_verdade() {
        let from = std::path::PathBuf::from(std::env::var("APPDATA").unwrap()).join("local.kerub");
        let dir = std::env::temp_dir().join("kerub-banco-teste");
        std::fs::create_dir_all(&dir).unwrap();
        for file in ["historico.db", "historico.db-wal", "historico.db-shm"] {
            let _ = std::fs::remove_file(dir.join(file));
            let _ = std::fs::copy(from.join(file), dir.join(file));
        }
        let db = Db::open(&dir.join("historico.db")).unwrap();
        let dump = std::env::var("KERUB_DUMP").ok().map(std::path::PathBuf::from);
        let mut dumped = std::collections::HashSet::new();
        for summary in db.list().unwrap().iter().filter(|s| s.detailed).take(40) {
            let view = db.load(&summary.id).unwrap().view();
            let json = serde_json::to_string(&view).unwrap();
            let me = view.players.iter().find(|p| p.row.me);
            println!(
                "{:<28} {:<6} {:>3} jogadores, {:>3} buffs, {:>2} ping, hp {:>3}, eu {:?} poder {:?}, {} KB",
                view.boss,
                view.kind,
                view.players.len(),
                view.buffs.as_ref().map_or(0, Vec::len),
                view.ping.len(),
                view.timeline.hp.len(),
                me.map(|p| &p.row.name),
                me.map(|p| p.row.power),
                json.len() / 1024
            );
            if let Some(dir) = &dump {
                if dumped.insert(view.kind.clone()) {
                    std::fs::write(dir.join(format!("luta-{}.json", view.kind)), &json).unwrap();
                }
            }
        }
    }
}
