//! Native OLE drag source for clip rows (ADDENDUM v28-B, hardened v29-A).
//!
//! The DOM DataTransfer path (clipDrag.ts) only offers text flavors, which is
//! why text drops work everywhere but images/files can never land in chat
//! upload zones or Explorer (those require CF_HDROP — a format Chromium will
//! not synthesize). This module runs a real `DoDragDrop` with a per-clip
//! `IDataObject`:
//!
//! - text/code/link: CF_UNICODETEXT (+ CF_TEXT), CF_HTML when stored.
//! - image: CF_HDROP over a staged temp copy (lifetime spans the drag) +
//!   CF_UNICODETEXT/CF_TEXT holding the path (consoles, text-only targets).
//! - file clip: CF_HDROP with the real paths + CF_UNICODETEXT/CF_TEXT paths.
//!
//! Only DROPEFFECT_COPY is ever allowed, so supported targets always report
//! COPY and the circle-slash cursor is unreachable for them.
//!
//! Crash-safety (v29-A audit — the drag modal loop used to run on a thread-
//! pool worker while the WebView owned the window, and offered exotic
//! virtual-file/DIB formats through a hand-rolled IStream):
//! - the drag is initiated ONLY on the main STA thread via
//!   `run_on_main_thread` (posted window message), where OleInitialize
//!   state is known;
//! - a `compare_exchange` busy guard rejects concurrent/rapid-spam drags;
//! - every HRESULT-returning COM entry point is wrapped in `catch_unwind`
//!   (panic -> E_FAIL, never across FFI), all out-pointers null-checked;
//! - the payload is minimal (HDROP + unicode/ansi text + HTML) — no
//!   FileGroupDescriptor/Contents IStream, no BMP transcode, no private
//!   flavors no target consumes;
//! - a process-global panic hook logs message + backtrace to stderr and
//!   `carbon_crash.log` before abort, so any future crash is attributable.
//!
//! COM plumbing is hand-rolled vtables (not the `implement!` macro): this
//! crate mixes windows 0.58 interfaces with a direct windows-core 0.61
//! dependency, and the macro's generated `::windows_core` paths resolve to
//! the wrong core version. Explicit vtables keep every type on 0.58.

use std::sync::{
    atomic::{AtomicU32, AtomicU64, Ordering},
    mpsc, Mutex,
};

use tauri::{AppHandle, State};
use windows::{
    core::{GUID, HRESULT, IUnknown, IUnknown_Vtbl, Interface, PCWSTR},
    Win32::{
        Foundation::{
            BOOL, E_FAIL, E_NOINTERFACE, E_NOTIMPL, E_POINTER, HGLOBAL, S_FALSE, S_OK,
            DV_E_FORMATETC, DRAGDROP_S_CANCEL, DRAGDROP_S_DROP, DRAGDROP_S_USEDEFAULTCURSORS,
        },
        System::{
            Com::{
                IDataObject, IDataObject_Vtbl, IEnumFORMATETC, IEnumFORMATETC_Vtbl, FORMATETC,
                STGMEDIUM, DATADIR_GET, DVASPECT_CONTENT, TYMED_HGLOBAL,
            },
            DataExchange::RegisterClipboardFormatW,
            Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE},
            Ole::{
                DoDragDrop, OleInitialize, OleUninitialize, IDropSource, IDropSource_Vtbl,
                DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_NONE,
            },
            SystemServices::{MK_LBUTTON, MK_RBUTTON, MODIFIERKEYS_FLAGS},
        },
    },
};

use crate::{paste::log_diag, AppState};

use std::sync::atomic::AtomicBool;

/// True while a native OLE drag is in progress. Checked by the overlay's
/// focus-loss handler to suppress auto-hide — without this, DoDragDrop
/// captures the mouse, the overlay loses focus, hide_overlay_window fires,
/// and the window disappears from under the drag (crash / flash).
static NATIVE_DRAG_ACTIVE: AtomicBool = AtomicBool::new(false);

pub fn is_native_drag_active() -> bool {
    NATIVE_DRAG_ACTIVE.load(Ordering::SeqCst)
}

/// Process-global crash hook (A1): log the panic message + backtrace to
/// stderr AND an always-on `carbon_crash.log` before abort, so a future
/// drag crash records WHICH thread died and where (pair with WER/Event
/// Viewer + the .dmp for attribution). Idempotent — installs once.
/// Call from `run()` before the Tauri builder starts.
pub fn install_crash_hook() {
    static INSTALLED: AtomicBool = AtomicBool::new(false);
    if INSTALLED.swap(true, Ordering::SeqCst) {
        return;
    }
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        let name = thread.name().unwrap_or("<unnamed>");
        let bt = std::backtrace::Backtrace::force_capture();
        let line = format!("[CARBON_CRASH] thread='{name}' panic={info}\n{bt}");
        eprintln!("{line}");
        log_diag(&format!("[CARBON_CRASH] thread='{name}' panic={info}"));
        // Backtraces are long — persist the full text to disk (best effort).
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open("carbon_crash.log")
        {
            use std::io::Write as _;
            let _ = writeln!(f, "{line}");
        }
        prev(info);
    }));
    log_diag("[NATIVE_DRAG] crash hook installed (panic -> carbon_crash.log + backtrace)");
}

/// FFI boundary guard (A2-ii): a Rust panic must never unwind across an
/// `extern "system"` frame into OLE (undefined behavior -> abort). Every
/// HRESULT-returning COM entry point below funnels through here and degrades
/// to E_FAIL. Bodies are written in tail-expression style (no `return`)
/// so they fit the closure.
fn guard_hresult(label: &'static str, f: impl FnOnce() -> HRESULT + std::panic::UnwindSafe) -> HRESULT {
    match std::panic::catch_unwind(f) {
        Ok(hr) => hr,
        Err(_) => {
            log_diag(&format!("[NATIVE_DRAG] PANIC across FFI in {label} -> E_FAIL"));
            E_FAIL
        }
    }
}

// ── Drag lifecycle telemetry (A1) ────────────────────────────────────────
// DoDragDrop callbacks fire at input rate; log the first of each kind plus
// totals at return so a crash dump / diag log shows exactly how far the
// drag got: threshold -> posted -> entered -> OleInit -> DoDragDrop ->
// first-QI -> first-GetData -> ticks -> settled/returned.
static FIRST_QI: AtomicBool = AtomicBool::new(false);
static FIRST_GETDATA: AtomicBool = AtomicBool::new(false);
static FIRST_TICK: AtomicBool = AtomicBool::new(false);
static GETDATA_COUNT: AtomicU64 = AtomicU64::new(0);
static TICK_COUNT: AtomicU64 = AtomicU64::new(0);

fn reset_drag_telemetry() {
    FIRST_QI.store(false, Ordering::SeqCst);
    FIRST_GETDATA.store(false, Ordering::SeqCst);
    FIRST_TICK.store(false, Ordering::SeqCst);
    GETDATA_COUNT.store(0, Ordering::SeqCst);
    TICK_COUNT.store(0, Ordering::SeqCst);
}

// Win32 clipboard format ids (constant across sessions).
const CF_TEXT: u32 = 1;
const CF_HDROP: u32 = 15;
const CF_UNICODETEXT: u32 = 13;

fn hr_failed(hr: HRESULT) -> bool {
    hr.0 < 0
}

fn wide_null(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn register_format(name: &str) -> u32 {
    unsafe {
        let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        RegisterClipboardFormatW(PCWSTR(wide.as_ptr()))
    }
}

fn hglobal_from_bytes(bytes: &[u8]) -> windows::core::Result<HGLOBAL> {
    unsafe {
        let h = GlobalAlloc(GMEM_MOVEABLE, bytes.len().max(1))?;
        let ptr = GlobalLock(h);
        if ptr.is_null() {
            return Err(windows::core::Error::from_win32());
        }
        if !bytes.is_empty() {
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr as *mut u8, bytes.len());
        }
        let _ = GlobalUnlock(h);
        Ok(h)
    }
}

fn utf16_bytes(s: &str) -> Vec<u8> {
    let wide = wide_null(s);
    let mut out = Vec::with_capacity(wide.len() * 2);
    for w in wide {
        out.extend_from_slice(&w.to_le_bytes());
    }
    out
}

// ── Offered formats ──

enum OfferData {
    Global(Vec<u8>),
}

struct Offer {
    cf_format: u32,
    tymed: u32,
    lindex: i32,
    data: OfferData,
}

impl Offer {
    fn fmtetc(&self) -> FORMATETC {
        FORMATETC {
            cfFormat: self.cf_format as u16,
            ptd: std::ptr::null_mut(),
            dwAspect: DVASPECT_CONTENT.0,
            lindex: self.lindex,
            tymed: self.tymed,
        }
    }
}

fn hdrop_bytes(paths: &[String]) -> Vec<u8> {
    // DROPFILES header: pFiles=20, pt=(0,0), fNC=0, fWide=1 (LE u32s).
    let mut out = vec![0u8; 20];
    out[0..4].copy_from_slice(&20u32.to_le_bytes());
    out[16..20].copy_from_slice(&1u32.to_le_bytes());
    for p in paths {
        out.extend_from_slice(&utf16_bytes(p));
    }
    out.extend_from_slice(&[0u8, 0u8]);
    out
}

// ── Temp-file staging (A3) ───────────────────────────────────────────────
// Image clips are materialized as a temp copy whose lifetime spans the whole
// drag: HDROP must point at a stable on-disk path for the entire modal loop,
// and a fresh name with the original extension keeps extension-sniffing
// targets (chat upload zones, editors) accepting the drop. The staging dir
// is removed after DoDragDrop returns (Drop impl below). File clips already
// reference real paths and need no staging.

static DRAG_STAGE_COUNTER: AtomicU64 = AtomicU64::new(0);

struct StagedDrag {
    dir: std::path::PathBuf,
}

fn stage_image_temp(src: &str, clip_id: &str) -> std::io::Result<(StagedDrag, std::path::PathBuf)> {
    let n = DRAG_STAGE_COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("CarbonDrag-{clip_id}-{n}"));
    std::fs::create_dir_all(&dir)?;
    let src_path = std::path::Path::new(src);
    let fname = src_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("clip-image");
    let mut staged = dir.join(fname);
    if staged.extension().is_none() {
        staged.set_extension("png");
    }
    std::fs::copy(src, &staged)?;
    log_diag(&format!(
        "[NATIVE_DRAG] staged temp copy '{}' ({} bytes)",
        staged.display(),
        staged.metadata().map(|m| m.len()).unwrap_or(0)
    ));
    Ok((StagedDrag { dir }, staged))
}

impl Drop for StagedDrag {
    fn drop(&mut self) {
        if std::fs::remove_dir_all(&self.dir).is_ok() {
            log_diag(&format!(
                "[NATIVE_DRAG] cleaned staged dir '{}'",
                self.dir.display()
            ));
        }
    }
}

/// Minimal robust payload (A3): CF_UNICODETEXT (+ CF_TEXT), CF_HDROP over a
/// staged temp file for images (lifetime spans the drag via the returned
/// guard), optional CF_HTML. Returns the offers plus the staging guard
/// (None when nothing was staged) — the caller must keep the guard alive
/// until DoDragDrop returns.
fn build_offers(item: &crate::db::ClipItem, cf_html: u32) -> (Vec<Offer>, Option<StagedDrag>) {
    let mut offers = Vec::new();
    let kind = item.content_type.as_str();

    // Plain + ANSI text for text-like clips.
    if matches!(kind, "text" | "code" | "link" | "email" | "color") {
        let text = item.text_content.clone().unwrap_or_else(|| item.title.clone());
        offers.push(Offer {
            cf_format: CF_UNICODETEXT,
            tymed: TYMED_HGLOBAL.0 as u32,
            lindex: -1,
            data: OfferData::Global(utf16_bytes(&text)),
        });
        offers.push(Offer {
            cf_format: CF_TEXT,
            tymed: TYMED_HGLOBAL.0 as u32,
            lindex: -1,
            data: OfferData::Global(text.bytes().chain(std::iter::once(0)).collect()),
        });
        if kind == "link" {
            offers.push(Offer {
                cf_format: cf_html,
                tymed: TYMED_HGLOBAL.0 as u32,
                lindex: -1,
                data: OfferData::Global(
                    crate::paste::wrap_in_cf_html(&format!("<a href=\"{text}\">{text}</a>"))
                        .into_bytes(),
                ),
            });
        } else if let Some(ref html) = item.html_content {
            let cf = if html.starts_with("Version:") {
                html.clone()
            } else {
                crate::paste::wrap_in_cf_html(html)
            };
            offers.push(Offer {
                cf_format: cf_html,
                tymed: TYMED_HGLOBAL.0 as u32,
                lindex: -1,
                data: OfferData::Global(cf.into_bytes()),
            });
        }
        return (offers, None);
    }

    // Image clips: HDROP over the staged temp copy + path text for
    // consoles and text-only targets. No virtual descriptors, no DIB.
    if kind == "image" {
        if let Some(ref path) = item.image_path {
            if std::path::Path::new(path).exists() {
                match stage_image_temp(path, &item.id) {
                    Ok((guard, staged_path)) => {
                        let ps = staged_path.to_string_lossy().into_owned();
                        offers.push(Offer {
                            cf_format: CF_HDROP,
                            tymed: TYMED_HGLOBAL.0 as u32,
                            lindex: -1,
                            data: OfferData::Global(hdrop_bytes(std::slice::from_ref(&ps))),
                        });
                        offers.push(Offer {
                            cf_format: CF_UNICODETEXT,
                            tymed: TYMED_HGLOBAL.0 as u32,
                            lindex: -1,
                            data: OfferData::Global(utf16_bytes(&ps)),
                        });
                        offers.push(Offer {
                            cf_format: CF_TEXT,
                            tymed: TYMED_HGLOBAL.0 as u32,
                            lindex: -1,
                            data: OfferData::Global(ps.bytes().chain(std::iter::once(0)).collect()),
                        });
                        return (offers, Some(guard));
                    }
                    Err(e) => {
                        log_diag(&format!(
                            "[NATIVE_DRAG] staging failed for '{path}': {e} — text fallback"
                        ));
                    }
                }
            } else {
                log_diag(&format!(
                    "[NATIVE_DRAG] image file missing, file formats skipped: {path}"
                ));
            }
        }
    }

    // File clips: HDROP over the real paths + path text.
    if kind == "file" {
        if let Some(ref json) = item.file_paths {
            if let Ok(paths) = serde_json::from_str::<Vec<String>>(json) {
                let live: Vec<String> = paths
                    .into_iter()
                    .filter(|p| std::path::Path::new(p).exists())
                    .collect();
                if !live.is_empty() {
                    offers.push(Offer {
                        cf_format: CF_HDROP,
                        tymed: TYMED_HGLOBAL.0 as u32,
                        lindex: -1,
                        data: OfferData::Global(hdrop_bytes(&live)),
                    });
                    offers.push(Offer {
                        cf_format: CF_UNICODETEXT,
                        tymed: TYMED_HGLOBAL.0 as u32,
                        lindex: -1,
                        data: OfferData::Global(utf16_bytes(&live.join("\r\n"))),
                    });
                    offers.push(Offer {
                        cf_format: CF_TEXT,
                        tymed: TYMED_HGLOBAL.0 as u32,
                        lindex: -1,
                        data: OfferData::Global(
                            live.join("\r\n").bytes().chain(std::iter::once(0)).collect(),
                        ),
                    });
                    return (offers, None);
                }
            }
        }
    }

    // Fallback for anything else: title/text as unicode.
    let text = item.text_content.clone().unwrap_or_else(|| item.title.clone());
    offers.push(Offer {
        cf_format: CF_UNICODETEXT,
        tymed: TYMED_HGLOBAL.0 as u32,
        lindex: -1,
        data: OfferData::Global(utf16_bytes(&text)),
    });
    (offers, None)
}

// ── Hand-rolled COM plumbing ─────────────────────────────────────────────
// One IUnknown triple per object type (unique fn names via the macro).

macro_rules! com_unknown {
    ($t:ty, $qi:ident, $add:ident, $rel:ident, [$($iid:expr),*]) => {
        unsafe extern "system" fn $qi(
            this: *mut std::ffi::c_void,
            riid: *const GUID,
            ppv: *mut *mut std::ffi::c_void,
        ) -> HRESULT {
            guard_hresult(stringify!($qi), || unsafe {
                if this.is_null() || ppv.is_null() || riid.is_null() {
                    E_POINTER
                } else {
                    let want = &*riid;
                    let ok = *want == IUnknown::IID $(|| *want == $iid)*;
                    if !ok {
                        *ppv = std::ptr::null_mut();
                        E_NOINTERFACE
                    } else {
                        let o = &*(this as *const $t);
                        o.refs.fetch_add(1, Ordering::SeqCst);
                        *ppv = this;
                        if !FIRST_QI.swap(true, Ordering::SeqCst) {
                            log_diag("[NATIVE_DRAG] first QueryInterface (object alive, refs additive)");
                        }
                        S_OK
                    }
                }
            })
        }
        unsafe extern "system" fn $add(this: *mut std::ffi::c_void) -> u32 {
            unsafe { (&*(this as *const $t)).refs.fetch_add(1, Ordering::SeqCst) + 1 }
        }
        unsafe extern "system" fn $rel(this: *mut std::ffi::c_void) -> u32 {
            unsafe {
                let prev = (&*(this as *const $t)).refs.fetch_sub(1, Ordering::SeqCst);
                if prev == 1 {
                    drop(Box::from_raw(this as *mut $t));
                    0
                } else {
                    prev - 1
                }
            }
        }
    };
}

// NOTE (A3): the in-memory IStream (FileContents virtual-file) surface was
// deleted - virtual descriptors are gone (HDROP over a staged temp file
// covers chat zones, consoles, and Explorer with far less vtbl surface).

// ── COM: format enumerator ───────────────────────────────────────────────

#[repr(C)]
struct FormatEnumerator {
    vtbl: *const IEnumFORMATETC_Vtbl,
    refs: AtomicU32,
    formats: Vec<FORMATETC>,
    pos: Mutex<usize>,
}

com_unknown!(FormatEnumerator, fmt_qi, fmt_add, fmt_rel, [IEnumFORMATETC::IID]);

unsafe extern "system" fn fmt_next(
    this: *mut std::ffi::c_void,
    celt: u32,
    rgelt: *mut FORMATETC,
    pceltfetched: *mut u32,
) -> HRESULT {
    guard_hresult("fmt_next", || unsafe {
        if this.is_null() || (celt > 0 && rgelt.is_null()) {
            E_POINTER
        } else {
            let o = &*(this as *const FormatEnumerator);
            match o.pos.lock() {
                Err(_) => HRESULT::from_win32(5),
                Ok(mut pos) => {
                    let mut fetched = 0u32;
                    while fetched < celt && *pos < o.formats.len() {
                        *rgelt.add(fetched as usize) = o.formats[*pos];
                        *pos += 1;
                        fetched += 1;
                    }
                    if !pceltfetched.is_null() {
                        *pceltfetched = fetched;
                    }
                    if fetched == celt {
                        S_OK
                    } else {
                        S_FALSE
                    }
                }
            }
        }
    })
}

unsafe extern "system" fn fmt_skip(this: *mut std::ffi::c_void, celt: u32) -> HRESULT {
    guard_hresult("fmt_skip", || unsafe {
        if this.is_null() {
            E_POINTER
        } else {
            let o = &*(this as *const FormatEnumerator);
            match o.pos.lock() {
                Err(_) => HRESULT::from_win32(5),
                Ok(mut pos) => {
                    *pos = (*pos + celt as usize).min(o.formats.len());
                    if *pos >= o.formats.len() {
                        S_FALSE
                    } else {
                        S_OK
                    }
                }
            }
        }
    })
}

unsafe extern "system" fn fmt_reset(this: *mut std::ffi::c_void) -> HRESULT {
    guard_hresult("fmt_reset", || unsafe {
        if this.is_null() {
            E_POINTER
        } else {
            let o = &*(this as *const FormatEnumerator);
            match o.pos.lock() {
                Ok(mut pos) => {
                    *pos = 0;
                    S_OK
                }
                Err(_) => HRESULT::from_win32(5),
            }
        }
    })
}

unsafe extern "system" fn fmt_clone(
    this: *mut std::ffi::c_void,
    out: *mut *mut std::ffi::c_void,
) -> HRESULT {
    guard_hresult("fmt_clone", || unsafe {
        if this.is_null() || out.is_null() {
            E_POINTER
        } else {
            let o = &*(this as *const FormatEnumerator);
            match o.pos.lock() {
                Err(_) => HRESULT::from_win32(5),
                Ok(guard) => {
                    let pos = *guard;
                    let boxed = Box::new(FormatEnumerator {
                        vtbl: &FORMATENUM_VTBL,
                        refs: AtomicU32::new(1),
                        formats: o.formats.clone(),
                        pos: Mutex::new(pos),
                    });
                    *out = Box::into_raw(boxed) as *mut std::ffi::c_void;
                    S_OK
                }
            }
        }
    })
}

static FORMATENUM_VTBL: IEnumFORMATETC_Vtbl = IEnumFORMATETC_Vtbl {
    base__: IUnknown_Vtbl {
        QueryInterface: fmt_qi,
        AddRef: fmt_add,
        Release: fmt_rel,
    },
    Next: fmt_next,
    Skip: fmt_skip,
    Reset: fmt_reset,
    Clone: fmt_clone,
};

// ── COM: drop source + data object ───────────────────────────────────────

#[repr(C)]
struct ClipDropSource {
    vtbl: *const IDropSource_Vtbl,
    refs: AtomicU32,
}

com_unknown!(ClipDropSource, src_qi, src_add, src_rel, [IDropSource::IID]);

unsafe extern "system" fn src_query_continue(
    _this: *mut std::ffi::c_void,
    fescapepressed: BOOL,
    grfkeystate: MODIFIERKEYS_FLAGS,
) -> HRESULT {
    guard_hresult("src_query_continue", || {
        TICK_COUNT.fetch_add(1, Ordering::SeqCst);
        if !FIRST_TICK.swap(true, Ordering::SeqCst) {
            log_diag("[NATIVE_DRAG] first QueryContinueDrag tick (modal loop alive)");
        }
        if fescapepressed.as_bool() {
            DRAGDROP_S_CANCEL
        } else if grfkeystate.0 & (MK_LBUTTON.0 | MK_RBUTTON.0) == 0 {
            DRAGDROP_S_DROP
        } else {
            S_OK
        }
    })
}

unsafe extern "system" fn src_feedback(
    _this: *mut std::ffi::c_void,
    _dweffect: DROPEFFECT,
) -> HRESULT {
    // Default cursors: the copy cursor shows for our COPY-only drags.
    // Pure function — no telemetry here (fires per mouse move); the
    // QueryContinueDrag tick counter above tracks loop liveness.
    DRAGDROP_S_USEDEFAULTCURSORS
}

static DROPSOURCE_VTBL: IDropSource_Vtbl = IDropSource_Vtbl {
    base__: IUnknown_Vtbl {
        QueryInterface: src_qi,
        AddRef: src_add,
        Release: src_rel,
    },
    QueryContinueDrag: src_query_continue,
    GiveFeedback: src_feedback,
};

#[repr(C)]
struct ClipDataObject {
    vtbl: *const IDataObject_Vtbl,
    refs: AtomicU32,
    offers: Vec<Offer>,
}

com_unknown!(ClipDataObject, data_qi, data_add, data_rel, [IDataObject::IID]);

impl ClipDataObject {
    unsafe fn this<'a>(this: *mut std::ffi::c_void) -> &'a Self {
        &*(this as *const Self)
    }

    fn find(&self, fmt: &FORMATETC) -> Option<&Offer> {
        self.offers.iter().find(|o| {
            o.cf_format as u16 == fmt.cfFormat && o.tymed == fmt.tymed && o.lindex == fmt.lindex
        })
    }

    fn list_kinds(&self) -> String {
        self.offers
            .iter()
            .map(|o| format!("cf={} tymed={} idx={}", o.cf_format, o.tymed, o.lindex))
            .collect::<Vec<_>>()
            .join(",")
    }
}

fn fill_medium(offer: &Offer) -> windows::core::Result<STGMEDIUM> {
    unsafe {
        let OfferData::Global(bytes) = &offer.data;
        let h = hglobal_from_bytes(bytes)?;
        let mut medium: STGMEDIUM = std::mem::zeroed();
        medium.tymed = TYMED_HGLOBAL.0 as u32;
        medium.u.hGlobal = h;
        Ok(medium)
    }
}

unsafe extern "system" fn data_getdata(
    this: *mut std::ffi::c_void,
    pformatetcin: *const FORMATETC,
    pmedium: *mut STGMEDIUM,
) -> HRESULT {
    guard_hresult("data_getdata", || unsafe {
        if this.is_null() || pformatetcin.is_null() || pmedium.is_null() {
            E_POINTER
        } else {
            GETDATA_COUNT.fetch_add(1, Ordering::SeqCst);
            if !FIRST_GETDATA.swap(true, Ordering::SeqCst) {
                log_diag("[NATIVE_DRAG] first GetData (target is pulling formats)");
            }
            let o = ClipDataObject::this(this);
            let fmt = &*pformatetcin;
            match o.find(fmt) {
                Some(offer) => match fill_medium(offer) {
                    Ok(medium) => {
                        *pmedium = medium;
                        log_diag(&format!("[NATIVE_DRAG] GetData served cf={}", fmt.cfFormat));
                        S_OK
                    }
                    Err(_) => HRESULT::from_win32(8),
                },
                None => {
                    log_diag(&format!(
                        "[NATIVE_DRAG] GetData queried-vs-offered MISS cf={} tymed={} idx={} (offered: {})",
                        fmt.cfFormat,
                        fmt.tymed,
                        fmt.lindex,
                        o.list_kinds()
                    ));
                    DV_E_FORMATETC
                }
            }
        }
    })
}

unsafe extern "system" fn data_notimpl_2(
    _this: *mut std::ffi::c_void,
    _a: *const FORMATETC,
    _b: *mut STGMEDIUM,
) -> HRESULT {
    E_NOTIMPL
}

unsafe extern "system" fn data_query(
    this: *mut std::ffi::c_void,
    pformatetc: *const FORMATETC,
) -> HRESULT {
    guard_hresult("data_query", || unsafe {
        if this.is_null() || pformatetc.is_null() {
            E_POINTER
        } else {
            let o = ClipDataObject::this(this);
            match o.find(&*pformatetc) {
                Some(_) => S_OK,
                None => DV_E_FORMATETC,
            }
        }
    })
}

unsafe extern "system" fn data_notimpl_2b(
    _this: *mut std::ffi::c_void,
    _a: *const FORMATETC,
    _b: *mut FORMATETC,
) -> HRESULT {
    E_NOTIMPL
}

unsafe extern "system" fn data_setdata(
    _this: *mut std::ffi::c_void,
    _a: *const FORMATETC,
    _b: *const STGMEDIUM,
    _c: BOOL,
) -> HRESULT {
    E_NOTIMPL
}

unsafe extern "system" fn data_enum(
    this: *mut std::ffi::c_void,
    dwdirection: u32,
    out: *mut *mut std::ffi::c_void,
) -> HRESULT {
    // DATADIR_GET only; drag sources never accept SetData enumeration.
    if dwdirection != DATADIR_GET.0 as u32 {
        return E_NOTIMPL;
    }
    guard_hresult("data_enum", || unsafe {
        if this.is_null() || out.is_null() {
            E_POINTER
        } else {
            let o = ClipDataObject::this(this);
            let boxed = Box::new(FormatEnumerator {
                vtbl: &FORMATENUM_VTBL,
                refs: AtomicU32::new(1),
                formats: o.offers.iter().map(Offer::fmtetc).collect(),
                pos: Mutex::new(0),
            });
            *out = Box::into_raw(boxed) as *mut std::ffi::c_void;
            S_OK
        }
    })
}

unsafe extern "system" fn data_notimpl_4(
    _this: *mut std::ffi::c_void,
    _a: *const FORMATETC,
    _b: u32,
    _c: *mut std::ffi::c_void,
    _d: *mut u32,
) -> HRESULT {
    E_NOTIMPL
}

unsafe extern "system" fn data_notimpl_1u(
    _this: *mut std::ffi::c_void,
    _a: u32,
) -> HRESULT {
    E_NOTIMPL
}

unsafe extern "system" fn data_notimpl_0out(
    _this: *mut std::ffi::c_void,
    _out: *mut *mut std::ffi::c_void,
) -> HRESULT {
    E_NOTIMPL
}

static DATAOBJECT_VTBL: IDataObject_Vtbl = IDataObject_Vtbl {
    base__: IUnknown_Vtbl {
        QueryInterface: data_qi,
        AddRef: data_add,
        Release: data_rel,
    },
    GetData: data_getdata,
    GetDataHere: data_notimpl_2,
    QueryGetData: data_query,
    GetCanonicalFormatEtc: data_notimpl_2b,
    SetData: data_setdata,
    EnumFormatEtc: data_enum,
    DAdvise: data_notimpl_4,
    DUnadvise: data_notimpl_1u,
    EnumDAdvise: data_notimpl_0out,
};

fn new_data_object(offers: Vec<Offer>) -> IDataObject {
    let boxed = Box::new(ClipDataObject {
        vtbl: &DATAOBJECT_VTBL,
        refs: AtomicU32::new(1),
        offers,
    });
    unsafe { IDataObject::from_raw(Box::into_raw(boxed) as *mut std::ffi::c_void) }
}

fn new_drop_source() -> IDropSource {
    let boxed = Box::new(ClipDropSource {
        vtbl: &DROPSOURCE_VTBL,
        refs: AtomicU32::new(1),
    });
    unsafe { IDropSource::from_raw(Box::into_raw(boxed) as *mut std::ffi::c_void) }
}

// ── Entry point ──────────────────────────────────────────────────────────

fn effect_name(effect: u32) -> &'static str {
    if effect & DROPEFFECT_COPY.0 != 0 {
        "copy"
    } else if effect == DROPEFFECT_NONE.0 {
        "none"
    } else {
        "other"
    }
}

/// Starts a native OLE drag for a clip. Blocks until the drop settles and
/// returns the negotiated effect ("copy" expected; "none" is logged as a
/// violation since only COPY is ever allowed).
///
/// Threading (A2-i): the WebView invokes this command from its `dragstart`
/// handler, but `DoDragDrop` runs ONLY on the main STA thread — the modal
/// body is posted via `run_on_main_thread` and the command blocks on a
/// channel. A `compare_exchange` busy guard rejects concurrent drags
/// (rapid-spam protection): only one modal loop can exist at a time.
pub fn begin_clip_drag(
    state: &State<'_, AppState>,
    app: &AppHandle,
    id: String,
) -> std::result::Result<String, String> {
    if NATIVE_DRAG_ACTIVE
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        log_diag(&format!(
            "[NATIVE_DRAG] VIOLATION: concurrent dragstart rejected id='{id}' (spam guard)"
        ));
        return Err("native drag already in progress".to_string());
    }
    let outcome = begin_clip_drag_inner(state, app, &id);
    NATIVE_DRAG_ACTIVE.store(false, Ordering::SeqCst);
    outcome
}

fn begin_clip_drag_inner(
    state: &State<'_, AppState>,
    app: &AppHandle,
    id: &str,
) -> std::result::Result<String, String> {
    let item = state
        .db
        .get_entry_by_id(id)?
        .ok_or_else(|| format!("clip not found: {id}"))?;

    let cf_html = register_format("HTML Format");
    let (offers, staged) = build_offers(&item, cf_html);
    log_diag(&format!(
        "[NATIVE_DRAG] begin id='{}' type='{}' offering {} formats (staged={})",
        item.id,
        item.content_type,
        offers.len(),
        staged.is_some()
    ));
    reset_drag_telemetry();

    let (tx, rx) = mpsc::channel();
    log_diag(&format!(
        "[NATIVE_DRAG] drag message posted to main STA thread id='{id}'"
    ));
    if let Err(e) = app.run_on_main_thread(move || {
        // Contain OUR panics: unwinding through the wry event loop would
        // abort the process. COM callbacks carry their own per-entry guards.
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe {
            run_modal_drag(offers, staged)
        }));
        let outcome = match result {
            Ok(r) => r,
            Err(_) => {
                log_diag("[NATIVE_DRAG] PANIC on main STA thread during drag -> error");
                Err("native drag panicked".to_string())
            }
        };
        let _ = tx.send(outcome);
    }) {
        return Err(format!("failed to post drag to main thread: {e}"));
    }

    match rx.recv() {
        Ok(Ok(effect)) => {
            if effect != "copy" {
                log_diag(&format!(
                    "[NATIVE_DRAG] VIOLATION: drop settled with effect='{effect}' on a COPY-only drag id='{id}'"
                ));
            } else {
                log_diag(&format!("[NATIVE_DRAG] drop settled COPY id='{id}'"));
            }
            Ok(effect)
        }
        Ok(Err(e)) => Err(e),
        Err(_) => Err("native drag channel vanished".to_string()),
    }
}

/// Modal drag body. Runs ONLY on the main STA thread (A2-i/iv): OleInitialize
/// state is logged, DoDragDrop entered/returned is logged, and the staging
/// guard is dropped (temp cleanup) after the loop settles.
unsafe fn run_modal_drag(
    offers: Vec<Offer>,
    staged: Option<StagedDrag>,
) -> std::result::Result<String, String> {
    unsafe {
        log_diag("[NATIVE_DRAG] handler entered on main STA thread");
        match OleInitialize(None) {
            Ok(()) => log_diag("[NATIVE_DRAG] OleInitialize ok (S_OK or S_FALSE/already-init)"),
            Err(e) => {
                log_diag(&format!(
                    "[NATIVE_DRAG] OleInitialize FAILED: {e:?} — aborting drag"
                ));
                return Err(format!("OleInitialize failed: {e:?}"));
            }
        }
        struct OleGuard;
        impl Drop for OleGuard {
            fn drop(&mut self) {
                unsafe {
                    OleUninitialize();
                }
            }
        }
        let _guard = OleGuard;
        // Keep the temp staging alive for the whole modal loop.
        let _staged = staged;
        let dataobj = new_data_object(offers);
        let source = new_drop_source();
        // COPY-only: supported targets always report COPY, so the
        // circle-slash cursor is unreachable for them.
        let mut effect = DROPEFFECT_NONE;
        log_diag("[NATIVE_DRAG] DoDragDrop entered");
        let hr = DoDragDrop(&dataobj, &source, DROPEFFECT_COPY, &mut effect);
        // Release OUR initial refs via IUnknown (only IUnknown::drop
        // calls Release; dropping the typed wrappers alone would leak).
        // OLE has already released its own references by now.
        let unk_data: IUnknown = dataobj
            .cast()
            .map_err(|e| format!("QI IUnknown failed: {e:?}"))?;
        let unk_src: IUnknown = source
            .cast()
            .map_err(|e| format!("QI IUnknown failed: {e:?}"))?;
        drop(dataobj);
        drop(source);
        drop(unk_data);
        drop(unk_src);
        drop(_staged);
        log_diag(&format!(
            "[NATIVE_DRAG] DoDragDrop returned hr={hr:?} effect={} (getdata={} ticks={})",
            effect_name(effect.0),
            GETDATA_COUNT.load(Ordering::SeqCst),
            TICK_COUNT.load(Ordering::SeqCst),
        ));
        if hr_failed(hr) {
            return Err(format!("native drag failed: {hr:?}"));
        }
        Ok(effect_name(effect.0).to_string())
    }
}

#[tauri::command]
pub fn begin_native_drag(
    state: State<'_, AppState>,
    app: AppHandle,
    id: String,
) -> std::result::Result<String, String> {
    begin_clip_drag(&state, &app, id)
}
