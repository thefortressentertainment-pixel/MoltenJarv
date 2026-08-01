use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use tauri::{Manager, RunEvent};

struct HubChild(Mutex<Option<Child>>);

pub fn run() {
    tauri::Builder::default()
        .manage(HubChild(Mutex::new(None)))
        .setup(|app| {
            spawn_hub(&app.handle());
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
