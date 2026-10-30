import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const native=fs.readFileSync(new URL('../src-tauri/src/vibrancy.rs',import.meta.url),'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,'');
test('acrylic activation reaches Tao and Windows without repainting the classic frame',()=>{
 assert.match(native,/WM_NCACTIVATE\s*=>\s*DefSubclassProc\(hwnd,\s*message,\s*wparam,\s*windows::Win32::Foundation::LPARAM\(-1\)\)/);
 assert.doesNotMatch(native,/WM_NCACTIVATE\s*=>\s*LRESULT/);
 assert.match(native,/WM_NCPAINT\s*=>\s*LRESULT\(0\)/);
 assert.match(native,/let preference = 2i32/);
});

test('material preparation updates both the native and WebView background surfaces',()=>{
 const start=native.indexOf('pub fn set_window_default_background(');
 const end=native.indexOf('pub fn ensure_transparent_surface(',start);
 const preparation=native.slice(start,end);
 assert.match(preparation,/window\.set_background_color\(Some\(tauri::window::Color/);
 assert.match(preparation,/color\.R, color\.G, color\.B, color\.A/);
 assert.match(preparation,/controller2\.SetDefaultBackgroundColor\(color\)/);
 assert.match(preparation,/wait_for_webview_work/);
});

test('DWM caption suppression keeps client acrylic and native rounding independent',()=>{
 assert.match(native,/let policy = DWMNCRP_DISABLED\.0/);
 assert.match(native,/DwmSetWindowAttribute\(hwnd, DWMWA_NCRENDERING_POLICY/);
 assert.match(native,/DwmExtendFrameIntoClientArea/);
 assert.match(native,/let preference = 2i32/);
});

test('frameless guard removes caption style at creation and when Tao regenerates styles',()=>{
 assert.match(native,/style & !WS_CAPTION\.0/);
 assert.match(native,/WM_STYLECHANGING if wparam\.0 as i32 == GWL_STYLE\.0/);
 assert.match(native,/styles\.styleNew = captionless_style\(styles\.styleNew\)/);
 assert.match(native,/SetWindowLongW\(hwnd, GWL_STYLE, frameless as i32\)/);
});
