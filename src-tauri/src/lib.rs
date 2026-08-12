use std::{
    fs::{self, File},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{Manager, WebviewWindow};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Default)]
struct ManagedProcesses(Mutex<Vec<Child>>);

fn project_root(app: &tauri::AppHandle) -> PathBuf {
    if cfg!(debug_assertions) {
        return PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("src-tauri has a project parent")
            .to_path_buf();
    }

    app.path()
        .resource_dir()
        .expect("Relay resource directory is available")
        .join("runtime")
}

fn workspace_dir(app: &tauri::AppHandle, root: &Path) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        return Ok(root.to_path_buf());
    }
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let workspace = home.join("RelayWorkspace");
    fs::create_dir_all(&workspace).map_err(|e| e.to_string())?;
    Ok(workspace)
}

fn data_dir(app: &tauri::AppHandle, root: &Path) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        return Ok(root.join(".relay-data"));
    }
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&data).map_err(|e| e.to_string())?;
    Ok(data)
}

fn node_binary(root: &Path) -> PathBuf {
    let bundled = root
        .join("vendor")
        .join("vscode")
        .join(".build")
        .join("node")
        .join("v24.18.1")
        .join("win32-x64")
        .join("node.exe");
    if bundled.exists() {
        bundled
    } else {
        PathBuf::from("node")
    }
}

fn port_open(port: u16) -> bool {
    TcpStream::connect_timeout(
        &SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_millis(250),
    )
    .is_ok()
}

fn log_stdio(root: &Path, name: &str) -> Result<(Stdio, Stdio), String> {
    let log_dir = if cfg!(debug_assertions) {
        root.join(".relay-data").join("logs")
    } else {
        std::env::temp_dir().join("relay-ide-logs")
    };
    fs::create_dir_all(&log_dir).map_err(|e| e.to_string())?;
    let out = File::create(log_dir.join(format!("{name}.out.log"))).map_err(|e| e.to_string())?;
    let err = File::create(log_dir.join(format!("{name}.err.log"))).map_err(|e| e.to_string())?;
    Ok((Stdio::from(out), Stdio::from(err)))
}

fn spawn_hidden(mut command: Command) -> Result<Child, String> {
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
    command.spawn().map_err(|e| e.to_string())
}

fn start_services(app: &tauri::AppHandle, window: &WebviewWindow) -> Result<(), String> {
    let root = project_root(app);
    let vscode_root = root.join("vendor").join("vscode");
    let extension_dir = root.join("relay-extensions");
    let node = node_binary(&root);
    let workspace = workspace_dir(app, &root)?;
    let relay_data = data_dir(app, &root)?;

    if !root.join("server.js").exists() {
        return Err(format!("Relay backend was not found at {}", root.display()));
    }
    if !vscode_root.join("out").join("server-main.js").exists() {
        return Err("Code-OSS is not compiled. Run npm run codeoss:compile first.".into());
    }

    let managed = app.state::<Arc<ManagedProcesses>>();

    if !port_open(4173) {
        let (stdout, stderr) = log_stdio(&root, "backend")?;
        let mut backend = Command::new(&node);
        backend
            .arg(root.join("server.js"))
            .current_dir(&root)
            .env("RELAY_WORKSPACE", &workspace)
            .env("RELAY_DATA_DIR", &relay_data)
            .stdout(stdout)
            .stderr(stderr);
        managed.0.lock().unwrap().push(spawn_hidden(backend)?);
    }

    let _ = window.eval("document.getElementById('status').textContent='Starting the Code-OSS workbench and extension host…';");

    if !port_open(3001) {
        let (stdout, stderr) = log_stdio(&root, "codeoss")?;
        let mut codeoss = Command::new(&node);
        codeoss
            .arg("out/server-main.js")
            .args(["--host", "127.0.0.1", "--port", "3001"])
            .arg("--without-connection-token")
            .arg("--accept-server-license-terms")
            .arg("--disable-telemetry")
            .arg("--disable-workspace-trust")
            .arg("--default-folder")
            .arg(&workspace)
            .arg("--extensions-dir")
            .arg(&extension_dir)
            .current_dir(&vscode_root)
            .env("RELAY_BACKEND_URL", "http://127.0.0.1:4173")
            .env("NODE_ENV", "development")
            .env("VSCODE_DEV", "1")
            .stdout(stdout)
            .stderr(stderr);
        managed.0.lock().unwrap().push(spawn_hidden(codeoss)?);
    }

    let window = window.clone();
    thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(90);
        while Instant::now() < deadline {
            if port_open(4173) && port_open(3001) {
                let _ = window.eval(
                    "document.getElementById('status').textContent='Opening your workspace…';",
                );
                thread::sleep(Duration::from_millis(350));
                let _ = window.eval("window.location.replace('http://127.0.0.1:3001/');");
                return;
            }
            thread::sleep(Duration::from_millis(250));
        }
        let _ = window.eval("document.getElementById('status').textContent='Relay could not start. See .relay-data/logs for details.';");
    });

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let processes = Arc::new(ManagedProcesses::default());
    tauri::Builder::default()
        .manage(processes)
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            let window = app.get_webview_window("main").expect("main Relay window");
            if let Err(error) = start_services(app.handle(), &window) {
                let message = serde_json::to_string(&error)
                    .unwrap_or_else(|_| "Relay failed to start".into());
                let _ = window.eval(&format!(
                    "document.getElementById('status').textContent={message};"
                ));
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let managed = window.state::<Arc<ManagedProcesses>>();
                if let Ok(mut children) = managed.0.lock() {
                    for child in children.iter_mut() {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                    children.clear();
                };
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Relay IDE");
}
