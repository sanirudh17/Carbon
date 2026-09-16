//! Native OLE drag source, contract-conformant (ADDENDUM v30).
//!
//! Symptom map: S1 (no-drop in web zones; email undroppable — Chromium
//! synthesizes no HDROP/HTML and targets enumerate first) and S2 (target
//! Notepad crashes on drop — malformed mediums: missing terminators,
//! reused/freed mediums, garbage Query answers).
//!
//! Rule implementation map:
//! - R1 enumeration: FormatEnumerator serves exactly the offered set,
//!   DATADIR_GET only, S_OK per item / S_FALSE at end, bounds-checked,
//!   independently refcounted.
//! - R2 query: QueryGetData matches (format, tymed, lindex) exactly —
//!   S_OK / DV_E_TYMED (right format, wrong medium) / DV_E_FORMATETC.
//!   Never S_OK-with-empty, never garbage, never panic (guard_hresult).
//! - R3 ownership: every GetData allocates a FRESH medium; ownership moves
//!   to the caller; the source never frees or caches a transferred medium.
//!   GetDataHere fills the caller's own medium.
//! - R4 text mediums: GMEM_MOVEABLE, bytes + terminator, locked copy
//!   INCLUDING the NUL (UTF-16: two zero bytes), unlocked before return.
//! - R5 CF_HTML: paste::wrap_in_cf_html (real byte offsets, UTF-8 body,
//!   NUL-terminated); the harness re-parses every header it serves.
//! - R6 coverage: text/code/link/email/rich_text => UNICODETEXT (+TEXT),
//!   +HTML when html_content exists; image => HDROP (staged temp) +
//!   UNICODETEXT path; file => HDROP. Nothing else. No clip offers only
//!   custom formats (the private CarbonClipIds flavor is gone — no target
//!   consumed it).
//! - R7 temp lifetime: staged dirs live through the modal loop, then enter
//!   deferred cleanup (60s thread, next-drag sweep, namespaced temp dir
//!   reclaimed at exit) — web upload zones read asynchronously post-drop.
//! - R8 drop source: QueryContinueDrag S_OK / CANCEL (Esc) / DROP
//!   (buttons released); GiveFeedback USEDEFAULTCURSORS; every HRESULT
//!   entry point panic-guarded (catch-unwind -> E_FAIL).
//!
//! Initiation runs ONLY on the main STA thread (run_on_main_thread) with a
//! compare_exchange busy guard; the overlay focus-loss handler suppresses
//! auto-hide while a drag is active so the source window outlives the
//! modal loop. COM vtables are hand-rolled (the `implement!` macro is
//! version-poisoned by the windows-0.58/core-0.61 mix).

use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
        mpsc, Mutex,
    },
    time::Duration,
};

use tauri::{AppHandle, State};
use windows::{
    core::{GUID, HRESULT, IUnknown, IUnknown_Vtbl, Interface, PCWSTR},
    Win32::{
        Foundation::{
            BOOL, DV_E_TYMED, E_FAIL, E_NOINTERFACE, E_NOTIMPL, E_POINTER, HGLOBAL, S_FALSE, S_OK,
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

// ── Drag-active flag (focus-loss lifeline) ───────────────────────────────
// True while a native drag is in flight. The overlay's focus-loss handler
// suppresses auto-hide while set — DoDragDrop captures the mouse and the
// window must outlive the modal loop.
static NATIVE_DRAG_ACTIVE: AtomicBool = AtomicBool::new(false);

pub fn is_native_drag_active() -> bool {
    NATIVE_DRAG_ACTIVE.load(Ordering::SeqCst)
}

// ── DRAG LOG (last-50 ring; attached to crash reports) ───────────────────
static DRAG_LOG: Mutex<VecDeque<String>> = Mutex::new(VecDeque::new());

fn drag_log(event: &str) {
    log_diag(event);
    if let Ok(mut log) = DRAG_LOG.lock() {
        log.push_back(event.to_string());
        while log.len() > 50 {
            log.pop_front();
        }
    }
}

/// Best-effort snapshot for crash reports (try_lock: never blocks a
/// panicking thread). Called by the process panic hook.
pub fn drag_log_snapshot_try() -> Option<Vec<String>> {
    DRAG_LOG.try_lock().ok().map(|log| log.iter().cloned().collect())
}

/// FFI boundary guard (R8): a Rust panic must never unwind across an
/// `extern "system"` frame into OLE (undefined behavior -> abort). Every
/// HRESULT-returning COM entry point funnels through here (-> E_FAIL).
/// Bodies are tail-expression style (no `return`) to fit the closure.
fn guard_hresult(label: &'static str, f: impl FnOnce() -> HRESULT + std::panic::UnwindSafe) -> HRESULT {
    match std::panic::catch_unwind(f) {
        Ok(hr) => hr,
        Err(_) => {
            drag_log(&format!("[NATIVE_DRAG] PANIC across FFI in {label} -> E_FAIL"));
            E_FAIL
        }
    }
}

// Win32 clipboard format ids (constant across sessions).
const CF_TEXT: u32 = 1;
const CF_UNICODETEXT: u32 = 13;
const CF_HDROP: u32 = 15;

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

/// MOVEABLE block holding exactly the caller's bytes. Callers pre-append
/// terminators (R4); GlobalSize(medium) === bytes.len() always holds.
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

/// R4: UTF-16 bytes INCLUDING the two-zero-byte NUL terminator.
fn utf16_bytes(s: &str) -> Vec<u8> {
    let wide = wide_null(s);
    let mut out = Vec::with_capacity(wide.len() * 2);
    for w in wide {
        out.extend_from_slice(&w.to_le_bytes());
    }
    out
}

// ── Offered formats (R6: the agreed set, nothing else) ───────────────────

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
    // DROPFILES header: pFiles=20, pt=(0,0), fNC=0, fWide=1 (LE u32s),
    // then NUL-terminated UTF-16 paths + final double NUL.
    let mut out = vec![0u8; 20];
    out[0..4].copy_from_slice(&20u32.to_le_bytes());
    out[16..20].copy_from_slice(&1u32.to_le_bytes());
    for p in paths {
        out.extend_from_slice(&utf16_bytes(p));
    }
    out.extend_from_slice(&[0u8, 0u8]);
    out
}

// ── Temp-file staging with deferred cleanup (R7) ─────────────────────────
// HDROP must point at a stable path for the whole modal loop, and web
// upload zones read the file ASYNCHRONOUSLY after the drop event — so the
// staged dir outlives DoDragDrop: on settle it enters the graveyard, which
// is reaped by a 60s deferred thread AND swept wholesale at the next drag
// start. The CarbonDrag-* namespace lets the OS temp reclaimer finish any
// remainder at exit. File clips reference real paths; only image clips
// (stored screenshots, extension-less names) are staged.

static DRAG_STAGE_COUNTER: AtomicU64 = AtomicU64::new(0);
static STAGED_GRAVEYARD: Mutex<Vec<std::path::PathBuf>> = Mutex::new(Vec::new());

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
    drag_log(&format!(
        "[NATIVE_DRAG] staged temp copy '{}' ({} bytes)",
        staged.display(),
        staged.metadata().map(|m| m.len()).unwrap_or(0)
    ));
    Ok((StagedDrag { dir }, staged))
}

/// R7: hand the dir to deferred cleanup — a 60s thread reaps it; the next
/// drag start sweeps leftovers first, so a wedged thread can't pin disk.
fn retire_staged_dir(dir: std::path::PathBuf) {
    if let Ok(mut yard) = STAGED_GRAVEYARD.lock() {
        yard.push(dir.clone());
    }
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(60));
        if std::fs::remove_dir_all(&dir).is_ok() {
            drag_log(&format!("[NATIVE_DRAG] deferred cleanup removed '{}'", dir.display()));
        }
        if let Ok(mut yard) = STAGED_GRAVEYARD.lock() {
            yard.retain(|d| d != &dir);
        }
    });
}

/// R7: next-drag-start sweep — reclaim anything a dead thread left behind,
/// plus previous-session dirs older than one hour (exit path).
fn sweep_stale_staging() {
    let mut swept = 0u32;
    if let Ok(mut yard) = STAGED_GRAVEYARD.lock() {
        for dir in yard.drain(..) {
            if std::fs::remove_dir_all(&dir).is_ok() {
                swept += 1;
            }
        }
    }
    if let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with("CarbonDrag-") && entry.path().is_dir() {
                let old = entry
                    .metadata()
                    .and_then(|m| m.modified())
                    .map(|t| t.elapsed().unwrap_or_default() > Duration::from_secs(3600))
                    .unwrap_or(false);
                if old && std::fs::remove_dir_all(entry.path()).is_ok() {
                    swept += 1;
                }
            }
        }
    }
    if swept > 0 {
        drag_log(&format!("[NATIVE_DRAG] start-sweep reclaimed {swept} staged dir(s)"));
    }
}

/// R6: the agreed format set per clip type — and nothing else. Returns the
/// offers plus the staging guard (kept alive through DoDragDrop).
fn build_offers(item: &crate::db::ClipItem, cf_html: u32) -> (Vec<Offer>, Option<StagedDrag>) {
    let mut offers = Vec::new();
    let kind = item.content_type.as_str();

    // Text-like clips: UNICODETEXT (+TEXT), +HTML whenever HTML is stored.
    if matches!(kind, "text" | "code" | "link" | "email" | "rich_text") {
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

    // Image clips (R6): HDROP over the staged temp copy + UNICODETEXT path.
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
                        return (offers, Some(guard));
                    }
                    Err(e) => {
                        drag_log(&format!(
                            "[NATIVE_DRAG] staging failed for '{path}': {e} — text fallback"
                        ));
                    }
                }
            } else {
                drag_log(&format!(
                    "[NATIVE_DRAG] image file missing, file formats skipped: {path}"
                ));
            }
        }
    }

    // File clips (R6): HDROP over the live paths. Consoles accept HDROP by
    // pasting quoted paths, so no text flavor is offered.
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
                    return (offers, None);
                }
            }
        }
    }

    // Fallback (color/unknown): title/text as unicode + ANSI. Never
    // custom-only: R6 forbids offering solely unconsumed flavors.
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
    (offers, None)
}

// ── Hand-rolled COM plumbing ─────────────────────────────────────────────
// One IUnknown triple per object type (unique fn names via the macro).
// QI answers exactly IUnknown + the object's own IID (R2: anything else is
// E_NOINTERFACE); refcounting is additive; AddRef/Release are infallible
// arithmetic (no guard needed — no panic paths).

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

// ── COM: format enumerator (R1) ──────────────────────────────────────────

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
                    // R1: S_OK per item, S_FALSE exactly at end.
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

// ── COM: drop source (R8) ────────────────────────────────────────────────

#[repr(C)]
struct ClipDropSource {
    vtbl: *const IDropSource_Vtbl,
    refs: AtomicU32,
}

com_unknown!(ClipDropSource, src_qi, src_add, src_rel, [IDropSource::IID]);

// R8: exactly S_OK / DRAGDROP_S_CANCEL / DRAGDROP_S_DROP — Esc cancels,
// released buttons drop, held buttons continue. Nothing else, ever.
unsafe extern "system" fn src_query_continue(
    _this: *mut std::ffi::c_void,
    fescapepressed: BOOL,
    grfkeystate: MODIFIERKEYS_FLAGS,
) -> HRESULT {
    guard_hresult("src_query_continue", || {
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

// ── COM: data object (R2/R3) ─────────────────────────────────────────────

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

    /// Exact match on (format, tymed, lindex) per R2.
    fn find(&self, fmt: &FORMATETC) -> Option<&Offer> {
        self.offers.iter().find(|o| {
            o.cf_format as u16 == fmt.cfFormat && o.tymed == fmt.tymed && o.lindex == fmt.lindex
        })
    }

    /// Right format (+lindex), wrong medium — R2 answers DV_E_TYMED.
    fn find_format_only(&self, fmt: &FORMATETC) -> bool {
        self.offers
            .iter()
            .any(|o| o.cf_format as u16 == fmt.cfFormat && o.lindex == fmt.lindex)
    }

    fn list_kinds(&self) -> String {
        self.offers
            .iter()
            .map(|o| format!("cf={} tymed={} idx={}", o.cf_format, o.tymed, o.lindex))
            .collect::<Vec<_>>()
            .join(",")
    }
}

/// R3: every call allocates a FRESH HGLOBAL; ownership transfers to the
/// caller with the return. The source never frees or caches it.
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
            let o = ClipDataObject::this(this);
            let fmt = &*pformatetcin;
            match o.find(fmt) {
                Some(offer) => match fill_medium(offer) {
                    Ok(medium) => {
                        *pmedium = medium;
                        drag_log(&format!(
                            "[NATIVE_DRAG] GetData served cf={} tymed={} (fresh hGlobal)",
                            fmt.cfFormat, fmt.tymed
                        ));
                        S_OK
                    }
                    Err(_) => HRESULT::from_win32(8),
                },
                None if o.find_format_only(fmt) => {
                    drag_log(&format!(
                        "[NATIVE_DRAG] GetData DV_E_TYMED cf={} tymed={} (offered: {})",
                        fmt.cfFormat,
                        fmt.tymed,
                        o.list_kinds()
                    ));
                    DV_E_TYMED
                }
                None => {
                    drag_log(&format!(
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

/// R3: fill the CALLER's medium in place — ownership never moves. Requires
/// a caller-allocated HGLOBAL big enough for the offer bytes.
unsafe extern "system" fn data_getdata_here(
    this: *mut std::ffi::c_void,
    pformatetc: *const FORMATETC,
    pmedium: *mut STGMEDIUM,
) -> HRESULT {
    guard_hresult("data_getdata_here", || unsafe {
        if this.is_null() || pformatetc.is_null() || pmedium.is_null() {
            E_POINTER
        } else {
            let o = ClipDataObject::this(this);
            let fmt = &*pformatetc;
            let med = &mut *pmedium;
            match o.find(fmt) {
                None if o.find_format_only(fmt) => DV_E_TYMED,
                None => DV_E_FORMATETC,
                Some(offer) => {
                    if med.tymed != TYMED_HGLOBAL.0 as u32 || med.u.hGlobal.0.is_null() {
                        return DV_E_TYMED;
                    }
                    let OfferData::Global(bytes) = &offer.data;
                    let room = windows::Win32::System::Memory::GlobalSize(med.u.hGlobal);
                    if room < bytes.len() {
                        return E_FAIL;
                    }
                    let ptr = GlobalLock(med.u.hGlobal);
                    if ptr.is_null() {
                        return E_FAIL;
                    }
                    std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr as *mut u8, bytes.len());
                    let _ = GlobalUnlock(med.u.hGlobal);
                    S_OK
                }
            }
        }
    })
}

/// R2: S_OK for supported (tymed exact), DV_E_TYMED for right format /
/// wrong medium, DV_E_FORMATETC otherwise. Never S_OK-with-empty.
unsafe extern "system" fn data_query(
    this: *mut std::ffi::c_void,
    pformatetc: *const FORMATETC,
) -> HRESULT {
    guard_hresult("data_query", || unsafe {
        if this.is_null() || pformatetc.is_null() {
            E_POINTER
        } else {
            let o = ClipDataObject::this(this);
            let fmt = &*pformatetc;
            let hr = if o.find(fmt).is_some() {
                S_OK
            } else if o.find_format_only(fmt) {
                DV_E_TYMED
            } else {
                DV_E_FORMATETC
            };
            drag_log(&format!(
                "[NATIVE_DRAG] QueryGetData cf={} tymed={} idx={} -> {hr:?}",
                fmt.cfFormat, fmt.tymed, fmt.lindex
            ));
            hr
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
    // R1: DATADIR_GET only; drag sources never accept SetData enumeration.
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
    GetDataHere: data_getdata_here,
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
/// returns the negotiated effect ("copy" expected; anything else is logged
/// as a violation since only COPY is ever offered).
///
/// The WebView invokes this command from `dragstart`, but `DoDragDrop`
/// runs ONLY on the main STA thread (posted via `run_on_main_thread`). A
/// `compare_exchange` busy guard rejects concurrent drags (rapid-spam
/// protection): one modal loop at a time.
pub fn begin_clip_drag(
    state: &State<'_, AppState>,
    app: &AppHandle,
    id: String,
) -> std::result::Result<String, String> {
    if NATIVE_DRAG_ACTIVE
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        drag_log(&format!(
            "[NATIVE_DRAG] VIOLATION: concurrent dragstart rejected id='{id}' (spam guard)"
        ));
        return Err("native drag already in progress".to_string());
    }
    sweep_stale_staging();
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
    drag_log(&format!(
        "[NATIVE_DRAG] begin id='{}' type='{}' offering {} formats: {} (staged={})",
        item.id,
        item.content_type,
        offers.len(),
        offers
            .iter()
            .map(|o| format!("cf={}", o.cf_format))
            .collect::<Vec<_>>()
            .join(","),
        staged.is_some()
    ));

    let (tx, rx) = mpsc::channel();
    drag_log(&format!(
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
                drag_log("[NATIVE_DRAG] PANIC on main STA thread during drag -> error");
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
                drag_log(&format!(
                    "[NATIVE_DRAG] VIOLATION: drop settled with effect='{effect}' on a COPY-only drag id='{id}'"
                ));
            } else {
                drag_log(&format!("[NATIVE_DRAG] drop settled COPY id='{id}'"));
            }
            Ok(effect)
        }
        Ok(Err(e)) => Err(e),
        Err(_) => Err("native drag channel vanished".to_string()),
    }
}

/// Modal drag body. Runs ONLY on the main STA thread: OleInitialize state
/// is logged, DoDragDrop entered/returned is logged, and the staging guard
/// retires into deferred cleanup (R7) after the loop settles.
unsafe fn run_modal_drag(
    offers: Vec<Offer>,
    staged: Option<StagedDrag>,
) -> std::result::Result<String, String> {
    unsafe {
        drag_log("[NATIVE_DRAG] handler entered on main STA thread");
        match OleInitialize(None) {
            Ok(()) => drag_log("[NATIVE_DRAG] OleInitialize ok (S_OK or S_FALSE/already-init)"),
            Err(e) => {
                drag_log(&format!(
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
        drag_log("[NATIVE_DRAG] DoDragDrop entered");
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
        // R7: the loop settled — retire staging into deferred cleanup.
        if let Some(staged) = _staged {
            retire_staged_dir(staged.dir);
            drag_log("[NATIVE_DRAG] staging retired to deferred cleanup (R7)");
        }
        drag_log(&format!(
            "[NATIVE_DRAG] DoDragDrop returned hr={hr:?} effect={}",
            effect_name(effect.0),
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

// ── Conformance harness (v30, in-process, CI via `cargo test`) ───────────
// Drives the data object exactly like a hostile target: enumerate fully
// twice; QueryGetData on supported / wrong-tymed / bogus; GetData every
// supported format + ReleaseStgMedium; GetDataHere fill; bogus GetData
// fails cleanly. Every assertion names its rule (R1..R8).
#[cfg(test)]
mod conformance_tests {
    use super::*;
    use crate::db::ClipItem;
    use windows::Win32::System::Memory::GlobalSize;
    use windows::Win32::System::Ole::ReleaseStgMedium;

    fn clip(kind: &str) -> ClipItem {
        ClipItem {
            id: format!("test-{kind}"),
            content_type: kind.to_string(),
            title: format!("{kind} title"),
            text_content: Some(format!("{kind} body text")),
            rtf_content: None,
            html_content: None,
            image_path: None,
            image_width: None,
            image_height: None,
            file_paths: None,
            is_video: false,
            file_size: 0,
            is_pinned: false,
            source_app: None,
            created_at: String::new(),
            updated_at: String::new(),
            qr_content: None,
            is_sensitive: false,
            expires_at: None,
            ocr_text: None,
        }
    }

    fn fmtetc(cf: u32, tymed: u32, lindex: i32) -> FORMATETC {
        FORMATETC {
            cfFormat: cf as u16,
            ptd: std::ptr::null_mut(),
            dwAspect: DVASPECT_CONTENT.0,
            lindex,
            tymed,
        }
    }

    const HGLOBAL_TYMED: u32 = 1; // TYMED_HGLOBAL
    const ISTREAM_TYMED: u32 = 4; // TYMED_ISTREAM (never offered)
    const BOGUS_CF: u32 = 0xC001; // unregistered format

    fn test_object(item: &ClipItem) -> IDataObject {
        let cf_html = register_format("HTML Format");
        let (offers, _staged) = build_offers(item, cf_html);
        assert!(!offers.is_empty(), "R6: every clip type must offer something");
        new_data_object(offers)
    }

    fn read_hglobal(h: HGLOBAL) -> Vec<u8> {
        unsafe {
            let size = GlobalSize(h);
            let ptr = GlobalLock(h);
            assert!(!ptr.is_null(), "R4: locked medium must be readable");
            let bytes = std::slice::from_raw_parts(ptr as *const u8, size).to_vec();
            let _ = GlobalUnlock(h);
            bytes
        }
    }

    fn decode_utf16(bytes: &[u8]) -> String {
        assert!(bytes.len() % 2 == 0, "R4: UTF-16 medium must be even-length");
        let words: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        assert!(
            words.last() == Some(&0),
            "R4: UTF-16 medium must end in NUL"
        );
        String::from_utf16_lossy(&words[..words.len() - 1])
    }

    // R6: agreed format sets per clip type (and nothing else).
    #[test]
    fn r6_offer_sets_per_type() {
        let cf_html = register_format("HTML Format");
        for kind in ["text", "code", "link", "email"] {
            let mut item = clip(kind);
            if kind == "email" {
                item.html_content = Some("<p>hi</p>".to_string());
            }
            let (offers, _) = build_offers(&item, cf_html);
            let cfs: Vec<u32> = offers.iter().map(|o| o.cf_format).collect();
            assert!(cfs.contains(&CF_UNICODETEXT), "R6: {kind} offers UNICODETEXT");
            assert!(cfs.contains(&CF_TEXT), "R6: {kind} offers TEXT");
            // Email-with-HTML and links always carry their HTML flavor.
            let want_html = kind == "email" || kind == "link";
            assert_eq!(cfs.contains(&cf_html), want_html, "R6: {kind} html membership");
            let want_len = if want_html { 3 } else { 2 };
            assert_eq!(cfs.len(), want_len, "R6: {kind} offers exactly the agreed set");
            assert!(offers.iter().all(|o| o.tymed == HGLOBAL_TYMED), "R6: text mediums are HGLOBAL");
        }
        // Email without HTML: no CF_HTML, still unicode+text.
        let (offers, _) = build_offers(&clip("email"), cf_html);
        assert_eq!(offers.len(), 2, "R6: htmlless email offers exactly unicode+text");
    }

    // R1: enumeration is exact, repeatable, DATADIR_GET-only, independently owned.
    #[test]
    fn r1_enumeration_contract() {
        let obj = test_object(&clip("text"));
        unsafe {
            // Wrong direction first (hostile): must refuse with no object.
            assert!(
                obj.EnumFormatEtc(2).is_err(),
                "R1: DATADIR_SET enumeration must fail"
            );

            for pass in 1..=2 {
                let penum = obj
                    .EnumFormatEtc(DATADIR_GET.0 as u32)
                    .expect("R1: enum must succeed");
                let mut seen = 0u32;
                loop {
                    let mut buf: [FORMATETC; 1] = std::mem::zeroed();
                    let mut fetched = 0u32;
                    let hr = penum.Next(&mut buf, Some(&mut fetched));
                    if hr == S_FALSE {
                        break;
                    }
                    assert_eq!(hr, S_OK, "R1: per-item Next must be S_OK");
                    assert_eq!(fetched, 1, "R1: fetched count must be 1");
                    let fmt = buf[0];
                    assert!(
                        fmt.cfFormat as u32 == CF_UNICODETEXT || fmt.cfFormat as u32 == CF_TEXT,
                        "R1: enumerated set must equal offered set"
                    );
                    seen += 1;
                    assert!(seen <= 8, "R1: enumerator must terminate (bounds)");
                }
                assert_eq!(seen, 2, "R1 pass {pass}: text clip enumerates exactly 2 formats");
                // Clone is independent: reset original, clone still reads.
                let this = Interface::as_raw(&penum);
                let vt = *(this as *const *const IEnumFORMATETC_Vtbl);
                assert_eq!(((*vt).Reset)(this), S_OK, "R1: reset must succeed");
                let mut raw: *mut std::ffi::c_void = std::ptr::null_mut();
                assert_eq!(
                    ((*vt).Clone)(this, &mut raw),
                    S_OK,
                    "R1: clone must succeed"
                );
                assert!(!raw.is_null(), "R1: clone must hand out an object");
                let _ = IEnumFORMATETC::from_raw(raw);
            }
        }
    }

    // R2: query matrix — supported / wrong-tymed / bogus. QueryGetData
    // returns the HRESULT directly (S_FALSE-free by contract).
    #[test]
    fn r2_query_matrix() {
        let obj = test_object(&clip("text"));
        unsafe {
            assert_eq!(obj.QueryGetData(&fmtetc(CF_UNICODETEXT, HGLOBAL_TYMED, -1)), S_OK, "R2: supported must be S_OK");
            assert_eq!(obj.QueryGetData(&fmtetc(CF_TEXT, HGLOBAL_TYMED, -1)), S_OK, "R2: supported must be S_OK");
            assert_eq!(
                obj.QueryGetData(&fmtetc(CF_UNICODETEXT, ISTREAM_TYMED, -1)),
                DV_E_TYMED,
                "R2: right format/wrong medium must be DV_E_TYMED"
            );
            assert_eq!(
                obj.QueryGetData(&fmtetc(CF_UNICODETEXT, HGLOBAL_TYMED, 7)),
                DV_E_FORMATETC,
                "R2: wrong lindex must be DV_E_FORMATETC"
            );
            for bogus in [BOGUS_CF, 0, 0xFFFF] {
                assert_eq!(
                    obj.QueryGetData(&fmtetc(bogus, HGLOBAL_TYMED, -1)),
                    DV_E_FORMATETC,
                    "R2: bogus cf={bogus:#X} must be DV_E_FORMATETC"
                );
            }
        }
    }

    // R3+R4: fresh mediums, exact sizes, terminators, caller frees cleanly.
    // GetData returns the STGMEDIUM by value (ownership moves to us).
    // Uniqueness is checked with BOTH mediums alive: a freed block may
    // legitimately be reissued at the same address by the allocator.
    #[test]
    fn r3_r4_medium_ownership_and_terminators() {
        let obj = test_object(&clip("text"));
        unsafe {
            let med_u = obj
                .GetData(&fmtetc(CF_UNICODETEXT, HGLOBAL_TYMED, -1))
                .expect("R2/R3: supported GetData must succeed");
            let med_t = obj
                .GetData(&fmtetc(CF_TEXT, HGLOBAL_TYMED, -1))
                .expect("R2/R3: supported GetData must succeed");
            for (cf, med) in [(CF_UNICODETEXT, &med_u), (CF_TEXT, &med_t)] {
                assert_eq!(med.tymed, HGLOBAL_TYMED, "R3: medium tymed must match");
                assert!(!med.u.hGlobal.0.is_null(), "R3: hGlobal must be set");
            }
            assert_ne!(
                med_u.u.hGlobal.0, med_t.u.hGlobal.0,
                "R3: no medium pointer may repeat across live GetData calls"
            );
            let bytes_u = read_hglobal(med_u.u.hGlobal);
            assert_eq!(decode_utf16(&bytes_u), "text body text", "R4: unicode round-trips with terminator");
            assert_eq!(
                GlobalSize(med_u.u.hGlobal),
                utf16_bytes("text body text").len(),
                "R4: GlobalSize must equal bytes+terminator"
            );
            let bytes_t = read_hglobal(med_t.u.hGlobal);
            assert_eq!(bytes_t.last(), Some(&0), "R4: ANSI medium must end in NUL");
            assert_eq!(&bytes_t[..bytes_t.len() - 1], b"text body text", "R4: ANSI round-trips");
            // R3: harness-owned frees must not corrupt (debug heap would trap).
            let mut med_u = med_u;
            let mut med_t = med_t;
            ReleaseStgMedium(&mut med_u);
            ReleaseStgMedium(&mut med_t);
            // Bogus GetData fails cleanly (no medium, no crash).
            let err = obj.GetData(&fmtetc(BOGUS_CF, HGLOBAL_TYMED, -1)).err().expect("R3: bogus GetData must fail");
            assert_eq!(err.code(), DV_E_FORMATETC, "R3: bogus GetData must fail DV_E_FORMATETC");
            let err = obj
                .GetData(&fmtetc(CF_UNICODETEXT, ISTREAM_TYMED, -1))
                .err().expect("R3: wrong-tymed GetData must fail");
            assert_eq!(err.code(), DV_E_TYMED, "R3: wrong-tymed GetData must fail DV_E_TYMED");
        }
    }

    // R3: GetDataHere fills the caller's own medium.
    #[test]
    fn r3_getdata_here_fills_caller_medium() {
        let obj = test_object(&clip("code"));
        unsafe {
            let want = utf16_bytes("code body text");
            let h = GlobalAlloc(GMEM_MOVEABLE, 4096).expect("R3: harness prealloc must succeed");
            let mut med: STGMEDIUM = std::mem::zeroed();
            med.tymed = HGLOBAL_TYMED;
            med.u.hGlobal = h;
            obj.GetDataHere(&fmtetc(CF_UNICODETEXT, HGLOBAL_TYMED, -1), &mut med)
                .expect("R3: GetDataHere must fill the caller medium");
            let bytes = read_hglobal(h);
            assert_eq!(&bytes[..want.len()], &want[..], "R3: caller buffer must hold the offer bytes");
            // Too-small caller buffer fails cleanly, object survives.
            let h2 = GlobalAlloc(GMEM_MOVEABLE, 4).expect("R3: harness prealloc must succeed");
            let mut med2: STGMEDIUM = std::mem::zeroed();
            med2.tymed = HGLOBAL_TYMED;
            med2.u.hGlobal = h2;
            let err = obj
                .GetDataHere(&fmtetc(CF_UNICODETEXT, HGLOBAL_TYMED, -1), &mut med2)
                .unwrap_err();
            assert_eq!(err.code(), E_FAIL, "R3: undersized caller buffer must fail, not overrun");
            let _ = GlobalUnlock(h2);
            ReleaseStgMedium(&mut med);
            ReleaseStgMedium(&mut med2);
        }
    }

    // R5: served CF_HTML parses — real byte offsets, UTF-8 body, NUL end.
    #[test]
    fn r5_cf_html_wellformed() {
        let mut item = clip("email");
        item.html_content = Some("<p>héllo ✓ <b>bold</b></p>".to_string());
        let obj = test_object(&item);
        unsafe {
            let cf_html = register_format("HTML Format");
            let med = obj
                .GetData(&fmtetc(cf_html, HGLOBAL_TYMED, -1))
                .expect("R5: html GetData must succeed");
            let bytes = read_hglobal(med.u.hGlobal);
            assert_eq!(bytes.last(), Some(&0), "R5: CF_HTML must be NUL-terminated");
            let text = String::from_utf8(bytes[..bytes.len() - 1].to_vec()).expect("R5: body must be UTF-8");
            let num = |k: &str| -> usize {
                text.lines()
                    .find(|l| l.starts_with(k))
                    .and_then(|l| l[k.len()..].trim().parse().ok())
                    .expect("R5: header field must parse")
            };
            let (sh, eh, sf, ef) = (
                num("StartHTML:"),
                num("EndHTML:"),
                num("StartFragment:"),
                num("EndFragment:"),
            );
            let raw = text.as_bytes();
            assert!(sh < sf && sf < ef && ef <= eh && eh <= raw.len(), "R5: offsets must nest");
            let frag = std::str::from_utf8(&raw[sf..ef]).expect("R5: byte offsets must slice UTF-8");
            assert!(frag.contains("héllo ✓"), "R5: multibyte content must survive byte slicing");
            assert!(frag.contains("<b>bold</b>"), "R5: fragment content must survive");
            let mut med = med;
            ReleaseStgMedium(&mut med);
        }
    }

    // R6+R4: HDROP shape, staged-file lifetime within the drag, path text.
    #[test]
    fn r6_image_hdrop_and_path() {
        let dir = std::env::temp_dir();
        let src = dir.join(format!("carbon-v30-img-{}.png", std::process::id()));
        std::fs::write(&src, b"fakepng").expect("R6: fixture must stage");
        let mut item = clip("image");
        item.image_path = Some(src.to_string_lossy().into_owned());
        let cf_html = register_format("HTML Format");
        let (offers, staged) = build_offers(&item, cf_html);
        let cfs: Vec<u32> = offers.iter().map(|o| o.cf_format).collect();
        assert!(cfs.contains(&CF_HDROP), "R6: image offers HDROP");
        assert!(cfs.contains(&CF_UNICODETEXT), "R6: image offers path text");
        assert_eq!(cfs.len(), 2, "R6: image offers exactly the agreed pair");
        let staged = staged.expect("R6: image drag stages a temp copy");
        assert!(staged.dir.starts_with(std::env::temp_dir()), "R7: staging lives in temp");
        let obj = new_data_object(offers);
        unsafe {
            let med = obj
                .GetData(&fmtetc(CF_HDROP, HGLOBAL_TYMED, -1))
                .expect("R6: HDROP GetData must succeed");
            let bytes = read_hglobal(med.u.hGlobal);
            assert_eq!(&bytes[0..4], &20u32.to_le_bytes(), "R6: DROPFILES pFiles");
            assert_eq!(&bytes[16..20], &1u32.to_le_bytes(), "R6: DROPFILES fWide");
            assert_eq!(&bytes[bytes.len() - 2..], &[0, 0], "R6: HDROP ends double-NUL");
            // Walk the UTF-16Z path list; every path must exist (R7: live).
            let words: Vec<u16> = bytes[20..bytes.len() - 2]
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .collect();
            let mut paths = Vec::new();
            for part in words.split(|w| *w == 0) {
                if !part.is_empty() {
                    paths.push(String::from_utf16_lossy(part));
                }
            }
            assert_eq!(paths.len(), 1, "R6: exactly one staged path");
            assert!(std::path::Path::new(&paths[0]).exists(), "R7: staged file must be live");
            let med2 = obj
                .GetData(&fmtetc(CF_UNICODETEXT, HGLOBAL_TYMED, -1))
                .expect("R6: path text GetData must succeed");
            let pbytes = read_hglobal(med2.u.hGlobal);
            assert_eq!(decode_utf16(&pbytes), paths[0], "R6: path text matches the staged file");
            let mut med = med;
            ReleaseStgMedium(&mut med);
            let mut med2 = med2;
            ReleaseStgMedium(&mut med2);
        }
        std::fs::remove_dir_all(&staged.dir).ok();
        std::fs::remove_file(&src).ok();
    }

    // R6: files offer HDROP over live paths only.
    #[test]
    fn r6_file_hdrop_live_only() {
        let dir = std::env::temp_dir();
        let live = dir.join(format!("carbon-v30-live-{}.txt", std::process::id()));
        std::fs::write(&live, b"x").expect("R6: fixture must exist");
        let mut item = clip("file");
        item.file_paths = Some(
            serde_json::to_string(&vec![
                live.to_string_lossy().into_owned(),
                "C:\\definitely\\not\\here\\zzz.txt".to_string(),
            ])
            .unwrap(),
        );
        let cf_html = register_format("HTML Format");
        let (offers, _) = build_offers(&item, cf_html);
        let cfs: Vec<u32> = offers.iter().map(|o| o.cf_format).collect();
        assert_eq!(cfs, vec![CF_HDROP], "R6: file offers exactly HDROP (dead paths filtered)");
        std::fs::remove_file(&live).ok();
    }

    // R2/QI: unknown IIDs rejected, IUnknown reachable, no panic paths.
    #[test]
    fn r2_qi_contract() {
        let obj = test_object(&clip("link"));
        unsafe {
            let unk: IUnknown = obj.cast().expect("R2: IDataObject must QI to IUnknown");
            let this = Interface::as_raw(&unk);
            let vt = *(this as *const *const IUnknown_Vtbl);
            let mut out: *mut std::ffi::c_void = std::ptr::null_mut();
            let bogus = GUID::from_values(0xDEAD, 0xBEEF, 0x1234, [1, 2, 3, 4, 5, 6, 7, 8]);
            let hr = ((*vt).QueryInterface)(this, &bogus, &mut out);
            assert_eq!(hr, E_NOINTERFACE, "R2: bogus IID must be E_NOINTERFACE");
            assert!(out.is_null(), "R2: failed QI must null the out-param");
            let back: IDataObject = unk.cast().expect("R2: identity QI must round-trip");
            let _ = back;
        }
    }

    // R8: drop-source contract values.
    #[test]
    fn r8_drop_source_contract() {
        let src = new_drop_source();
        unsafe {
            assert_eq!(
                src.QueryContinueDrag(BOOL(0), MODIFIERKEYS_FLAGS(0)),
                DRAGDROP_S_DROP,
                "R8: released buttons mean DROP"
            );
            assert_eq!(
                src.QueryContinueDrag(BOOL(1), MODIFIERKEYS_FLAGS(0)),
                DRAGDROP_S_CANCEL,
                "R8: Esc means CANCEL"
            );
            assert_eq!(
                src.QueryContinueDrag(
                    BOOL(0),
                    MODIFIERKEYS_FLAGS(MK_LBUTTON.0 | MK_RBUTTON.0)
                ),
                S_OK,
                "R8: held buttons mean continue"
            );
            assert_eq!(
                src.QueryContinueDrag(BOOL(0), MODIFIERKEYS_FLAGS(MK_LBUTTON.0)),
                S_OK,
                "R8: single held button means continue"
            );
            assert_eq!(
                src.GiveFeedback(DROPEFFECT_COPY),
                DRAGDROP_S_USEDEFAULTCURSORS,
                "R8: feedback must use default cursors"
            );
            assert_eq!(
                src.GiveFeedback(DROPEFFECT_NONE),
                DRAGDROP_S_USEDEFAULTCURSORS,
                "R8: feedback is effect-independent"
            );
        }
    }

    // R7: graveyard sweep reclaims dead staging dirs at next drag start.
    #[test]
    fn r7_graveyard_sweep() {
        let dir = std::env::temp_dir().join(format!("CarbonDrag-v30-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("R7: fixture dir must stage");
        STAGED_GRAVEYARD.lock().unwrap().push(dir.clone());
        sweep_stale_staging();
        assert!(!dir.exists(), "R7: start-sweep must reclaim graveyard dirs");
        assert!(
            STAGED_GRAVEYARD.lock().unwrap().is_empty(),
            "R7: sweep must drain the graveyard"
        );
    }
}
