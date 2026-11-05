use crate::store::Result;
use std::path::Path;

pub fn directory(path: &Path) -> Result<()> {
    #[cfg(windows)]
    {
        let path = path.canonicalize().map_err(|e| e.to_string())?;
        std::thread::spawn(move || {
            use std::os::windows::ffi::OsStrExt;
            use windows::{
                core::PCWSTR,
                Win32::{
                    System::Com::{
                        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
                        COINIT_APARTMENTTHREADED,
                    },
                    UI::Shell::{
                        FileOperation, IFileOperation, IShellItem, SHCreateItemFromParsingName,
                        FOFX_EARLYFAILURE, FOFX_RECYCLEONDELETE, FOF_NOCONFIRMATION, FOF_NOERRORUI,
                        FOF_SILENT,
                    },
                },
            };
            unsafe {
                CoInitializeEx(None, COINIT_APARTMENTTHREADED)
                    .ok()
                    .map_err(|e| e.to_string())?;
                struct Apartment;
                impl Drop for Apartment {
                    fn drop(&mut self) {
                        unsafe {
                            CoUninitialize();
                        }
                    }
                }
                let _apartment = Apartment;
                let operation: IFileOperation =
                    CoCreateInstance(&FileOperation, None, CLSCTX_INPROC_SERVER)
                        .map_err(|e| e.to_string())?;
                operation
                    .SetOperationFlags(
                        FOFX_RECYCLEONDELETE
                            | FOFX_EARLYFAILURE
                            | FOF_NOCONFIRMATION
                            | FOF_NOERRORUI
                            | FOF_SILENT,
                    )
                    .map_err(|e| e.to_string())?;
                // Shell parsing names do not accept Rust's canonical extended-length prefix.
                let display = path.to_string_lossy();
                let shell_path = if let Some(unc) = display.strip_prefix(r"\\?\UNC\") {
                    Path::new(r"\\").join(unc)
                } else {
                    Path::new(display.strip_prefix(r"\\?\").unwrap_or(&display)).to_path_buf()
                };
                let wide: Vec<u16> = shell_path
                    .as_os_str()
                    .encode_wide()
                    .chain(Some(0))
                    .collect();
                let item: IShellItem = SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()), None)
                    .map_err(|e| format!("无法创建回收项：{e}"))?;
                operation
                    .DeleteItem(&item, None)
                    .map_err(|e| e.to_string())?;
                operation.PerformOperations().map_err(|e| e.to_string())?;
                if operation
                    .GetAnyOperationsAborted()
                    .map_err(|e| e.to_string())?
                    .as_bool()
                    || path.exists()
                {
                    return Err("未能将删除内容移入系统回收站".into());
                }
            }
            Ok(())
        })
        .join()
        .map_err(|_| "回收站操作中断".to_string())?
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Err("当前平台暂不支持安全移入回收站".into())
    }
}
