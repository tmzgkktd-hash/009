// 音转文 · 可执行入口
//
// 真正的逻辑全在 lib.rs（Tauri v2 要求移动端入口是一个库里的 run()）。
// 这里刻意只留一行，避免桌面端和移动端各维护一份启动代码。

// 发布版不弹控制台窗口（只对 Windows 生效，其他平台是空操作）
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    voicetype_lib::run()
}
