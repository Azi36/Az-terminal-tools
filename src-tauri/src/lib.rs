//! Az-term 引擎入口。
//! SSH / SFTP 已在线，FTP 随后长出来。

// 所有 #[tauri::command] 共用 SshError 这一个错误类型：里面装着中文提示、
// 原始细节、指纹卡、认证问题几样东西，确实不小。clippy 建议 Box 起来省栈，
// 但命令调用本来就是一次 IPC，这点栈不值得让每个 ? 都套一层 Box。
#![allow(clippy::result_large_err)]

mod creds;
mod encoding;
mod hosts;
mod localfs;
mod sftp;
mod ssh;
mod sshconfig;
mod tunnel;

/// 前端探活：确认 Rust 引擎在线
#[tauri::command]
fn engine_ping() -> String {
    format!("engine ok · v{}", env!("CARGO_PKG_VERSION"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        // 自动更新：桌面版才有，检查是用户点的，不后台偷偷连网
        .setup(|app| {
            #[cfg(any(target_os = "windows", target_os = "macos"))]
            app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
            let _ = app;
            Ok(())
        })
        // 窗口真没了才断开所有 SSH，不把连接留在那儿占着。
        // 只认 Destroyed：CloseRequested 时前端可能还要拦一句"还有会话连着"，
        // 用户点了"算了"窗口还在，这时会话不能已经被掐掉。
        .on_window_event(|window, event| {
            use tauri::Manager;
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let state = window.app_handle().state::<ssh::SshState>().inner().clone();
                tauri::async_runtime::block_on(state.close_all());
            }
        })
        .manage(ssh::SshState::default())
        .manage(sftp::SftpState::default())
        .manage(tunnel::TunnelState::default())
        .invoke_handler(tauri::generate_handler![
            engine_ping,
            ssh::ssh_connect,
            ssh::ssh_answer,
            ssh::ssh_cancel_auth,
            ssh::ssh_write,
            ssh::ssh_set_encoding,
            ssh::ssh_log_start,
            ssh::ssh_log_stop,
            ssh::ssh_resize,
            ssh::ssh_close,
            sftp::sftp_list,
            sftp::sftp_mkdir,
            sftp::sftp_rename,
            sftp::sftp_remove,
            sftp::sftp_download,
            sftp::sftp_upload,
            sftp::sftp_stat,
            sftp::sftp_cancel,
            sftp::sftp_copy,
            sftp::sftp_read_text,
            sftp::sftp_write_text,
            sftp::sftp_chmod,
            sftp::sftp_touch,
            localfs::local_home,
            localfs::local_drives,
            localfs::local_list,
            localfs::local_mkdir,
            localfs::local_touch,
            localfs::local_rename,
            localfs::local_remove,
            localfs::local_join,
            localfs::local_stat,
            localfs::local_copy,
            localfs::local_places,
            localfs::local_read_text,
            localfs::local_write_text,
            creds::creds_has,
            creds::creds_forget,
            hosts::hosts_forget,
            sshconfig::ssh_config_hosts,
            tunnel::tunnel_open,
            tunnel::tunnel_close,
            tunnel::tunnel_list,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Az-term");
}
