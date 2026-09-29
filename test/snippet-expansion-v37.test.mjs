import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Argument-prompt flash/jump workstream (port of the V37 C/H/K pins).
// Covers: pre-declared surface only, paint-gated reveal, watchdog cancel,
// warm-advance discipline, hidden-side prewarm with a genuine first present,
// surface prep under a released guard, and the frontend continuity contract.
// (The V37-only engine pins — hook worker, select-back, clipboard ownership,
// pill gate, toast discipline — are intentionally not carried over: this
// branch predates that engine.)

const ROOT_DIR = path.resolve(import.meta.dirname, '..');

function readExpansion() {
  return fs.readFileSync(
    path.join(ROOT_DIR, 'src-tauri', 'src', 'expansion.rs'),
    'utf8'
  );
}

// Remove // and /* */ comments so assertions about code shape cannot be
// satisfied — or broken — by prose that merely mentions the construct.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('v37-C arg prompt: pre-declared surface only, paint-gated, watchdog-cancelled', () => {
  const src = readExpansion();
  const lib = fs.readFileSync(path.join(ROOT_DIR, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  // No dynamic window creation on any expansion hot path (C1): the prompt
  // reuses the pre-declared argprompt webview; the in-overlay modal covers
  // in-app use.
  assert.doesNotMatch(src, /WebviewWindowBuilder/, 'no windows may be built at runtime');
  assert.doesNotMatch(src, /ensure_argprompt|ensure_pill/, 'no ensure/create helpers may exist');
  // C2: cloak-gated reveal, mirroring the overlay's cold first open.
  //
  // The present makes the window WS_VISIBLE but leaves it CLOAKED: the boot
  // prewarm already started this window's renderer, so a cloaked-visible
  // window still paints (the same path the overlay relies on), and the very
  // first prompt waits for the frontend paint-ack before revealing — instead
  // of flashing a raw acrylic frame before the webview committed its first
  // frame (the white flash on the first argument prompt). Focus is taken at
  // the ack, not at show, so activation never bounces during the reveal.
  const showIdx = src.indexOf('fn show_arg_prompt');
  const showEndMatch = src.slice(showIdx + 1).match(/\n(?:pub )?fn /);
  const showEnd = showEndMatch ? showIdx + 1 + showEndMatch.index : -1;
  const showBody = src.slice(showIdx, showEnd === -1 ? showIdx + 6000 : showEnd);
  assert.doesNotMatch(
    showBody,
    /set_window_cloaked\(&win, true\)/,
    'argprompt must never be cloaked before show (its renderer would never start)'
  );
  const uncloakAt = showBody.indexOf('set_window_cloaked(&win, false)');
  const showAt = showBody.indexOf('win.show()');
  assert.ok(showAt !== -1, 'present must show the window (WS_VISIBLE so its renderer can paint)');
  assert.ok(
    showBody.includes('set_window_alpha(&win, 255)'),
    'the ack-before-present reveal must lift the cloak-parked alpha mask'
  );
  // The only reveal allowed inside present is the ack-before-present race
  // branch: the ack landed while the present closure was still queued, so its
  // focus request hit a hidden window and reveal+focus move here.
  const paintedGateAt = showBody.indexOf('ARG_PROMPT_PAINTED_ID.load(Ordering::SeqCst) == spec_id');
  assert.ok(
    uncloakAt === -1 || (paintedGateAt !== -1 && paintedGateAt < uncloakAt && showAt < uncloakAt),
    'present may only reveal when the paint ack already landed, after show (raw-frame flash otherwise)'
  );
  // Hide choreography mirrors main/overlay: cloak BEFORE hiding so the
  // window never sits in a visible-but-stale state and the next present
  // uncloaks a warm surface instead of racing a cold one.
  const hideIdx = src.indexOf('fn hide_arg_prompt_window');
  assert.ok(hideIdx !== -1, 'hide helper must exist');
  const hideBody = src.slice(hideIdx, hideIdx + 700);
  assert.ok(
    hideBody.includes('set_window_cloaked(&win, true)'),
    'hide must cloak before hiding (the next present uncloaks a warm surface)'
  );
  assert.ok(
    hideBody.includes('ARGPROMPT_UP.store(false'),
    'hide must drop the up flag (the next show is the cold path)'
  );
  // The show path must stay lean: synchronous main-thread round-trips
  // (url/is_visible/is_focused probes, style recalcs) on every show are wedge
  // surface on the exact path where a hang was once reported. Position, size,
  // show — nothing else.
  assert.doesNotMatch(showBody, /\.url\(\)/, 'show path must not synchronously probe the webview url');
  assert.doesNotMatch(showBody, /set_decorations/, 'no per-show style recalc on the prompt hot path');
  // Focus is taken at the PAINT ACK, not at an unconditional show: the reveal
  // and the focus transfer happen in the same step (no activation bounce on
  // first pop), and a cloaked present taking focus would activate an invisible
  // window. The only show-path focus is the ack-before-present race branch
  // (gated on the painted id) where the ack's own focus request was dropped
  // against a hidden window.
  const focusAt = showBody.indexOf('win.set_focus()');
  assert.ok(
    focusAt === -1 || (paintedGateAt !== -1 && paintedGateAt < focusAt),
    'present must not focus a still-cloaked window (focus belongs to the paint ack)'
  );
  assert.ok(src.includes('fn note_arg_prompt_painted'), 'paint-ack handler must exist');
  assert.ok(lib.includes('argprompt_painted'), 'paint-ack command must be registered');
  const ackIdx = src.indexOf('fn note_arg_prompt_painted');
  const ackBody = src.slice(ackIdx, ackIdx + 3200);
  assert.ok(ackBody.includes('set_window_cloaked(&win, false)'), 'painted ack must lift the cloak');
  assert.ok(
    ackBody.includes('set_window_alpha(&win, 255)'),
    'painted ack must lift the cloak-parked alpha mask before revealing'
  );
  assert.ok(ackBody.includes('win.set_focus()'), 'painted ack must take focus so the argument can be typed');
  assert.ok(ackBody.includes('pending_id != Some(id)'), 'stale acks must be ignored');
  // The ack log must fire for EVERY ack (before the stale check): otherwise a
  // prompt that was answered but never pasted cannot be distinguished from
  // one whose ack never arrived — both look identical in the diag log.
  assert.ok(ackBody.includes('paint ack id='), 'ack must log id vs pending even when stale');
  // Watchdog: unpainted after the paint budget hides + cancels (never hangs
  // the worker). The budget is a named constant because the original literal
  // 300ms was shorter than a cold argprompt webview mount, so every prompt was
  // cancelled as "unpainted" before the user could see it.
  assert.ok(
    src.includes('const ARG_PROMPT_PAINT_TIMEOUT_MS'),
    'watchdog budget must be a named constant'
  );
  assert.ok(
    showBody.includes('ARG_PROMPT_PAINT_TIMEOUT_MS'),
    'watchdog must wait on the named paint budget'
  );
  assert.ok(showBody.includes('unpainted after'), 'watchdog must log the drop');
  assert.ok(showBody.includes('submit_arg_prompt_response(None)'), 'watchdog must cancel the pending prompt');
  // Esc closes (frontend, all three paths).
  const tsx = fs.readFileSync(path.join(ROOT_DIR, 'src', 'components', 'ArgPromptWindow.tsx'), 'utf8');
  assert.ok(tsx.includes('argprompt_painted'), 'frontend must ack first paint');
  assert.ok(tsx.includes("e.key === 'Escape'"), 'window keydown Esc must cancel');
  // ONE unified window: the root div IS the card (border:none, full-bleed).
  // A narrower inner box inside the transparent wrapper read as a window
  // inside a window — the prompt must present as one unified surface.
  assert.ok(
    tsx.includes("border: 'none'"),
    'prompt root must be one unified surface (no card-inside-window)'
  );
  assert.ok(
    tsx.includes('var(--glass-elev)'),
    'input field must follow the material tokens'
  );
  assert.doesNotMatch(
    stripComments(tsx),
    /width: 440/,
    'the fixed-width inner card must be gone (unified full-window surface)'
  );
  // The ack must NOT be rAF-driven. The backend keeps the window cloaked until
  // this ack arrives, and a cloaked window produces no compositor frames, so a
  // requestAnimationFrame ack never fires — which cancelled 100% of prompts.
  // Comments are stripped first so prose explaining the fix cannot satisfy or
  // break the assertion. Neither window needs rAF for anything else, so its
  // absence in code is the guard.
  assert.doesNotMatch(
    stripComments(tsx),
    /requestAnimationFrame/,
    'paint ack must not depend on requestAnimationFrame (cloaked windows produce no frames)'
  );
  assert.ok(tsx.includes('useLayoutEffect'), 'ack should fire on DOM commit, before paint');
  // Focus ownership: the backend present path (main thread) and the paint
  // ack own the focus transition. A cross-process setFocus() from the
  // frontend raced those and bounced activation when the prompt popped —
  // the visible "screen move". The frontend may show(), never focus().
  assert.doesNotMatch(
    stripComments(tsx),
    /\.setFocus\(/,
    'argprompt frontend must not issue a second, racing focus request'
  );
  // Wizard continuity: the card must clear only AFTER the next-prompt check —
  // clearing first renders the transparent shell between sequential prompts
  // (the window goes see-through = the jump before the second argument).
  assert.ok(
    tsx.lastIndexOf('setSpec(null)') > tsx.lastIndexOf('get_pending_arg_request'),
    'card must clear only when no next prompt follows'
  );
  // index.html ships <html class="wm-hidden">; in the default glass material
  // that forces opacity:0 and pointer-events:none, and only choreo.ts (which
  // drives overlay/main) removes it. Without this the prompt window is a
  // permanently invisible slab that still eats clicks.
  assert.ok(
    tsx.includes("classList.remove('wm-hidden')"),
    'argprompt must clear wm-hidden or it renders as an invisible click-eating slab'
  );
  assert.ok(tsx.includes('handleSubmit(null)'), 'cancel must resolve null');
});

test('v37-H arg prompt: surface prep, hidden-side prewarm, no ghost retries', () => {
  const src = readExpansion();
  const showIdx = src.indexOf('fn show_arg_prompt');
  const showBody = src.slice(showIdx, showIdx + 6000);
  // Full show-function slice (present + watchdog sit past the fixed prep
  // window); bounded by the next fn so it never bleeds out of show_arg_prompt.
  const showFull = src.slice(showIdx, src.indexOf('fn note_arg_prompt_painted'));
  // Surface prep: overlay/main get OS material + transparent WebView2 surface
  // at prewarm; argprompt never did, so it composited opaque and glass mode
  // looked solid. Every show must prep the surface while hidden.
  assert.ok(src.includes('fn prepare_prompt_surface'), 'prompt surface prep must exist');
  // Bound the slice to the function itself: a fixed-length window bleeds into
  // show_arg_prompt, which legitimately holds the guard.
  const prepIdx = src.indexOf('fn prepare_prompt_surface');
  const prepEnd = src.indexOf('\nfn ', prepIdx + 1);
  const prepBody = src.slice(prepIdx, prepEnd === -1 ? prepIdx + 2500 : prepEnd);
  assert.ok(prepBody.includes('apply_window_material'), 'prep must apply the OS material');
  assert.ok(prepBody.includes('set_window_default_background'), 'prep must set the material-aware default');
  assert.ok(prepBody.includes('set_webview_transparent_background'), 'prep must force the transparent controller surface');
  // Regression: the prep used to read EXPANSION_CTX itself while show_arg_prompt
  // held that same non-reentrant Mutex — an instant self-deadlock that froze
  // the prompt and the expansion worker. Values must be passed in.
  assert.doesNotMatch(
    stripComments(prepBody),
    /EXPANSION_CTX/,
    'prep must not lock EXPANSION_CTX (called while show_arg_prompt holds that non-reentrant guard)'
  );
  assert.ok(showBody.includes('prepare_prompt_surface(&win, prompt_mat, &prompt_theme)'), 'show path must pass material/theme into prep');
  // argprompt/pill are presented for the first time when a snippet fires, by
  // which point their controllers are not ready. Prewarm them hidden-side like
  // the overlay, otherwise glass never composites and the prompt reads solid.
  const hotkey = fs.readFileSync(path.join(ROOT_DIR, 'src-tauri', 'src', 'hotkey.rs'), 'utf8');
  const pwIdx = hotkey.indexOf('pub fn prewarm_windows');
  const pwBody = hotkey.slice(pwIdx, pwIdx + 8000);
  assert.ok(
    /for label in \["argprompt", "pill"\]/.test(pwBody),
    'prewarm must warm the argprompt/pill surfaces hidden-side'
  );
  assert.ok(
    pwBody.includes('ensure_transparent_surface(&win, mat, &settings.theme, 10, 200)'),
    'prewarm must give the prompt the same generous transparent-surface budget as the overlay'
  );
  // Warm surfaces are not enough: the FIRST present must also happen while
  // hidden. Overlay/main cloak + ShowWindow(SW_SHOWNOACTIVATE) + re-cloak so
  // WebView2 connects its swapchain and paints before the window is ever
  // composed on screen. Without the same dance the first argument prompt does
  // a cold first-present ON screen — the flash/jump when the window pops.
  const loopAt = hotkey.indexOf('for label in ["argprompt", "pill"]');
  assert.ok(loopAt !== -1, 'argprompt/pill prewarm loop must exist');
  const loopEnd = hotkey.indexOf('for label in ["overlay", "main", "pill", "argprompt"]', loopAt);
  const loopBody = hotkey.slice(loopAt, loopEnd === -1 ? loopAt + 2500 : loopEnd);
  assert.ok(
    loopBody.includes('SW_SHOWNOACTIVATE'),
    'argprompt/pill prewarm must run the hidden-side first-present (no on-screen flash)'
  );
  assert.ok(
    (loopBody.match(/set_window_cloaked\(&win, true\)/g) || []).length >= 2,
    'the dance must cloak before and re-cloak after the hidden present'
  );
  // Genuine first-present (main-pattern port): the cloak dance alone never
  // produces a real DWM present — main's own vibrancy docs say the first
  // uncloaked show then composites a cold white surface for ~a second. The
  // prompt gets the same park → present → hide → re-cloak cycle at boot,
  // serialized on the present-cycle lock so the overlapping prewarm passes
  // never park one HWND at once.
  assert.ok(
    loopBody.includes('offscreen_present_cycle'),
    'argprompt/pill prewarm must run the genuine off-screen present cycle'
  );
  assert.ok(
    loopBody.includes('hold_present_cycle'),
    'concurrent prewarm passes must serialize the present cycle'
  );
  const vibrancyRs = fs.readFileSync(path.join(ROOT_DIR, 'src-tauri', 'src', 'vibrancy.rs'), 'utf8');
  assert.ok(
    vibrancyRs.includes('pub(crate) fn offscreen_present_cycle'),
    'the present cycle must be shared with the prewarm (not main-private)'
  );
  // Framelessness comes from the window config (decorations:false), not a
  // per-show style recalc: forcing styles on the show hot path adds DWM
  // churn exactly where a hang was once reported.
  const conf = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const promptWin = conf.app.windows.find((w) => w.label === 'argprompt');
  assert.ok(promptWin, 'argprompt window must be declared');
  assert.strictEqual(promptWin.decorations, false, 'argprompt must be frameless in config');
  // The 250ms retry re-emit must be id-guarded: an answer to prompt N
  // followed by prompt N+1 inside the window would otherwise let the stale
  // retry reopen N's UI on top of N+1 — a ghost that can never resolve.
  // (showFull is defined at the top with the surface-prep assertions.)
  assert.ok(showFull.includes('still_current'), 'retry emit must verify the pending id first');
  assert.ok(showFull.includes('retry_id'), 'retry must carry the id it is allowed to re-emit');
  // Queue contract (FIFO, PENDING lifted, stray submit errors) — pinned here
  // because an executable queue test cannot run in this repo's harness.
  const subIdx = src.indexOf('fn submit_arg_prompt_response');
  const subBody = src.slice(subIdx, subIdx + 1500);
  assert.ok(subBody.includes('q.pop_front()'), 'submit must pop the front entry');
  assert.ok(subBody.includes('entry.tx.send(value)'), 'submit must resolve the popped entry');
  assert.ok(subBody.includes('No pending argument prompt'), 'stray submit must error, not resolve a stranger');
  // Diagnostics for the "Enter does not paste" reports: the submit must log
  // what it saw (value length, pending id, queue depth) BEFORE mutating, and
  // an empty queue (watchdog-cancelled race) must be logged too — otherwise a
  // submit that resolved nothing is invisible in the diag log.
  assert.ok(
    subBody.includes('submit received value_len='),
    'submit must log entry state before mutating the queue'
  );
  assert.ok(
    subBody.includes('queue empty'),
    'an empty-queue submit must be logged (watchdog-cancelled race)'
  );
  const reqIdx = src.indexOf('fn request_arg_value');
  const reqBody = src.slice(reqIdx, reqIdx + 1200);
  assert.ok(reqBody.includes('q.push_back'), 'requests must enqueue');
  assert.ok(reqBody.includes('q.len() == 1'), 'only the front request shows the window');
  // Warm advance: a queued next-prompt shown while the window is already up
  // must not redo DWM surface work or re-steal focus on the live window —
  // that churn is the jump between sequential arguments.
  assert.ok(src.includes('static ARGPROMPT_UP'), 'warm-advance flag must exist');
  assert.ok(
    showFull.includes('ARGPROMPT_UP.store(true'),
    'present must stamp the window up'
  );
  assert.ok(
    showFull.includes('!ARGPROMPT_UP.load'),
    'advance must skip the surface prep + refocus on a live window'
  );
  assert.ok(
    showFull.includes('warm advance id='),
    'skipped prep must be logged'
  );
  assert.ok(
    showFull.includes('ARGPROMPT_UP.store(false'),
    'watchdog hide must drop the up flag'
  );
});

test('v37-K arg prompt show: guard released before prep, present re-checked on the main thread', () => {
  const src = readExpansion();
  const showIdx = src.indexOf('fn show_arg_prompt');
  const showEnd = src.indexOf('fn note_arg_prompt_painted');
  const showBody = src.slice(showIdx, showEnd);
  // The show path must snapshot the context (material, theme, geometry, app
  // handle) under a BRIEF scoped guard and release it BEFORE the surface
  // prep: the prep waits for main-thread `with_webview` work while the
  // frontend's `argprompt_painted` ack re-locks this non-reentrant Mutex from
  // the main thread. Holding it across the prep froze every Carbon window for
  // the whole retry budget — and the queued glass/background work could never
  // run before the prompt was presented, so it composited solid. Brace-count
  // the snapshot block and require the prep call to sit after it closes.
  const snapAt = showBody.indexOf('let (app, prompt_mat, prompt_theme, win_opt) = {');
  assert.ok(snapAt !== -1, 'show must snapshot the context under a scoped guard');
  let depth = 0;
  let closedAt = -1;
  for (let i = showBody.indexOf('{', snapAt); i < showBody.length; i++) {
    const c = showBody[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        closedAt = i;
        break;
      }
    }
  }
  assert.ok(closedAt !== -1, 'snapshot block must close');
  const prepAt = showBody.indexOf('prepare_prompt_surface(');
  assert.ok(prepAt !== -1, 'show must prep the prompt surface');
  assert.ok(prepAt > closedAt, 'surface prep must run after the context guard is released');
  // The present itself runs on the MAIN thread with an authoritative PENDING
  // re-check INSIDE the queued closure: show/hide messages and
  // run_on_main_thread closures share one FIFO queue, so a concurrent submit's
  // clear+hide always wins over a still-queued present (no unanswerable ghost).
  assert.ok(showBody.includes('run_on_main_thread'), 'present must be queued onto the main thread');
  assert.ok(
    showBody.includes('cancelled/superseded before present'),
    'the queued present must re-check PENDING before showing'
  );
  // Emit happens only after prep: the frontend shows the window itself the
  // moment the spec arrives, so an early emit would present an un-prepped
  // (opaque) frame for the whole prep duration.
  assert.ok(
    prepAt < showBody.indexOf('arg-prompt-request'),
    'the spec emit must follow the surface prep'
  );
  // request_arg_value must lift PENDING only when it is still its own id —
  // blanketing None raced the NEXT prompt's install and made its present
  // re-check skip (the prompt never appeared).
  const reqBody = src.slice(src.indexOf('fn request_arg_value'), src.indexOf('fn request_arg_value') + 2400);
  assert.ok(
    reqBody.includes('pending.as_ref().map(|s| s.id) == Some(spec_id)'),
    'request teardown must clear PENDING only for its own prompt id'
  );
});

test('v37-T arg transitions: one geometry probe per sequence, activation restored once at sequence end', () => {
  const src = readExpansion();
  // Geometry: the caret probe is only valid while the typed-into window owns
  // the caret. Between queued arguments the PROMPT is the foreground window,
  // so re-probing could fall back to a different anchor and the window jumped
  // to another corner mid-wizard. Probe once per expansion, reuse for every
  // argument, clear at the next expansion's entry.
  assert.ok(
    src.includes('static ARGPROMPT_SEQ_GEOM'),
    'sequence geometry cache must exist'
  );
  const showIdx = src.indexOf('fn show_arg_prompt');
  const showFull = src.slice(showIdx, src.indexOf('fn note_arg_prompt_painted'));
  assert.ok(
    showFull.includes('ARGPROMPT_SEQ_GEOM'),
    'the prompt show must consult the sequence cache instead of re-probing'
  );
  assert.ok(
    showFull.includes('reusing sequence geometry'),
    'a cache hit must be logged (proves the probe was skipped)'
  );
  const hIdx = src.indexOf('fn handle_expansion');
  assert.ok(
    src.slice(hIdx, hIdx + 5000).includes('ARGPROMPT_SEQ_GEOM) = None'),
    'each expansion must clear stale sequence geometry at entry'
  );
  // Focus: refocusing the target after EVERY answered argument bounced
  // activation target↔prompt between prompts (the visible jump). Exactly ONE
  // refocus belongs in handle_expansion, before the second foreground gate —
  // and only when foreground is the prompt window (a user who switched away
  // mid-sequence must still abort).
  const reqIdx = src.indexOf('fn request_arg_value');
  const reqBody = src.slice(reqIdx, src.indexOf('// Init / shutdown'));
  assert.strictEqual(
    (reqBody.match(/refocus_blocking/g) || []).length,
    1,
    'a successful answer must not refocus — only the cancel/timeout path may'
  );
  assert.ok(
    reqBody.includes('still_our_turn'),
    'cancel teardown must distinguish its own timeout from a submit that already advanced (double-pop)'
  );
  const hBody = src.slice(hIdx, hIdx + 5000);
  assert.ok(
    hBody.includes('restoring target activation after argument sequence'),
    'ONE activation restore belongs before the second foreground gate'
  );
  assert.ok(
    hBody.includes('fg_is_prompt || fg_unsettled'),
    'the restore must not mask a user who switched windows mid-sequence'
  );
});
