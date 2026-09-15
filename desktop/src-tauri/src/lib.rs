// 音转文 桌面外壳
//
// 只做四件事：
//   1) 起一个只监听 127.0.0.1 的本地 HTTP 服务
//   2) 用这个服务同时提供**页面**和 726MB 的离线模型
//   3) 把窗口指向它
//   4) 提供原生「另存为」能力（导出 TXT / HTML 用）
//
// ---------------------------------------------------------------------------
// 为什么页面也要走本地服务，而不是用 Tauri 自带的自定义协议
//
// 这是本项目最反直觉、也最要命的一处。Tauri 在 macOS 上默认用
// `tauri://localhost` 提供页面。但 **WKWebView 不把自定义协议当成
// 「安全上下文」**，哪怕主机名是 localhost。实测（在构建出的 app 里回传）：
//
//     origin = tauri://localhost
//     navigator.mediaDevices  →  undefined
//     self.crossOriginIsolated →  false
//
// 后果是三个功能同时坏掉，而且都不报错：
//   a) navigator.mediaDevices 不存在 → **根本录不了音**（这是个录音软件）
//   b) COOP/COEP 不生效 → 拿不到 SharedArrayBuffer → ORT 只能单线程，
//      10 核用 1 核，一分钟录音要等四分钟
//   c) 顺带地，安全上下文相关的 API 一律不可用
//
// 换成 `http://127.0.0.1:<port>` 之后三个问题一起消失 —— 环回地址按
// 「Secure Contexts」规范属于 potentially trustworthy，是安全上下文，
// 而且 http 是标准协议，WebKit 会正常处理 COOP/COEP。
//
// 注意：`tauri.conf.json` 里的 `app.security.headers` 是**有效**的
// （实测响应里确实带上了 cross-origin-opener-policy / embedder-policy），
// 只是 WebKit 对自定义协议不认这两个头。所以那两个头留着无害，
// 真正起作用的是这里的本地服务。
// ---------------------------------------------------------------------------
//
// 代价：页面变成「远程来源」，IPC 要额外配两处
//
// 走 http://127.0.0.1 换来安全上下文，但同时页面在 Tauri 眼里不再是本地
// 内容，于是 invoke 会被来源检查拦下。这不是 bug，是 Tauri 的安全设计 ——
// 远程内容默认碰不到任何命令，包括应用自己的命令。
//
// 实测：只写 capabilities/default.json 的 remote.urls 不够，仍然报
//   Command model_base_url not allowed by ACL
// 因为 remote.urls 只回答「哪个来源可以用这套权限」，命令本身能不能被授予
// 还得在 permissions/ 里声明。两处都配齐才通，见：
//   - capabilities/default.json   （来源 + 引用哪些权限）
//   - permissions/voice-type.toml （声明这两个命令可被授予）
// ---------------------------------------------------------------------------
//
// 为什么模型不放进 frontendDist：
//   Tauri 会把 frontendDist 整个嵌进可执行文件。726MB 的模型进去，
//   产物会变成一个 726MB 的 Mach-O / PE。所以模型走 bundle.resources
//   放到应用资源目录，由本地服务按需读取。
//
// 为什么模型用本地 HTTP 而不是自定义协议：
//   自定义协议的响应体是一次性缓冲的（http::Response<Vec<u8>>），
//   405MB 的 encoder 会被整个读进内存。本地服务支持 Range 和流式发送。
//
// 安全性：只绑定 127.0.0.1，端口由系统随机分配；模型路径做规范化并校验
// 必须落在模型目录内，挡掉 ../ 穿越；页面资源只从内嵌资源里取，不碰文件系统。
//
// 为什么逻辑放在 lib.rs 而不是 main.rs：
//   Tauri v2 的移动端（iOS / Android）入口是库里的 `run()`，由
//   #[tauri::mobile_entry_point] 生成桥接代码，Cargo.toml 里的
//   [lib] name = "voicetype_lib" 指的就是这个。如果全写在 main.rs 里，
//   桌面端能编译，但 `tauri ios build` 会因为找不到库目标而失败。
//   main.rs 现在只剩一行调用。

use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

use tauri::{AppHandle, Manager};

static MODEL_ROOT: OnceLock<PathBuf> = OnceLock::new();
static SERVER_PORT: OnceLock<u16> = OnceLock::new();

/// 跨源隔离三件套。
///
/// 前两个是「让页面进入跨源隔离状态」的开关（同时具备才有效），
/// 第三个是给跨源资源用的（同源本来不需要，带上便于以后拆分端口）。
/// 页面就在这个服务上，所以这些头会跟着文档响应一起发出去。
const ISOLATION_HEADERS: &str = "Cross-Origin-Opener-Policy: same-origin\r\n\
                                 Cross-Origin-Embedder-Policy: require-corp\r\n\
                                 Cross-Origin-Resource-Policy: cross-origin\r\n";

/// 解析模型目录：优先应用资源目录，开发时回退到仓库里的 models/
fn resolve_model_root(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(dir) = app.path().resource_dir() {
        let p = dir.join("models");
        if p.is_dir() {
            return Some(p);
        }
    }

    // 开发模式：desktop/src-tauri/../../models
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("models");
    if dev.is_dir() {
        return Some(dev);
    }

    None
}

/// 把请求路径规范化，并确认没有越出模型根目录。
/// 返回 None 表示这个路径不合法，直接 403。
fn safe_join(root: &Path, url_path: &str) -> Option<PathBuf> {
    // 去掉查询串和开头的 /
    let clean = url_path.split('?').next().unwrap_or("").trim_start_matches('/');
    if clean.is_empty() {
        return None;
    }

    let rel = Path::new(clean);
    // 只接受普通路径段：任何 .. / 绝对路径 / 前缀（Windows 盘符）一律拒绝
    for c in rel.components() {
        match c {
            Component::Normal(_) => {}
            _ => return None,
        }
    }

    let joined = root.join(rel);
    // 再确认一次结果确实在 root 下
    if joined.starts_with(root) {
        Some(joined)
    } else {
        None
    }
}

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "json" => "application/json; charset=utf-8",
        "txt" => "text/plain; charset=utf-8",
        "onnx" | "bin" | "data" => "application/octet-stream",
        "wasm" => "application/wasm",
        "mjs" | "js" => "text/javascript; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// 只写响应头。
///
/// `content_length` 特意单独传进来，而不是从 body 推 —— 因为 HEAD 要能报出
/// **真实**的文件大小，而它并不带体。HEAD 的头部必须和 GET 完全一致，
/// 只是没有 body；回 `Content-Length: 0` 会让做预检的客户端把大文件当成空文件。
fn write_head(
    stream: &mut TcpStream,
    status: &str,
    extra: &str,
    content_length: u64,
) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 {status}\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Access-Control-Allow-Headers: *\r\n\
         Access-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges\r\n\
         {ISOLATION_HEADERS}\
         {extra}\
         Content-Length: {content_length}\r\n\
         Connection: close\r\n\r\n"
    );
    stream.write_all(head.as_bytes())
}

fn respond(
    stream: &mut TcpStream,
    status: &str,
    extra: &str,
    body: &[u8],
) -> std::io::Result<()> {
    write_head(stream, status, extra, body.len() as u64)?;
    stream.write_all(body)?;
    stream.flush()
}

/// 只实现 GET / HEAD。
///
/// 路由规则：先看模型目录里有没有这个文件，有就从磁盘流式发（几百 MB，
/// 要支持 Range）；没有就当作前端资源，从编译期内嵌的资源里取。
/// 这样前端不用区分「模型」和「页面」两套地址，一个 origin 全包了。
fn handle(stream: &mut TcpStream, root: &Path, app: &AppHandle) {
    let mut reader = BufReader::new(match stream.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    });

    let mut request_line = String::new();
    if reader.read_line(&mut request_line).is_err() {
        return;
    }

    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("/");

    // 把请求头读干净，否则连接关闭时可能触发 RST
    let mut range_hdr: Option<String> = None;
    loop {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {
                let t = line.trim_end();
                if t.is_empty() {
                    break;
                }
                if let Some(v) = t.strip_prefix("Range:").or_else(|| t.strip_prefix("range:")) {
                    range_hdr = Some(v.trim().to_string());
                }
            }
            Err(_) => break,
        }
    }

    if method != "GET" && method != "HEAD" {
        let _ = respond(stream, "405 Method Not Allowed", "", b"method not allowed");
        return;
    }

    let clean = target.split('?').next().unwrap_or("/");
    let clean = clean.trim_start_matches('/');
    let clean = if clean.is_empty() { "index.html" } else { clean };

    // 1) 模型文件（磁盘）
    if let Some(path) = safe_join(root, clean) {
        if path.is_file() {
            serve_file(stream, &path, method, range_hdr.as_deref());
            return;
        }
    }

    // 2) 前端资源（编译期内嵌）
    match app.asset_resolver().get_for_scheme(clean.to_string(), false) {
        Some(asset) => {
            let mut extra = format!("Content-Type: {}\r\n", asset.mime_type);

            // CSP 必须自己转发出去。
            //
            // Tauri 在构建时就把 app.security.csp 处理成了「这一份文档专用」的
            // CSP —— 页面里内联脚本/样式的 sha256 是那时候算好注入的，结果放在
            // csp_header 里（见 tauri 的 manager/mod.rs::get_asset，以及
            // protocol/tauri.rs 里同样的用法）。但页面现在由**这个**服务提供，
            // Tauri 那套给响应挂头的逻辑不会经过这里。
            //
            // 漏掉它的后果是 CSP **静默失效**：页面照常运行、什么错都不报，
            // 只是再没有任何脚本来源限制。属于平时看不出来、出事才发现的那种洞。
            if let Some(csp) = asset.csp_header.as_deref() {
                extra.push_str(&format!("Content-Security-Policy: {csp}\r\n"));
            }

            // 页面本身绝不缓存：不然升级后用户还在跑旧代码，排查起来极费劲。
            // 其余静态资源带指纹的是少数，所以也只给一个短缓存。
            extra.push_str(if clean.ends_with(".html") {
                "Cache-Control: no-store\r\n"
            } else {
                "Cache-Control: public, max-age=3600\r\n"
            });

            let body: &[u8] = if method == "HEAD" { b"" } else { &asset.bytes };
            let _ = respond(stream, "200 OK", &extra, body);
        }
        None => {
            let _ = respond(stream, "404 Not Found", "", b"not found");
        }
    }
}

/// 从磁盘发一个文件，支持 Range（onnxruntime 取大文件时会带 Range）。
///
/// 三条分支都**流式**发送，任何一条都不会把整个文件读进内存：
/// Range → `File::take(len)`；HEAD → 只回头；GET → `io::copy`。
/// 模型最大 424 MB，翻倍一次的代价在 iOS 上就是被系统杀掉的区别。
fn serve_file(stream: &mut TcpStream, path: &Path, method: &str, range_hdr: Option<&str>) {
    let meta = match fs::metadata(path) {
        Ok(m) if m.is_file() => m,
        _ => {
            let _ = respond(stream, "404 Not Found", "", b"not found");
            return;
        }
    };
    let total = meta.len();

    if let Some(spec) = range_hdr {
        if let Some(rest) = spec.strip_prefix("bytes=") {
            let mut it = rest.split('-');
            let start: u64 = it.next().unwrap_or("").trim().parse().unwrap_or(0);
            let end: u64 = it
                .next()
                .unwrap_or("")
                .trim()
                .parse()
                .unwrap_or(total.saturating_sub(1));
            let end = end.min(total.saturating_sub(1));
            if start <= end {
                let len = end - start + 1;
                let extra = format!(
                    "Accept-Ranges: bytes\r\nContent-Range: bytes {start}-{end}/{total}\r\n\
                     Content-Type: {}\r\nCache-Control: public, max-age=31536000, immutable\r\n",
                    content_type(path)
                );
                match fs::File::open(path) {
                    Ok(mut f) => {
                        if f.seek(SeekFrom::Start(start)).is_ok()
                            && write_head(stream, "206 Partial Content", &extra, len).is_ok()
                        {
                            // 流式发这一段，不再先 vec![0u8; len] 全读进来。
                            // Range 未必是小段 —— onnxruntime 也会发 `bytes=0-`
                            // 这种「整份文件」的 Range，一次性分配等于重演下面那个
                            // 内存问题。改成边读边写后，峰值只跟 8KB 缓冲区有关。
                            let mut limited = f.take(len);
                            let _ = std::io::copy(&mut limited, &mut *stream);
                            let _ = stream.flush();
                        }
                    }
                    Err(_) => {
                        let _ = respond(stream, "500 Internal Server Error", "", b"read error");
                    }
                }
                return;
            }
        }
    }

    let ct = format!(
        "Content-Type: {}\r\nAccept-Ranges: bytes\r\n\
         Cache-Control: public, max-age=31536000, immutable\r\n",
        content_type(path)
    );

    // HEAD：只回头不回体，但 Content-Length 必须是**真实**大小。
    // 以前 HEAD 会掉进下面那条分支，于是既报了 Content-Length: 0，
    // 又为了回一个空体把 424 MB 的模型整个读进了内存。
    if method == "HEAD" {
        let _ = write_head(stream, "200 OK", &ct, total);
        return;
    }

    // GET（无 Range）：流式发，不要 fs::read。
    // 以前这里是 fs::read(path)，会先把整个文件读进内存再写出去 ——
    // 一个 424 MB 的 encoder 就先占 424 MB 堆，和 onnxruntime 自己的 WASM 堆
    // 叠加。macOS 上还能忍，iOS 上这种瞬时翻倍很容易被 jetsam 直接杀掉。
    match fs::File::open(path) {
        Ok(mut f) => {
            if write_head(stream, "200 OK", &ct, total).is_ok() {
                let _ = std::io::copy(&mut f, &mut *stream);
                let _ = stream.flush();
            }
        }
        Err(_) => {
            let _ = respond(stream, "500 Internal Server Error", "", b"read error");
        }
    }
}

/// 起本地服务（页面 + 模型），返回端口。失败返回 None（前端会退回联网下载）。
fn start_server(root: PathBuf, app: AppHandle) -> Option<u16> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).ok()?;
    let port = listener.local_addr().ok()?.port();

    std::thread::spawn(move || {
        for incoming in listener.incoming() {
            match incoming {
                Ok(mut stream) => {
                    let root = root.clone();
                    let app = app.clone();
                    // 每个请求一个线程：模型读取是长任务，不能阻塞后续请求
                    std::thread::spawn(move || handle(&mut stream, &root, &app));
                }
                Err(_) => break,
            }
        }
    });

    Some(port)
}

/// 前端启动后调用这个拿本地服务地址；服务没起来时返回空串。
#[tauri::command]
fn model_base_url() -> String {
    match SERVER_PORT.get() {
        Some(p) => format!("http://127.0.0.1:{p}/"),
        None => String::new(),
    }
}

/// 弹出原生「另存为」并把文本写到用户选的位置。
/// 返回落盘路径；用户取消时返回空串。
///
/// 为什么自己写，而不是用 fs 插件的 writeTextFile：
///   插件命令要过 ACL，而 ACL 是按来源（origin）配的。页面现在由
///   http://127.0.0.1:<port> 提供，属于「远程来源」，要放行 fs 插件就得
///   把 scope 开到 ** —— 权限反而更宽，配置也更啰嗦。
///   写成应用命令更划算：写文件的边界天然就是「用户在原生对话框里选了
///   什么就写什么」，不需要给任何通配 scope。
///
///   ⚠️ 但应用命令**不是**免 ACL 的，这一点很容易踩坑。来源一旦不是本地
///   （页面在 http://127.0.0.1 上就属于这种情况），webview/mod.rs 那道闸
///   的 `!is_local` 会把应用命令一并纳入检查，实测报
///   「Command save_text_file not allowed by ACL」。
///   所以本命令必须在 permissions/voice-type.toml 里声明，并由
///   capabilities/default.json 按远程来源放行 —— 两个文件的注释里有完整说明。
///
/// blocking_save_file 会阻塞当前线程等用户操作，所以这个命令必须是 async ——
/// 命令体跑在异步运行时的线程上，主线程仍然能跑事件循环把对话框弹出来。
/// 如果写成同步命令，就会在主线程上阻塞，对话框永远出不来（死锁）。
#[tauri::command]
async fn save_text_file(
    app: AppHandle,
    default_name: String,
    contents: String,
) -> Result<String, String> {
    use tauri_plugin_dialog::DialogExt;

    let ext = default_name
        .rsplit('.')
        .next()
        .filter(|e| !e.is_empty() && *e != default_name)
        .unwrap_or("txt")
        .to_string();
    let label = ext.to_uppercase();

    let picked = app
        .dialog()
        .file()
        .set_file_name(&default_name)
        .add_filter(&label, &[ext.as_str()])
        .blocking_save_file();

    let Some(file_path) = picked else {
        return Ok(String::new()); // 用户取消，不算失败
    };
    let path = file_path.into_path().map_err(|e| e.to_string())?;
    fs::write(&path, contents).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

/// 应用入口。
///
/// `mobile_entry_point` 这个宏只在 iOS / Android 目标下展开，桌面端是空操作。
/// 但 Cargo.toml 里的 [lib] 目标是必须的 —— 移动端链接的是这个库，
/// 找不到库目标就会在 `tauri ios build` 阶段直接报错。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle().clone();

            // 先起服务，再建窗口 —— 窗口的地址要等端口定下来才知道。
            let root = resolve_model_root(&handle);
            let port = match root {
                Some(r) => {
                    let p = start_server(r.clone(), handle.clone());
                    if let Some(p) = p {
                        let _ = MODEL_ROOT.set(r);
                        let _ = SERVER_PORT.set(p);
                    }
                    p
                }
                None => None,
            };

            // 服务起不来就退回 Tauri 自带协议。那样录音会不可用（不是安全上下文），
            // 但至少窗口能开、能看到界面，比白屏强。
            let url = match port {
                Some(p) => tauri::WebviewUrl::External(
                    tauri::Url::parse(&format!("http://127.0.0.1:{p}/index.html"))
                        .expect("本地服务地址不合法"),
                ),
                None => tauri::WebviewUrl::App("index.html".into()),
            };

            // ⚠️ 标题栏样式是 **macOS 专属** API，不能无条件挂在链上。
            //
            // `title_bar_style` / `TitleBarStyle` 只在 macOS 目标上存在
            // （它是给 NSWindow 设 titlebar 外观的）。Windows 上
            // WebviewWindowBuilder 根本没有这个方法，编译器直接报
            //   error[E0599]: no method named `title_bar_style`
            // 而且它还会「贴心地」建议一个名字相近的 `scroll_bar_style`，
            // 按它的建议改会静默变成另一个效果 —— 千万别照做。
            //
            // 这也是为什么 DMG 一直编得过、Windows 却炸：本地只跑过 macOS。
            // 修法是用 cfg 把这一句圈起来，只在苹果目标上追加。
            let mut win = tauri::WebviewWindowBuilder::new(app, "main", url)
                .title("音转文")
                .inner_size(1120.0, 780.0)
                .min_inner_size(400.0, 560.0)
                .center();

            // 透明（Overlay）标题栏：让标题栏浮在内容上，macOS 原生观感。
            #[cfg(target_os = "macos")]
            {
                win = win.title_bar_style(tauri::TitleBarStyle::Overlay);
            }

            win.build()?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![model_base_url, save_text_file])
        .run(tauri::generate_context!())
        .expect("音转文启动失败");
}
