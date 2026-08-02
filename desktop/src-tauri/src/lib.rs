use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, RunEvent};
use tauri_plugin_deep_link::DeepLinkExt;
use url::Url;

struct HubChild(Mutex<Option<Child>>);

const HUB_URL: &str = "http://127.0.0.1:3001";

/// Extract the task from `jarvgenie://run?task=<encoded command>`.
fn parse_task(url: &Url) -> Option<String> {
    if url.host_str() != Some("run") {
        return None;
    }
    for (key, value) in url.query_pairs() {
        if key == "task" && !value.trim().is_empty() {
            return Some(value.trim().to_string());
        }
    }
    None
}

pub fn run() {
    tauri::Builder::default()
        .manage(HubChild(Mutex::new(None)))
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            spawn_hub(&app.handle());

            // Where the local launcher page lives, so we can fall back to it if
            // the hub never comes up.
            let launcher_url = app
                .get_webview_window("main")
                .and_then(|w| w.url().ok().map(|u| u.to_string()))
                .unwrap_or_default();

            let handle = app.handle().clone();
            let launcher = launcher_url.clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    if let Some(task) = parse_task(&url) {
                        deliver_task(handle.clone(), launcher.clone(), task);
                        break;
                    }
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building jarv-genie desktop")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                kill_hub(app_handle);
            }
        });
}

/// Wait for the hub to answer, then open it on the given task so the chat runs
/// it the moment the page loads. Runs off the main thread so slow hub startup
/// doesn't stall the app.
fn deliver_task(app: tauri::AppHandle, launcher_url: String, task: String) {
    std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(20);
        let ready = loop {
            if hub_ready() {
                break true;
            }
            if Instant::now() > deadline {
                break false;
            }
            std::thread::sleep(Duration::from_millis(250));
        };

        let target = if ready {
            let mut url = Url::parse(HUB_URL).expect("valid hub url");
            url.query_pairs_mut().append_pair("task", &task);
            url.to_string()
        } else if !launcher_url.is_empty() {
            launcher_url
        } else {
            HUB_URL.to_string()
        };

        if let Some(win) = app.get_webview_window("main") {
            if let Ok(url) = target.parse::<Url>() {
                let _ = win.navigate(url);
            }
            let _ = win.show();
            let _ = win.set_focus();
        }
    });
}

/// True once the hub's API is answering (200 or an auth challenge 401).
fn hub_ready() -> bool {
    Command::new("/usr/bin/curl")
        .args([
            "-s",
            "-m",
            "1",
            "-o",
            "/dev/null",
            "-w",
            "%{http_code}",
            "http://127.0.0.1:3001/api/status",
        ])
        .output()
        .map(|out| {
            let code = String::from_utf8_lossy(&out.stdout);
            code.starts_with('2') || code == "401"
        })
        .unwrap_or(false)
}

/// Start the local hub server that this shell displays.
fn spawn_hub(app: &tauri::AppHandle) {
    let candidates: Vec<Vec<String>> = vec![
        // configured explicitly
        std::env::var("JARV_GENIE_BIN").map(|b| vec![b]).unwrap_or_default(),
        // on PATH
        vec!["jarv-genie".to_string()],
        // dev layout: node dist/index.js from the repo root
        vec![
            "node".to_string(),
            "dist/index.js".to_string(),
            "hub".to_string(),
            "--host".to_string(),
            "127.0.0.1".to_string(),
            "--port".to_string(),
            "3001".to_string(),
            "--no-open".to_string(),
        ],
    ];

    let mut cmd = None;
    for mut c in candidates {
        if c.is_empty() {
            continue;
        }
        let is_node_dev = c[0] == "node";
        let mut args = if is_node_dev { c.split_off(2) } else { c.split_off(1) };
        if !is_node_dev {
            args = vec![
                "hub".to_string(),
                "--host".to_string(),
                "127.0.0.1".to_string(),
                "--port".to_string(),
                "3001".to_string(),
                "--no-open".to_string(),
            ];
        }
        match Command::new(&c[0])
            .args(&args)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(child) => {
                cmd = Some(child);
                break;
            }
            Err(_) => continue,
        }
    }

    if let Some(child) = cmd {
        if let Some(state) = app.try_state::<HubChild>() {
            if let Ok(mut guard) = state.0.lock() {
                *guard = Some(child);
            }
        }
    }
}

fn kill_hub(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<HubChild>() {
        if let Ok(mut guard) = state.0.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}
