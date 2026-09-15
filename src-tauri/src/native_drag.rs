//! Native OLE drag source for clip rows (ADDENDUM v28-B).
//!
//! The DOM DataTransfer path (clipDrag.ts) only offers text flavors, which is
//! why text drops work everywhere but images/files can never land in chat
//! upload zones, Explorer, or image editors (those require CF_HDROP, file
//! descriptors, or DIB — formats Chromium will not synthesize). This module
//! runs a real `DoDragDrop` with a per-clip `IDataObject`:
//!
//! - text/code/link: CF_UNICODETEXT (+ CF_TEXT), CF_HTML when stored.
//! - image: CF_HDROP over the stored file, FileGroupDescriptorW +
//!   FileContents (virtual-file targets), CF_DIB (editors), plus
//!   CF_UNICODETEXT holding the path (consoles, text-only targets).
//! - file clip: CF_HDROP with the real paths + CF_UNICODETEXT paths.
//!
//! Only DROPEFFECT_COPY is ever allowed, so supported targets always report
//! COPY and the circle-slash cursor is unreachable for them. The drag runs
//! on a dedicated STA thread (OleInitialize/DoDragDrop/OleUninitialize) and
//! the Tauri command blocks until the drop settles, returning the effect as
//! a string for frontend logging.
//!
//! COM plumbing is hand-rolled vtables (not the `implement!` macro): this
//! crate mixes windows 0.58 interfaces with a direct windows-core 0.61
//! dependency, and the macro's generated `::windows_core` paths resolve to
//! the wrong core version. Explicit vtables keep every type on 0.58.

use std::sync::{
    atomic::{AtomicU32, Ordering},
    mpsc, Mutex,
};

use tauri::State;
use windows::{
    core::{GUID, HRESULT, IUnknown, IUnknown_Vtbl, Interface, PCWSTR},
    Win32::{
        Foundation::{
            BOOL, E_NOINTERFACE, E_NOTIMPL, E_POINTER, HGLOBAL, S_FALSE, S_OK, DV_E_FORMATETC,
            DRAGDROP_S_CANCEL, DRAGDROP_S_DROP, DRAGDROP_S_USEDEFAULTCURSORS,
        },
        Storage::FileSystem::FILE_ATTRIBUTE_NORMAL,
        System::{
            Com::{
                IDataObject, IDataObject_Vtbl, IEnumFORMATETC, IEnumFORMATETC_Vtbl, IStream,
                IStream_Vtbl, ISequentialStream_Vtbl, STATSTG, FORMATETC, STGMEDIUM,
                STREAM_SEEK, STREAM_SEEK_SET, STREAM_SEEK_CUR, STREAM_SEEK_END,
                DATADIR_GET, DVASPECT_CONTENT, TYMED_HGLOBAL, TYMED_ISTREAM,
            },
            DataExchange::RegisterClipboardFormatW,
            Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE},
            Ole::{
                DoDragDrop, OleInitialize, OleUninitialize, IDropSource, IDropSource_Vtbl,
                DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_NONE,
            },
            SystemServices::{MK_LBUTTON, MK_RBUTTON, MODIFIERKEYS_FLAGS},
        },
        UI::Shell::{FD_ATTRIBUTES, FD_FILESIZE, FILEDESCRIPTORW, FILEGROUPDESCRIPTORW},
    },
};

use crate::{paste::log_diag, AppState};

// Win32 clipboard format ids (constant across sessions).
const CF_TEXT: u32 = 1;
const CF_DIB: u32 = 8;
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

/// Current time as a Windows FILETIME pair (for file descriptors).
fn now_filetime() -> (u32, u32) {
    let dur = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let ticks =
        dur.as_secs() * 10_000_000 + u64::from(dur.subsec_nanos() / 100) + 11644473600 * 10_000_000;
    (ticks as u32, (ticks >> 32) as u32)
}

// ── Offered formats ──────────────────────────────────────────────────────

enum OfferData {
    Global(Vec<u8>),
    Stream(Vec<u8>),
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

fn file_group_descriptor(paths: &[String], sizes: &[u64]) -> Vec<u8> {
    let (low, high) = now_filetime();
    let mut descs: Vec<FILEDESCRIPTORW> = Vec::new();
    for (i, p) in paths.iter().enumerate() {
        let name = std::path::Path::new(p)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("clipboard-file");
        let mut desc: FILEDESCRIPTORW = unsafe { std::mem::zeroed() };
        desc.dwFlags = (FD_ATTRIBUTES.0 | FD_FILESIZE.0) as u32;
        desc.dwFileAttributes = FILE_ATTRIBUTE_NORMAL.0;
        let size = sizes.get(i).copied().unwrap_or(0);
        desc.nFileSizeLow = size as u32;
        desc.nFileSizeHigh = (size >> 32) as u32;
        desc.ftCreationTime.dwLowDateTime = low;
        desc.ftCreationTime.dwHighDateTime = high;
        desc.ftLastAccessTime.dwLowDateTime = low;
        desc.ftLastAccessTime.dwHighDateTime = high;
        desc.ftLastWriteTime.dwLowDateTime = low;
        desc.ftLastWriteTime.dwHighDateTime = high;
        let mut cname = [0u16; 260];
        for (j, w) in name.encode_utf16().take(259).enumerate() {
            cname[j] = w;
        }
        desc.cFileName = cname;
        descs.push(desc);
    }
    let mut out = Vec::new();
    out.extend_from_slice(&(descs.len() as u32).to_le_bytes());
    for d in &descs {
        let bytes = unsafe {
            std::slice::from_raw_parts(
                d as *const FILEDESCRIPTORW as *const u8,
                std::mem::size_of::<FILEDESCRIPTORW>(),
            )
        };
        out.extend_from_slice(bytes);
    }
    // Keep the header layout honest even though we serialize manually.
    debug_assert_eq!(
        out.len(),
        4 + descs.len() * std::mem::size_of::<FILEDESCRIPTORW>()
    );
    let _ = std::mem::size_of::<FILEGROUPDESCRIPTORW>();
    out
}

/// BMP file bytes (with 14-byte file header) for an image on disk.
fn bmp_file_bytes(path: &str) -> Option<Vec<u8>> {
    let img = image::open(path).ok()?.to_rgba8();
    let (w, h) = (img.width(), img.height());
    let mut buf = Vec::new();
    image::codecs::bmp::BmpEncoder::new(&mut buf)
        .encode(img.as_raw(), w, h, image::ExtendedColorType::Rgba8)
        .ok()?;
    Some(buf)
}

fn build_offers(
    item: &crate::db::ClipItem,
    cf_html: u32,
    cf_descriptor: u32,
    cf_contents: u32,
    cf_carbon_ids: u32,
) -> Vec<Offer> {
    let mut offers = Vec::new();
    let kind = item.content_type.as_str();

    // Private internal flavor (Carbon-to-Carbon awareness).
    offers.push(Offer {
        cf_format: cf_carbon_ids,
        tymed: TYMED_HGLOBAL.0 as u32,
        lindex: -1,
        data: OfferData::Global(item.id.as_bytes().to_vec()),
    });

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
        return offers;
    }

    // Image clips: real-file HDROP + virtual descriptor + DIB + path text.
    if kind == "image" {
        if let Some(ref path) = item.image_path {
            if std::path::Path::new(path).exists() {
                offers.push(Offer {
                    cf_format: CF_HDROP,
                    tymed: TYMED_HGLOBAL.0 as u32,
                    lindex: -1,
                    data: OfferData::Global(hdrop_bytes(std::slice::from_ref(path))),
                });
                if let Ok(bytes) = std::fs::read(path) {
                    let size = bytes.len() as u64;
                    offers.push(Offer {
                        cf_format: cf_descriptor,
                        tymed: TYMED_HGLOBAL.0 as u32,
                        lindex: -1,
                        data: OfferData::Global(file_group_descriptor(
                            std::slice::from_ref(path),
                            &[size],
                        )),
                    });
                    offers.push(Offer {
                        cf_format: cf_contents,
                        tymed: TYMED_ISTREAM.0 as u32,
                        lindex: 0,
                        data: OfferData::Stream(bytes),
                    });
                }
                if let Some(bmp) = bmp_file_bytes(path) {
                    // CF_DIB is BITMAPINFO + bits: strip the 14-byte file header.
                    if bmp.len() > 14 {
                        offers.push(Offer {
                            cf_format: CF_DIB,
                            tymed: TYMED_HGLOBAL.0 as u32,
                            lindex: -1,
                            data: OfferData::Global(bmp[14..].to_vec()),
                        });
                    }
                }
                offers.push(Offer {
                    cf_format: CF_UNICODETEXT,
                    tymed: TYMED_HGLOBAL.0 as u32,
                    lindex: -1,
                    data: OfferData::Global(utf16_bytes(path)),
                });
                return offers;
            }
            log_diag(&format!("[NATIVE_DRAG] image file missing, file formats skipped: {path}"));
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
                    return offers;
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
    offers
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
            if ppv.is_null() || riid.is_null() {
                return E_POINTER;
            }
            let want = unsafe { &*riid };
            let ok = *want == IUnknown::IID $(|| *want == $iid)*;
            if !ok {
                unsafe {
                    *ppv = std::ptr::null_mut();
                }
                return E_NOINTERFACE;
            }
            unsafe {
                let o = &*(this as *const $t);
                o.refs.fetch_add(1, Ordering::SeqCst);
                *ppv = this;
            }
            S_OK
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

// ── COM: in-memory IStream (FileContents) ────────────────────────────────

#[repr(C)]
struct MemStream {
    vtbl: *const IStream_Vtbl,
    refs: AtomicU32,
    inner: Mutex<MemStreamInner>,
}

struct MemStreamInner {
    data: Vec<u8>,
    pos: u64,
}

impl MemStream {
    unsafe fn this<'a>(this: *mut std::ffi::c_void) -> &'a Self {
        &*(this as *const Self)
    }

    fn read_impl(&self, pv: *mut std::ffi::c_void, cb: u32, pcbread: *mut u32) -> HRESULT {
        let mut inner = match self.inner.lock() {
            Ok(g) => g,
            Err(_) => return HRESULT::from_win32(5),
        };
        let start = (inner.pos as usize).min(inner.data.len());
        let n = ((inner.data.len() - start) as u64).min(cb as u64) as usize;
        unsafe {
            if n > 0 {
                std::ptr::copy_nonoverlapping(inner.data.as_ptr().add(start), pv as *mut u8, n);
            }
            if !pcbread.is_null() {
                *pcbread = n as u32;
            }
        }
        inner.pos = (start + n) as u64;
        if (n as u32) < cb {
            S_FALSE
        } else {
            S_OK
        }
    }

    fn write_impl(&self, pv: *const std::ffi::c_void, cb: u32, pcbwritten: *mut u32) -> HRESULT {
        let mut inner = match self.inner.lock() {
            Ok(g) => g,
            Err(_) => return HRESULT::from_win32(5),
        };
        let start = inner.pos as usize;
        if inner.data.len() < start + cb as usize {
            inner.data.resize(start + cb as usize, 0);
        }
        unsafe {
            std::ptr::copy_nonoverlapping(
                pv as *const u8,
                inner.data.as_mut_ptr().add(start),
                cb as usize,
            );
            if !pcbwritten.is_null() {
                *pcbwritten = cb;
            }
        }
        inner.pos += cb as u64;
        S_OK
    }
}

com_unknown!(MemStream, stream_qi, stream_add, stream_rel, [IStream::IID]);

unsafe extern "system" fn stream_read(
    this: *mut std::ffi::c_void,
    pv: *mut std::ffi::c_void,
    cb: u32,
    pcbread: *mut u32,
) -> HRESULT {
    unsafe { MemStream::this(this).read_impl(pv, cb, pcbread) }
}

unsafe extern "system" fn stream_write(
    this: *mut std::ffi::c_void,
    pv: *const std::ffi::c_void,
    cb: u32,
    pcbwritten: *mut u32,
) -> HRESULT {
    unsafe { MemStream::this(this).write_impl(pv, cb, pcbwritten) }
}

unsafe extern "system" fn stream_seek(
    this: *mut std::ffi::c_void,
    dlibmove: i64,
    dworigin: STREAM_SEEK,
    plibnewposition: *mut u64,
) -> HRESULT {
    // STREAM_SEEK_SET/CUR/END are 0/1/2.
    unsafe {
        let o = MemStream::this(this);
        let mut inner = match o.inner.lock() {
            Ok(g) => g,
            Err(_) => return HRESULT::from_win32(5),
        };
        let len = inner.data.len() as i64;
        let base: i64 = if dworigin == STREAM_SEEK_SET {
            0
        } else if dworigin == STREAM_SEEK_CUR {
            inner.pos as i64
        } else if dworigin == STREAM_SEEK_END {
            len
        } else {
            return HRESULT::from_win32(87);
        };
        inner.pos = (base + dlibmove).max(0).min(len) as u64;
        if !plibnewposition.is_null() {
            *plibnewposition = inner.pos;
        }
    }
    S_OK
}

unsafe extern "system" fn stream_setsize(
    this: *mut std::ffi::c_void,
    libnewsize: u64,
) -> HRESULT {
    unsafe {
        let o = MemStream::this(this);
        match o.inner.lock() {
            Ok(mut inner) => {
                inner.data.resize(libnewsize as usize, 0);
                S_OK
            }
            Err(_) => HRESULT::from_win32(5),
        }
    }
}

unsafe extern "system" fn stream_stat(
    this: *mut std::ffi::c_void,
    pstatstg: *mut STATSTG,
    _grfstatflag: u32,
) -> HRESULT {
    unsafe {
        if pstatstg.is_null() {
            return HRESULT::from_win32(87);
        }
        let o = MemStream::this(this);
        let inner = match o.inner.lock() {
            Ok(g) => g,
            Err(_) => return HRESULT::from_win32(5),
        };
        let st = &mut *pstatstg;
        st.pwcsName = windows::core::PWSTR::null();
        st.r#type = 2; // STGTY_STREAM
        st.cbSize = inner.data.len() as u64;
        st.mtime = std::mem::zeroed();
        st.ctime = std::mem::zeroed();
        st.atime = std::mem::zeroed();
        st.grfMode = std::mem::zeroed();
        st.grfLocksSupported = 0;
        st.clsid = windows::core::GUID::zeroed();
        st.grfStateBits = 0;
        st.reserved = 0;
    }
    S_OK
}

unsafe extern "system" fn stream_clone(this: *mut std::ffi::c_void, out: *mut *mut std::ffi::c_void) -> HRESULT {
    unsafe {
        if out.is_null() {
            return HRESULT::from_win32(87);
        }
        let o = MemStream::this(this);
        let data = match o.inner.lock() {
            Ok(g) => g.data.clone(),
            Err(_) => return HRESULT::from_win32(5),
        };
        let boxed = Box::new(MemStream {
            vtbl: &STREAM_VTBL,
            refs: AtomicU32::new(1),
            inner: Mutex::new(MemStreamInner { data, pos: 0 }),
        });
        *out = Box::into_raw(boxed) as *mut std::ffi::c_void;
    }
    S_OK
}

static STREAM_VTBL: IStream_Vtbl = IStream_Vtbl {
    base__: ISequentialStream_Vtbl {
        base__: IUnknown_Vtbl {
            QueryInterface: stream_qi,
            AddRef: stream_add,
            Release: stream_rel,
        },
        Read: stream_read,
        Write: stream_write,
    },
    Seek: stream_seek,
    SetSize: stream_setsize,
    CopyTo: stream_notimpl_4,
    Commit: stream_notimpl_1,
    Revert: stream_notimpl_0,
    LockRegion: stream_notimpl_3,
    UnlockRegion: stream_notimpl_3u,
    Stat: stream_stat,
    Clone: stream_clone,
};

// Minimal E_NOTIMPL stubs with the exact arities the vtable needs.
unsafe extern "system" fn stream_notimpl_0(_this: *mut std::ffi::c_void) -> HRESULT {
    E_NOTIMPL
}
unsafe extern "system" fn stream_notimpl_1(
    _this: *mut std::ffi::c_void,
    _a: u32,
) -> HRESULT {
    E_NOTIMPL
}
unsafe extern "system" fn stream_notimpl_3(
    _this: *mut std::ffi::c_void,
    _a: u64,
    _b: u64,
    _c: u32,
) -> HRESULT {
    E_NOTIMPL
}
unsafe extern "system" fn stream_notimpl_3u(
    _this: *mut std::ffi::c_void,
    _a: u64,
    _b: u64,
    _c: u32,
) -> HRESULT {
    E_NOTIMPL
}
unsafe extern "system" fn stream_notimpl_4(
    _this: *mut std::ffi::c_void,
    _a: *mut std::ffi::c_void,
    _b: u64,
    _c: *mut u64,
    _d: *mut u64,
) -> HRESULT {
    E_NOTIMPL
}

fn new_mem_stream(data: Vec<u8>) -> IStream {
    let boxed = Box::new(MemStream {
        vtbl: &STREAM_VTBL,
        refs: AtomicU32::new(1),
        inner: Mutex::new(MemStreamInner { data, pos: 0 }),
    });
    unsafe { IStream::from_raw(Box::into_raw(boxed) as *mut std::ffi::c_void) }
}

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
    unsafe {
        let o = &*(this as *const FormatEnumerator);
        let mut pos = match o.pos.lock() {
            Ok(g) => g,
            Err(_) => return HRESULT::from_win32(5),
        };
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

unsafe extern "system" fn fmt_skip(this: *mut std::ffi::c_void, celt: u32) -> HRESULT {
    unsafe {
        let o = &*(this as *const FormatEnumerator);
        let mut pos = match o.pos.lock() {
            Ok(g) => g,
            Err(_) => return HRESULT::from_win32(5),
        };
        *pos = (*pos + celt as usize).min(o.formats.len());
        if *pos >= o.formats.len() {
            S_FALSE
        } else {
            S_OK
        }
    }
}

unsafe extern "system" fn fmt_reset(this: *mut std::ffi::c_void) -> HRESULT {
    unsafe {
        let o = &*(this as *const FormatEnumerator);
        match o.pos.lock() {
            Ok(mut pos) => {
                *pos = 0;
                S_OK
            }
            Err(_) => HRESULT::from_win32(5),
        }
    }
}

unsafe extern "system" fn fmt_clone(
    this: *mut std::ffi::c_void,
    out: *mut *mut std::ffi::c_void,
) -> HRESULT {
    unsafe {
        if out.is_null() {
            return HRESULT::from_win32(87);
        }
        let o = &*(this as *const FormatEnumerator);
        let pos = match o.pos.lock() {
            Ok(g) => *g,
            Err(_) => return HRESULT::from_win32(5),
        };
        let boxed = Box::new(FormatEnumerator {
            vtbl: &FORMATENUM_VTBL,
            refs: AtomicU32::new(1),
            formats: o.formats.clone(),
            pos: Mutex::new(pos),
        });
        *out = Box::into_raw(boxed) as *mut std::ffi::c_void;
    }
    S_OK
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
    if fescapepressed.as_bool() {
        DRAGDROP_S_CANCEL
    } else if grfkeystate.0 & (MK_LBUTTON.0 | MK_RBUTTON.0) == 0 {
        DRAGDROP_S_DROP
    } else {
        S_OK
    }
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
        match &offer.data {
            OfferData::Global(bytes) => {
                let h = hglobal_from_bytes(bytes)?;
                let mut medium: STGMEDIUM = std::mem::zeroed();
                medium.tymed = TYMED_HGLOBAL.0 as u32;
                medium.u.hGlobal = h;
                Ok(medium)
            }
            OfferData::Stream(bytes) => {
                let stream = new_mem_stream(bytes.clone());
                let mut medium: STGMEDIUM = std::mem::zeroed();
                medium.tymed = TYMED_ISTREAM.0 as u32;
                medium.u.pstm =
                    std::mem::ManuallyDrop::new(Some(stream));
                Ok(medium)
            }
        }
    }
}

unsafe extern "system" fn data_getdata(
    this: *mut std::ffi::c_void,
    pformatetcin: *const FORMATETC,
    pmedium: *mut STGMEDIUM,
) -> HRESULT {
    unsafe {
        if pformatetcin.is_null() || pmedium.is_null() {
            return HRESULT::from_win32(87);
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
    unsafe {
        if pformatetc.is_null() {
            return HRESULT::from_win32(87);
        }
        let o = ClipDataObject::this(this);
        match o.find(&*pformatetc) {
            Some(_) => S_OK,
            None => DV_E_FORMATETC,
        }
    }
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
    unsafe {
        if out.is_null() {
            return HRESULT::from_win32(87);
        }
        let o = ClipDataObject::this(this);
        let boxed = Box::new(FormatEnumerator {
            vtbl: &FORMATENUM_VTBL,
            refs: AtomicU32::new(1),
            formats: o.offers.iter().map(Offer::fmtetc).collect(),
            pos: Mutex::new(0),
        });
        *out = Box::into_raw(boxed) as *mut std::ffi::c_void;
    }
    S_OK
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
pub fn begin_clip_drag(state: &State<'_, AppState>, id: String) -> std::result::Result<String, String> {
    let item = state
        .db
        .get_entry_by_id(&id)?
        .ok_or_else(|| format!("clip not found: {id}"))?;

    let cf_html = register_format("HTML Format");
    let cf_descriptor = register_format("FileGroupDescriptorW");
    let cf_contents = register_format("FileContents");
    let cf_carbon_ids = register_format("CarbonClipIds");
    let offers = build_offers(&item, cf_html, cf_descriptor, cf_contents, cf_carbon_ids);
    log_diag(&format!(
        "[NATIVE_DRAG] begin id='{}' type='{}' offering {} formats",
        item.id,
        item.content_type,
        offers.len()
    ));

    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let outcome: windows::core::Result<String> = (|| unsafe {
            OleInitialize(None)?;
            struct OleGuard;
            impl Drop for OleGuard {
                fn drop(&mut self) {
                    unsafe {
                        OleUninitialize();
                    }
                }
            }
            let _guard = OleGuard;
            let dataobj = new_data_object(offers);
            let source = new_drop_source();
            // COPY-only: supported targets always report COPY, so the
            // circle-slash cursor is unreachable for them.
            let mut effect = DROPEFFECT_NONE;
            let hr = DoDragDrop(&dataobj, &source, DROPEFFECT_COPY, &mut effect);
            // Release OUR initial refs via IUnknown (only IUnknown::drop
            // calls Release; dropping the typed wrappers alone would leak).
            // OLE has already released its own references by now.
            let unk_data: IUnknown = dataobj.cast()?;
            let unk_src: IUnknown = source.cast()?;
            drop(dataobj);
            drop(source);
            drop(unk_data);
            drop(unk_src);
            if hr_failed(hr) {
                log_diag(&format!("[NATIVE_DRAG] DoDragDrop failed: {hr:?}"));
                return Err(hr.into());
            }
            Ok(effect_name(effect.0).to_string())
        })();
        let _ = tx.send(outcome);
    });

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
        Ok(Err(e)) => Err(format!("native drag failed: {e:?}")),
        Err(_) => Err("native drag thread vanished".to_string()),
    }
}

#[tauri::command]
pub fn begin_native_drag(state: State<'_, AppState>, id: String) -> std::result::Result<String, String> {
    begin_clip_drag(&state, id)
}
