/* windows.js —— Akari Designer · Independent Windows Layer (Web port of akari_windows.py)
 * Modal dialog system (alert / confirm / yes-no-cancel / prompt),
 * Backup configuration showing window, Test Mode overlay,
 * 「Dig for Hard!」 dialog, Akari Bank managing window, Settings dialog.
 */
"use strict";

// ============================================================
// Modal Dialog System (replacing tkinter messagebox / simpledialog)
// ============================================================

function _dlg_base(title, msg, buttons, { input = null, inputValue = "" } = {}) {
    return new Promise((resolve) => {
        const ov = document.createElement("div");
        ov.className = "dlg-overlay";
        const box = document.createElement("div");
        box.className = "dlg-box";
        box.setAttribute("role", "dialog");
        box.setAttribute("aria-label", title);
        const h = document.createElement("div");
        h.className = "dlg-title";
        h.textContent = title;
        box.appendChild(h);
        if (msg) {
            const m = document.createElement("div");
            m.className = "dlg-msg";
            m.textContent = msg;
            box.appendChild(m);
        }
        let inp = null;
        if (input) {
            inp = document.createElement("input");
            inp.type = "text";
            inp.className = "dlg-input";
            inp.value = inputValue;
            box.appendChild(inp);
        }
        const bar = document.createElement("div");
        bar.className = "dlg-btns";
        const close = (val) => {
            document.removeEventListener("keydown", onKey, true);
            ov.remove();
            resolve(val);
        };
        const onKey = (e) => {
            if (e.key === "Escape") { e.stopPropagation(); close(null); }
            if (e.key === "Enter" && input) { e.stopPropagation(); close(inp.value); }
        };
        document.addEventListener("keydown", onKey, true);
        let firstBtn = null;
        for (const [label, val, kind] of buttons) {
            const b = document.createElement("button");
            b.className = "dlg-btn" + (kind ? " " + kind : "");
            b.textContent = label;
            b.addEventListener("click", () => close(input ? (val === null ? null : inp.value) : val));
            bar.appendChild(b);
            if (!firstBtn) firstBtn = b;
        }
        box.appendChild(bar);
        ov.appendChild(box);
        ov.addEventListener("mousedown", (e) => { if (e.target === ov && !input) close(null); });
        document.body.appendChild(ov);
        ov.style.zIndex = overlayZ();
        (inp || firstBtn).focus();
        if (inp) inp.select();
    });
}

const dlgAlert = (title, msg) => _dlg_base(title, msg, [["OK", true, "primary"]]);
const dlgConfirm = (title, msg) =>
    _dlg_base(title, msg, [["Yes", true, "primary"], ["No", false]])
        .then(v => v === true);
const dlgYesNoCancel = (title, msg) =>
    _dlg_base(title, msg, [["Yes", true, "primary"], ["No", false], ["Cancel", null]])
        .then(v => v);   // true / false / null
const dlgPrompt = (title, msg, initial = "") =>
    _dlg_base(title, msg, [["OK", true, "primary"], ["Cancel", null]],
              { input: true, inputValue: initial });

// Stacking order for overlays: each new layer goes above the existing ones
function overlayZ() {
    return 100 + document.querySelectorAll(".dlg-overlay,.solve-overlay").length * 10;
}

// Small notification bell (replacement for tkinter bell())
let _audioCtx = null;
function bell() {
    try {
        _audioCtx = _audioCtx || new (window.AudioContext || window.webkitAudioContext)();
        const o = _audioCtx.createOscillator(), g = _audioCtx.createGain();
        o.frequency.value = 880;
        g.gain.setValueAtTime(0.08, _audioCtx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.001, _audioCtx.currentTime + 0.12);
        o.connect(g).connect(_audioCtx.destination);
        o.start();
        o.stop(_audioCtx.currentTime + 0.12);
    } catch (e) { /* silent */ }
}

// ============================================================
// Background Computation Runner (Web Worker with main-thread fallback)
// ============================================================

let _taskId = 0;
const _pending = new Map();

function runTask(type, payload, onProgress = null) {
    /* Run a computation in a Web Worker; resolve with the result.
     * If workers are unavailable (e.g. opened via file://), fall back to a
     * synchronous run on the main thread. */
    if (!window.Worker) return Promise.resolve().then(() => _runSync(type, payload));
    const id = ++_taskId;
    const worker = new Worker("js/worker.js");
    const promise = new Promise((resolve, reject) => {
        _pending.set(id, { resolve, reject });
        worker.onmessage = (e) => {
            const m = e.data;
            if (m.kind === "progress") { if (onProgress) onProgress(m.text); return; }
            worker.terminate();
            _pending.delete(id);
            if (m.kind === "done") {
                resolve(m);
            } else {
                reject(new Error(m.error || "Unknown computation error"));
            }
        };
        worker.onerror = (err) => {
            worker.terminate();
            _pending.delete(id);
            // Fallback: try synchronously (e.g. worker blocked)
            try { resolve(_wrapSync(type, payload)); }
            catch (e2) { reject(e2); }
        };
        worker.postMessage({ id, type, ...payload });
    });
    promise.worker = worker;               // for cancellation via terminate()
    return promise;
}

function _syncResult(type, payload) {
    const p = Puzzle.from_dict(payload.puzzle);
    if (type === "count") {
        const [sols, aborted] = new Solver(p, payload.use_clues !== false)
            .count_solutions(payload.limit || 2);
        return { kind: "done", sols, aborted };
    }
    if (type === "difficulty") return { kind: "done", result: new LogicSolver(p).difficulty() };
    if (type === "dig")
        return { kind: "done", result: dig_for_hardest(p, payload) };
    throw new Error("unknown task");
}
const _wrapSync = (type, payload) => _syncResult(type, payload);
function _runSync(type, payload) { return _syncResult(type, payload); }

// ============================================================
// Backup Configuration / Another Feasible Solution Showing Window
// ============================================================

function showSolutionWindow(puzzle, lights, title) {
    /* Non-modal panel: show a light configuration and its lighted ranges. */
    document.querySelectorAll(".sol-overlay").forEach(x => x.remove());
    const ov = document.createElement("div");
    ov.className = "dlg-overlay sol-overlay";
    const box = document.createElement("div");
    box.className = "dlg-box dlg-wide";
    const h = document.createElement("div");
    h.className = "dlg-title";
    h.textContent = title;
    box.appendChild(h);
    const wrap = document.createElement("div");
    wrap.className = "sol-canvas-wrap";
    box.appendChild(wrap);
    const btnBar = document.createElement("div");
    btnBar.className = "dlg-btns";
    const btnClose = document.createElement("button");
    btnClose.className = "dlg-btn";
    btnClose.textContent = "Close";
    btnClose.addEventListener("click", () => ov.remove());
    btnBar.appendChild(btnClose);
    box.appendChild(btnBar);
    ov.appendChild(box);
    ov.addEventListener("mousedown", (e) => { if (e.target === ov) ov.remove(); });
    document.body.appendChild(ov);
    ov.style.zIndex = overlayZ();

    // ---- Draw (port of SolutionWindow._draw) ----
    const cs = Math.max(16, Math.min(36, Math.floor(640 / Math.max(puzzle.rows, puzzle.cols, 1))));
    const w = puzzle.cols * cs + 2, hh = puzzle.rows * cs + 2;
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = hh;
    wrap.appendChild(cv);
    const ctx = cv.getContext("2d");
    const saved = puzzle.lights;                 // borrow the puzzle to compute lighted ranges
    puzzle.lights = new Set(lights);
    const lit = puzzle.lit_info();
    puzzle.lights = saved;
    for (let r = 0; r < puzzle.rows; r++) {
        for (let c = 0; c < puzzle.cols; c++) {
            const x0 = c * cs + 1, y0 = r * cs + 1;
            const t = puzzle.grid[r][c];
            let color;
            if (t === OUTSIDE) color = C("outside");
            else if (t === WALL) color = C("wall");
            else {
                const n = lit.get(RC(r, c)) || 0;
                color = n >= 2 ? C("lit2") : (n === 1 ? C("lit1") : C("unlit"));
            }
            ctx.fillStyle = color;
            ctx.fillRect(x0, y0, cs, cs);
            ctx.strokeStyle = C("grid");
            ctx.lineWidth = 1;
            ctx.strokeRect(x0 + 0.5, y0 + 0.5, cs - 1, cs - 1);
            if (t === WALL && puzzle.clues.has(RC(r, c))) {
                const active = puzzle.clue_active.get(RC(r, c)) !== false;
                if (!active && S.hide_inactive_clues) continue;
                ctx.fillStyle = active ? C("clue") : C("clueoff");
                ctx.font = `bold ${Math.max(9, Math.floor(cs / 2) - 2)}px Arial, sans-serif`;
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.fillText(String(puzzle.clues.get(RC(r, c))), x0 + cs / 2, y0 + cs / 2);
            }
        }
    }
    for (const key of lights) {
        const [r, c] = Array.isArray(key) ? key : unRC(key);
        const cx = c * cs + 1 + cs / 2, cy = r * cs + 1 + cs / 2, rad = Math.floor(cs / 3);
        ctx.beginPath();
        ctx.arc(cx, cy, rad, 0, Math.PI * 2);
        ctx.fillStyle = C("bulb");
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = C("bulb_edge");
        ctx.stroke();
    }
    btnClose.focus();
}

// ============================================================
// Test Mode (Full-page overlay; closing it ≡ Exiting Test Mode)
// ============================================================

class SolveWindow {
    /* Test Mode: get a copy with only walls and valid clues, without lights;
     * the user solves it in place; left-click to put/remove lights,
     * right-click to mark 「×」.
     * Non-blocking animation feedback is given when rules are violated;
     * the whole board changes color for celebration when completed.
     *
     * independent=true is used by 「Test the Puzzle」 of Akari Bank:
     * the editing of the main window is not locked, and closing the window
     * only closes itself; keep_lights=true keeps the lights that the
     * puzzle already has. */
    constructor(app, puzzle, { independent = false, keep_lights = false, name = "" } = {}) {
        this.app = app;
        this.independent = independent;
        this.marks = new Set();
        this._exceeded = new Set();        // clues currently in the 「exceeded」 state
        this._alarms = new Set();          // unfulfilled clues needing continuous flashing
        // Copy the puzzle: walls / holes / clues are taken as they are;
        // lights are cleared by default
        this.puzzle = new Puzzle(puzzle.rows, puzzle.cols);
        this.puzzle.grid = puzzle.grid.map(row => row.slice());
        this.puzzle.clues = new Map(puzzle.clues);
        this.puzzle.clue_active = new Map(puzzle.clue_active);
        if (keep_lights) this.puzzle.lights = new Set(puzzle.lights);

        // ---------- Build the overlay ----------
        const ov = document.createElement("div");
        ov.className = "solve-overlay";
        this.overlay = ov;
        const tbar = document.createElement("div");
        tbar.className = "solve-tbar";
        ov.appendChild(tbar);
        const mk = (text, fn) => {
            const b = document.createElement("button");
            b.className = "tb-btn";
            b.textContent = text;
            b.addEventListener("click", fn);
            tbar.appendChild(b);
            return b;
        };
        mk("← Exit Test Mode", () => this._close());
        mk("Check Progress", () => this.check_progress());
        mk("Clear & Restart", () => this.reset());
        mk("Show Answer", () => this.show_answer());
        const sep = document.createElement("span");
        sep.className = "tb-sep";
        tbar.appendChild(sep);
        // Quick display switches (linked with the options of the same names in 「⚙ Settings」)
        const mkChk = (label, key) => {
            const lb = document.createElement("label");
            lb.className = "tb-chk";
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.checked = S[key];
            cb.addEventListener("change", () => this._quick_opt(key, cb.checked));
            lb.appendChild(cb);
            lb.appendChild(document.createTextNode(label));
            tbar.appendChild(lb);
            return cb;
        };
        this._vHideMarks = mkChk("Hide “×” on lighted cells", "hide_lit_marks");
        this._vCountdown = mkChk("Clue Countdown", "clue_countdown");
        const hint = document.createElement("span");
        hint.className = "tb-hint";
        hint.textContent = "Left-click: Put / Remove a light　Right-click (long-press on touch): Mark 「×」";
        tbar.appendChild(hint);

        const body = document.createElement("div");
        body.className = "solve-body";
        ov.appendChild(body);

        const bottom = document.createElement("div");
        bottom.className = "status-bar";
        ov.appendChild(bottom);
        this.statusEl = document.createElement("div");
        this.statusEl.className = "status-text";
        this.statusEl.textContent = "Test Mode: Left-click to put lights; right-click to mark 「×」.";
        bottom.appendChild(this.statusEl);
        document.body.appendChild(ov);
        ov.style.zIndex = overlayZ();
        this.board = new BoardView(body, this);
        this.board.build(this.puzzle);
        this.board.set_zoom(app.board.zoom);
        const zb = makeZoomBar(() => this.board.zoom, (v) => this.board.set_zoom(v));
        bottom.appendChild(zb);
        this.board.onzoom = () => zb.refresh();
        this.board.redraw({ solve_feedback: true, marks: this.marks });

        // Protection of the puzzle data is implemented by the 「Puzzle
        // Modifying Lock」 of the main window; independent windows opened by
        // 「Test the Puzzle」 of Akari Bank do not trigger the editing lock.
        if (!independent) app._set_edit_lock(true);
        if (keep_lights) this._after_change();
        this.status(name ? `Test the Puzzle —— ${name}` : null);
    }

    status(t) { if (t !== null && t !== undefined) this.statusEl.textContent = t; }

    _quick_opt(key, value) {
        /* Display switches on the toolbar: write into the global settings and
         * redraw immediately (linked with the Settings dialog). */
        S[key] = value;
        save_settings();
        if (key === "hide_lit_marks")
            this.board.redraw({ solve_feedback: true, marks: this.marks, alarms: this._alarms });
        else if (key === "clue_countdown")
            this._after_change();
        // If the Settings dialog is open, synchronize the check state in it
        if (this.app.settingsDlg && key in this.app.settingsDlg.optVars)
            this.app.settingsDlg.optVars[key].checked = value;
    }

    _close() {
        this.overlay.remove();
        if (this.independent) {
            const i = this.app.solveWins.indexOf(this);
            if (i >= 0) this.app.solveWins.splice(i, 1);
        } else {
            this.app.exit_solve();
        }
    }

    // ---------- BoardView Events ----------
    canvas_press(cell) {
        if (cell === null) return;
        const p = this.puzzle;
        const [r, c] = cell;
        if (p.grid[r][c] !== WHITE) return;
        const key = RC(r, c);
        if (p.lights.has(key)) {
            p.lights.delete(key);
            this._after_change();
        } else {
            if ((p.lit_info().get(key) || 0) > 0) {
                // The conflict cell flashes red along with the line segment lighting it
                this.status("This cell is already illuminated by another light!");
                this.board.flash_conflict(cell);
                bell();
                return;
            }
            p.lights.add(key);
            this.marks.delete(key);
            this._after_change();
        }
    }
    canvas_drag() { /* no dragging in Test Mode */ }
    canvas_release() { /* no dragging in Test Mode */ }
    canvas_right(cell) {
        if (cell === null) return;
        const p = this.puzzle;
        const [r, c] = cell;
        const key = RC(r, c);
        if (p.grid[r][c] === WHITE && !p.lights.has(key)) {
            if (this.marks.has(key)) this.marks.delete(key);
            else this.marks.add(key);
            this.board.redraw({ solve_feedback: true, marks: this.marks, alarms: this._alarms });
        }
    }

    // ---------- Unified processing after each change ----------
    _after_change() {
        const p = this.puzzle;
        const lit = p.lit_info();
        let allLit = true;
        for (const cell of p.white_cells())
            if (!(lit.get(RC(...cell)) > 0)) { allLit = false; break; }
        const [lacking, exceeded] = this._clue_state();
        this._alarms = allLit ? new Set([...lacking, ...exceeded]) : new Set();
        this.board.redraw({ solve_feedback: true, marks: this.marks, alarms: this._alarms });
        // Newly 「exceeded」 clues → shake for warning
        for (const rc of exceeded)
            if (!this._exceeded.has(rc)) this.board.shake_cell(rc);
        this._exceeded = exceeded;
        this._check_end();
    }

    _clue_state() {
        /* Return [unfulfilled set, exceeded set]; only valid clues are counted. */
        const p = this.puzzle;
        const lacking = new Set(), exceeded = new Set();
        for (const [key, k] of p.clues) {
            if (p.clue_active.get(key) === false) continue;
            const [r, c] = unRC(key);
            const actual = this.board._adjacent_lights(r, c);
            if (actual < k) lacking.add(key);
            else if (actual > k) exceeded.add(key);
        }
        return [lacking, exceeded];
    }

    _check_end() {
        const p = this.puzzle;
        const lit = p.lit_info();
        for (const cell of p.white_cells())
            if (!(lit.get(RC(...cell)) > 0)) return;
        const [lacking, exceeded] = this._clue_state();
        const bad = new Set([...lacking, ...exceeded]);
        if (!bad.size) {
            // The board matches the answer → the whole board changes color for celebration
            this.status("🎉 Completed! All cells are lighted, and all clues are satisfied!");
            this.board.flash_bg();
            bell();
            dlgAlert("Completed", "🎉 Congratulations! The board completely matches the correct answer!");
        } else {
            // All lighted but some clues unfulfilled → the border flashes red + related clues shake
            this.status(`All cells are lighted, but ${bad.size} clues are still unfulfilled!`);
            this.board.flash_border();
            for (const rc of bad) this.board.shake_cell(rc);
        }
    }

    // ---------- Function Buttons ----------
    async check_progress() {
        const p = this.puzzle;
        const lit = p.lit_info();
        const unlit = [...p.white_cells()].filter(cell => !(lit.get(RC(...cell)) > 0));
        const [lacking, exceeded] = this._clue_state();
        if (!unlit.length && !lacking.size && !exceeded.size) {
            this.status("Congratulations, completed!");
            await dlgAlert("Check Progress", "🎉 Congratulations! All cells are lighted, all clues are satisfied, and the puzzle is completed!");
            return;
        }
        const parts = [];
        if (unlit.length) parts.push(`${unlit.length} cells are still unlighted`);
        if (lacking.size) parts.push(`${lacking.size} clues do not have enough lights beside`);
        if (exceeded.size) parts.push(`${exceeded.size} clues are exceeded (Showed as negative values)`);
        this.status("Test Mode: " + parts.join("; "));
        await dlgAlert("Check Progress", "Not completed yet:\n· " + parts.join("\n· "));
    }

    reset() {
        this.puzzle.lights.clear();
        this.marks.clear();
        this._exceeded = new Set();
        this._alarms = new Set();
        this.board.redraw({ solve_feedback: true, marks: this.marks });
        this.status("Test Mode: Cleared. Restart!");
    }

    async show_answer() {
        if (!await dlgConfirm("Show Answer", "Are you sure to show the answer? The complete solution will be directly showed."))
            return;
        this.status("Solving...");
        let sols;
        try {
            const res = await runTask("count", { puzzle: this.puzzle.to_dict(), use_clues: true, limit: 1 });
            sols = res.sols;
        } catch (e) {
            sols = [];
        }
        if (!sols || !sols.length) {
            await dlgAlert("Show Answer", "The current puzzle (According to the valid clues) has NO SOLUTION, or the searching timed out.");
            return;
        }
        this.puzzle.lights = new Set(sols[0].map(([r, c]) => RC(r, c)));
        this.marks.clear();
        this._exceeded = new Set();
        this._alarms = new Set();
        this.board.redraw({ solve_feedback: true, marks: this.marks });
        this.status("Test Mode: The answer has been showed.");
    }
}

// ============================================================
// Word-style Zoom Control (slider + number input + % sign)
// ============================================================

function makeZoomBar(getZoom, setZoom) {
    // WPS-style zoom control: [− Zoom out] [slider] [+ Zoom in] [number] %
    // (v1.2.1: the −/+ ends are labelled so the dragging direction is obvious)
    const box = document.createElement("div");
    box.className = "zoom-bar";
    const out = document.createElement("button");
    out.type = "button";
    out.className = "zoom-end";
    out.textContent = "−";
    out.title = "Zoom out (Drag the slider to the left to shrink)";
    out.setAttribute("aria-label", "Zoom out");
    const scale = document.createElement("input");
    scale.type = "range";
    scale.min = BoardView.ZOOM_MIN;
    scale.max = BoardView.ZOOM_MAX;
    scale.value = getZoom();
    scale.className = "zoom-scale";
    scale.title = "Drag left to shrink, right to enlarge";
    const inn = document.createElement("button");
    inn.type = "button";
    inn.className = "zoom-end";
    inn.textContent = "+";
    inn.title = "Zoom in (Drag the slider to the right to enlarge)";
    inn.setAttribute("aria-label", "Zoom in");
    const num = document.createElement("input");
    num.type = "number";
    num.min = BoardView.ZOOM_MIN;
    num.max = BoardView.ZOOM_MAX;
    num.step = 25;
    num.value = getZoom();
    num.className = "zoom-num";
    const pct = document.createElement("span");
    pct.textContent = "%";
    scale.addEventListener("input", () => { setZoom(+scale.value); num.value = Math.round(getZoom()); });
    const step = (d) => {
        const v = Math.max(BoardView.ZOOM_MIN, Math.min(BoardView.ZOOM_MAX, getZoom() + d));
        setZoom(v); num.value = v; scale.value = v;
    };
    out.addEventListener("click", () => step(-25));
    inn.addEventListener("click", () => step(25));
    const commit = () => {
        let v = parseInt(num.value);
        if (isNaN(v)) { num.value = getZoom(); return; }
        v = Math.max(BoardView.ZOOM_MIN, Math.min(BoardView.ZOOM_MAX, v));
        setZoom(v);
        num.value = v;
        scale.value = v;
    };
    num.addEventListener("change", commit);
    box.refresh = () => { scale.value = getZoom(); num.value = getZoom(); };
    box.appendChild(out);
    box.appendChild(scale);
    box.appendChild(inn);
    box.appendChild(num);
    box.appendChild(pct);
    return box;
}

// ============================================================
// Dig for Hard! (Background worker + Progress feedback + Result applying)
// ============================================================

class DigDialog {
    /* 「③ Dig for Hard!」 dialog.
     * Starting from the current valid clues, search for the deletion with the
     * highest difficulty among those that 「keep the UNIQUE SOLUTION」.
     * The computation runs in a Web Worker; the main window is locked while
     * the dialog is open. */
    constructor(app) {
        this.app = app;
        this._worker = null;
        this._result = null;

        const ov = document.createElement("div");
        ov.className = "dlg-overlay";
        this.overlay = ov;
        const box = document.createElement("div");
        box.className = "dlg-box dlg-wide";
        ov.appendChild(box);
        document.body.appendChild(ov);
        ov.style.zIndex = overlayZ();

        const h = document.createElement("div");
        h.className = "dlg-title";
        h.textContent = "③ Dig for Hard! —— Remove clues to raise the difficulty";
        box.appendChild(h);

        // ---------- Description ----------
        const f0 = document.createElement("fieldset");
        f0.className = "dlg-fieldset";
        f0.innerHTML = "<legend>Function Description</legend>";
        const d0 = document.createElement("div");
        d0.className = "dlg-msg";
        d0.textContent =
            "Under the premise of keeping the 「UNIQUE SOLUTION」, try to\n" +
            "remove several valid clues and find the deletion with the highest\n" +
            "difficulty coefficient. Removed clues become fainter (Not deleted).\n" +
            "After applying the result, you can use 「↩ Undo Digging」 or\n" +
            "「↩ Undo (Ctrl+Z)」 on the main interface to restore them.";
        f0.appendChild(d0);
        box.appendChild(f0);

        // ---------- Options ----------
        const f1 = document.createElement("fieldset");
        f1.className = "dlg-fieldset";
        f1.innerHTML = "<legend>Searching Mode</legend>";
        box.appendChild(f1);
        const mkRadio = (parent, labelText, value, checked) => {
            const lb = document.createElement("label");
            lb.className = "dlg-radio";
            const r = document.createElement("input");
            r.type = "radio";
            r.name = "dig-mode";
            r.value = value;
            r.checked = checked;
            lb.appendChild(r);
            lb.appendChild(document.createTextNode(labelText));
            parent.appendChild(lb);
            return r;
        };
        mkRadio(f1, "Greedy Digging (Recommended): Try removing every candidate each round and accept the one with the highest difficulty; complexity O(k²), also applicable when there are many clues", "greedy", true);
        const row = document.createElement("div");
        row.className = "dlg-radio dig-enum-row";
        const r2 = document.createElement("input");
        r2.type = "radio"; r2.name = "dig-mode"; r2.value = "exhaustive";
        row.appendChild(r2);
        row.appendChild(document.createTextNode("Complete Enumeration: Enumerate all the uniqueness-keeping deletions (With monotonicity pruning), guaranteeing the global optimum; only for no more than "));
        this.enumLimit = document.createElement("input");
        this.enumLimit.type = "number";
        this.enumLimit.min = 4; this.enumLimit.max = 28; this.enumLimit.value = 18;
        this.enumLimit.className = "dig-enum-limit";
        row.appendChild(this.enumLimit);
        row.appendChild(document.createTextNode(" valid clues"));
        f1.appendChild(row);

        const lbLogic = document.createElement("label");
        lbLogic.className = "dlg-radio";
        this.logicOnly = document.createElement("input");
        this.logicOnly.type = "checkbox";
        lbLogic.appendChild(this.logicOnly);
        lbLogic.appendChild(document.createTextNode("Additional requirement: the dug puzzle must be 「solvable by pure logic, no assumption needed」 (Stricter acceptance standard, more conservative digging)"));
        box.appendChild(lbLogic);

        // ---------- Preserved clues (Never removed in this digging) ----------
        const fkp = document.createElement("fieldset");
        fkp.className = "dlg-fieldset";
        fkp.innerHTML = "<legend>Preserved Clues (Must be kept in this digging)</legend>";
        box.appendChild(fkp);
        const kpBar = document.createElement("div");
        kpBar.className = "keep-bar";
        const kpTip = document.createElement("span");
        kpTip.className = "keep-tip";
        kpTip.textContent = "The checked clues will NOT be removed this time, and are excluded from the enumeration count of the Complete Enumeration mode:";
        kpBar.appendChild(kpTip);
        const btnAll = document.createElement("button");
        btnAll.type = "button"; btnAll.className = "dlg-btn keep-mini-btn"; btnAll.textContent = "All";
        const btnNone = document.createElement("button");
        btnNone.type = "button"; btnNone.className = "dlg-btn keep-mini-btn"; btnNone.textContent = "None";
        kpBar.appendChild(btnNone);
        kpBar.appendChild(btnAll);
        fkp.appendChild(kpBar);
        this.keepCount = document.createElement("div");
        this.keepCount.className = "keep-count";
        fkp.appendChild(this.keepCount);
        this.keepList = document.createElement("div");
        this.keepList.className = "keep-list";
        fkp.appendChild(this.keepList);
        this._keepBoxes = [];                // [{cell, box}]
        const activeCells = [...this.app.puzzle.clues.keys()]
            .filter(cell => this.app.puzzle.clue_active.get(cell) !== false)
            .map(unRC).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        for (const [r, c] of activeCells) {
            const lb = document.createElement("label");
            lb.className = "keep-item";
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.addEventListener("change", () => this._updateKeepCount());
            lb.appendChild(cb);
            lb.appendChild(document.createTextNode(`(${r + 1},${c + 1}) = ${this.app.puzzle.clues.get(RC(r, c))}`));
            this.keepList.appendChild(lb);
            this._keepBoxes.push({ cell: RC(r, c), box: cb });
        }
        if (!activeCells.length) {
            const em = document.createElement("div");
            em.className = "keep-tip";
            em.textContent = "(No valid clues on the board)";
            this.keepList.appendChild(em);
        }
        btnAll.addEventListener("click", () => { this._keepBoxes.forEach(k => k.box.checked = true); this._updateKeepCount(); });
        btnNone.addEventListener("click", () => { this._keepBoxes.forEach(k => k.box.checked = false); this._updateKeepCount(); });
        this._updateKeepCount();

        // ---------- Progress & Result ----------
        this.progress = document.createElement("progress");
        this.progress.className = "dig-progress";
        this.progress.style.display = "none";
        box.appendChild(this.progress);
        this.progText = document.createElement("div");
        this.progText.className = "dig-progtext";
        this.progText.textContent = "Ready.";
        box.appendChild(this.progText);
        this.report = document.createElement("textarea");
        this.report.className = "dig-report";
        this.report.readOnly = true;
        box.appendChild(this.report);

        // ---------- Buttons ----------
        const f3 = document.createElement("div");
        f3.className = "dlg-btns dig-btns";
        box.appendChild(f3);
        const mkBtn = (text, fn, cls = "") => {
            const b = document.createElement("button");
            b.className = "dlg-btn " + cls;
            b.textContent = text;
            b.addEventListener("click", fn);
            f3.appendChild(b);
            return b;
        };
        this.btnStart = mkBtn("Start Digging", () => this._start(), "primary");
        this.btnCancel = mkBtn("Cancel", () => this._cancelDig());
        this.btnCancel.disabled = true;
        mkBtn("Close", () => this._onClose());
        this.btnApply = mkBtn("Apply the Result", () => this._apply(), "primary");
        this.btnApply.disabled = true;

        // Lock the main window during the dialog to prevent mistaken editing
        app.digOpen = true;
        app._refresh_lock_ui();
    }

    _set_report(t) { this.report.value = t; }

    _keptCells() {
        return this._keepBoxes.filter(k => k.box.checked).map(k => k.cell);
    }

    _updateKeepCount() {
        const total = this._keepBoxes.length;
        const kept = this._keptCells().length;
        this.keepCount.textContent =
            `${total} valid clues in total; ${kept} preserved → ${total - kept} actually involved in the digging/enumeration`;
    }

    _start() {
        let limit = parseInt(this.enumLimit.value);
        if (isNaN(limit)) limit = 18;
        limit = Math.max(4, Math.min(28, limit));
        const p = this.app.puzzle;
        const k = [...p.clue_active.values()].filter(v => v).length;
        this._result = null;
        this.btnApply.disabled = true;
        this.btnStart.disabled = true;
        this.btnCancel.disabled = false;
        this.progress.style.display = "";
        this.progress.removeAttribute("value");
        const keep = this._keptCells();
        this.progText.textContent = `Started digging: ${k} valid clues`
            + (keep.length ? ` (${keep.length} preserved)` : "")
            + ", computing in the background...";
        this._set_report("");

        const mode = document.querySelector('input[name="dig-mode"]:checked').value;
        const payload = {
            puzzle: p.to_dict(), mode, enum_limit: limit,
            logic_only: this.logicOnly.checked, keep,
        };
        const task = runTask("dig", payload, (t) => { this.progText.textContent = t; });
        this._worker = task.worker || null;
        task.then((m) => this._finish(m.result))
            .catch((e) => this._stop_ui("An exception occurred during computation: " + e.message));
    }

    _cancelDig() {
        if (this._worker) { this._worker.terminate(); this._worker = null; }
        this._stop_ui("Cancelled.");
    }

    _stop_ui(text) {
        this.progress.style.display = "none";
        this.progText.textContent = text;
        this.btnStart.disabled = false;
        this.btnCancel.disabled = true;
        this._worker = null;
    }

    _finish(res) {
        this._stop_ui("Computation completed.");
        if (!res.ok) {
            this._set_report("Cannot complete the digging:\n" + (res.msg || "Unknown reason")
                             + `\n\n(Uniqueness verification executed ${res.checks || 0} times)`);
            return;
        }
        this._result = res;
        const lines = [
            "✔ Found the hardest deletion that keeps the UNIQUE SOLUTION:",
            "",
            `  Remove ${res.removed.length} clues:`,
            "  " + res.removed.map(([r, c]) => `(${r + 1},${c + 1})`).join(", "),
            "",
            `  Difficulty coefficient after deletion: ${res.score} (${res.level})`,
        ];
        if (res.guesses > 0)
            lines.push(`  Solving after deletion still needs assumption branches × ${res.guesses} layers`);
        else
            lines.push("  No assumption needed after deletion; solvable by pure logic ✔");
        if (res.pruned)
            lines.push("",
                       `  Complete enumeration statistics: ${res.checks} subsets verified, ${res.pruned} skipped by pruning; at most ${res.max_removed} clues removable while keeping the UNIQUE SOLUTION`);
        else
            lines.push("", `  Statistics: uniqueness verification × ${res.checks}, difficulty evaluation × ${res.evals}`);
        if (res.kept)
            lines.push(`  ${res.kept} clues designated as preserved were not involved in this digging.`);
        if (res.aborted_unknown)
            lines.push(`  CAUTION: ${res.aborted_unknown} verifications were aborted due to too large scale (Treated as unremovable).`);
        if (res.truncated)
            lines.push(`  CAUTION: ${res.truncated} The result is the optimum of the searched part (May not be the global optimum).`);
        lines.push("",
                   "Click 「Apply the Result」 to mark these clues as removed (Fainter);",
                   "after applying, you can use 「↩ Undo Digging」 or 「↩ Undo (Ctrl+Z)」 on the main interface to restore them.");
        this._set_report(lines.join("\n"));
        this.btnApply.disabled = false;
    }

    _apply() {
        if (this._result !== null)
            this.app.apply_dig(this._result.removed);
        this._onClose();
    }

    _onClose() {
        if (this._worker) { this._worker.terminate(); this._worker = null; }
        this.overlay.remove();
        this.app.digOpen = false;
        this.app.digDlg = null;
        this.app._refresh_lock_ui();
    }
}

// ============================================================
// Akari Bank Managing Window (Local Bank + External Bank + Examples)
// ============================================================

const BANK_KEY = "akari_bank_v1";

function bankLoad() {
    try { return JSON.parse(localStorage.getItem(BANK_KEY) || "{}"); }
    catch (e) { return {}; }
}
function bankSave(bank) {
    try { localStorage.setItem(BANK_KEY, JSON.stringify(bank)); } catch (e) { /* full */ }
}

class LibraryWindow {
    /* Akari Bank: centrally manage the saved .akari puzzle files.
     * · Local Bank: stored in the browser (localStorage) — the destination of
     *   「⚡ Save into Akari Bank」;
     * · External Bank: any folder chosen by the user (File System Access API),
     *   or .akari files picked for this session;
     * · Examples: the EXAMPLE puzzles bundled with the web version (read-only). */
    constructor(app) {
        this.app = app;
        this.examples = [];                // [{file, title}]
        this.extFiles = new Map();         // name -> File (session-picked files, fallback)

        const ov = document.createElement("div");
        ov.className = "dlg-overlay";
        this.overlay = ov;
        const box = document.createElement("div");
        box.className = "dlg-box dlg-library";
        ov.appendChild(box);
        document.body.appendChild(ov);
        ov.style.zIndex = overlayZ();

        const h = document.createElement("div");
        h.className = "dlg-title";
        h.textContent = "📚 Akari Bank —— Manage the saved puzzles";
        box.appendChild(h);
        const tip = document.createElement("div");
        tip.className = "lib-tip";
        tip.textContent = "Akari Bank can be used at the same time with the Design/Test windows; double-click an item = Test the Puzzle.";
        box.appendChild(tip);

        const paned = document.createElement("div");
        paned.className = "lib-paned";
        box.appendChild(paned);

        // ---- Local Bank ----
        const f1 = document.createElement("fieldset");
        f1.className = "dlg-fieldset lib-col";
        f1.innerHTML = "<legend>Local Bank (「⚡ Save into Akari Bank」 saves here)</legend>";
        const sub1 = document.createElement("div");
        sub1.className = "lib-sub";
        sub1.textContent = "Stored in this browser (localStorage)";
        f1.appendChild(sub1);
        this.lbLocal = document.createElement("select");
        this.lbLocal.className = "lib-list";
        this.lbLocal.size = 10;
        f1.appendChild(this.lbLocal);
        paned.appendChild(f1);

        // ---- External Bank ----
        const f2 = document.createElement("fieldset");
        f2.className = "dlg-fieldset lib-col";
        f2.innerHTML = "<legend>External Bank (A folder of your choice)</legend>";
        const row2t = document.createElement("div");
        row2t.className = "lib-ext-row";
        this.extLabel = document.createElement("span");
        this.extLabel.className = "lib-sub lib-ext-label";
        row2t.appendChild(this.extLabel);
        const btnPick = document.createElement("button");
        btnPick.className = "dlg-btn";
        btnPick.textContent = "Choose Folder...";
        btnPick.addEventListener("click", () => this._pickExt());
        row2t.appendChild(btnPick);
        f2.appendChild(row2t);
        if (!window.showDirectoryPicker) {
            const btnFiles = document.createElement("button");
            btnFiles.className = "dlg-btn";
            btnFiles.textContent = "Add .akari Files...";
            btnFiles.title = "This browser does not support folder access; picked files stay for this session only.";
            btnFiles.addEventListener("click", () => this._pickFiles());
            row2t.appendChild(btnFiles);
        }
        this.lbExt = document.createElement("select");
        this.lbExt.className = "lib-list";
        this.lbExt.size = 8;
        f2.appendChild(this.lbExt);
        paned.appendChild(f2);

        // ---- Examples ----
        const f3 = document.createElement("fieldset");
        f3.className = "dlg-fieldset lib-col";
        f3.innerHTML = "<legend>Examples (Bundled, read-only)</legend>";
        this.lbEx = document.createElement("select");
        this.lbEx.className = "lib-list";
        this.lbEx.size = 8;
        f3.appendChild(this.lbEx);
        paned.appendChild(f3);

        // Selections of the three lists are mutually exclusive; double-click = Test
        const lists = [this.lbLocal, this.lbExt, this.lbEx];
        for (const lb of lists) {
            lb.addEventListener("change", () => {
                for (const other of lists) if (other !== lb) other.selectedIndex = -1;
            });
            lb.addEventListener("dblclick", () => this._test());
        }

        // ---- Operation Buttons ----
        const btns = document.createElement("div");
        btns.className = "dlg-btns lib-btns";
        box.appendChild(btns);
        const mk = (text, fn) => {
            const b = document.createElement("button");
            b.className = "dlg-btn";
            b.textContent = text;
            b.addEventListener("click", fn);
            btns.appendChild(b);
            return b;
        };
        mk("Continue Designing (Open in the Design window)", () => this._continue());
        mk("Test the Puzzle (Open in the Test window)", () => this._test());
        mk("Output Puzzle Graph", () => this._export());
        mk("Rename...", () => this._rename());
        mk("Delete...", () => this._delete());
        mk("Refresh", () => this.refresh());
        const bc = document.createElement("button");
        bc.className = "dlg-btn";
        bc.textContent = "Close";
        bc.addEventListener("click", () => this._close());
        btns.appendChild(bc);

        ov.addEventListener("mousedown", (e) => { if (e.target === ov) this._close(); });

        this._updateExtLabel();
        this._loadExamples();
        this.refresh();
    }

    // ---------------- List Maintenance ----------------
    async _loadExamples() {
        try {
            const res = await fetch("examples/manifest.json");
            this.examples = await res.json();
        } catch (e) { this.examples = []; }
        this.lbEx.innerHTML = "";
        for (const ex of this.examples) {
            const o = document.createElement("option");
            o.textContent = ex.title || ex.file;
            o.value = ex.file;
            this.lbEx.appendChild(o);
        }
    }

    _fillLocal() {
        this.lbLocal.innerHTML = "";
        this._localNames = Object.keys(bankLoad()).sort();
        for (const fn of this._localNames) {
            const o = document.createElement("option");
            o.textContent = fn;
            this.lbLocal.appendChild(o);
        }
    }

    async _fillExt() {
        this.lbExt.innerHTML = "";
        this._extNames = [];
        if (this.app.extDirHandle) {
            try {
                const names = [];
                for await (const entry of this.app.extDirHandle.values())
                    if (entry.kind === "file" && entry.name.toLowerCase().endsWith(".akari"))
                        names.push(entry.name);
                this._extNames = names.sort();
            } catch (e) { this._extNames = []; }
        } else {
            this._extNames = [...this.extFiles.keys()].sort();
        }
        for (const fn of this._extNames) {
            const o = document.createElement("option");
            o.textContent = fn;
            this.lbExt.appendChild(o);
        }
    }

    refresh() {
        this._fillLocal();
        this._fillExt();
    }

    _updateExtLabel() {
        this.extLabel.textContent =
            (this.app.extDirHandle && this.app.extDirHandle.name)
            || S.ext_library_dir
            || (this.extFiles.size ? `${this.extFiles.size} file(s) picked for this session` : "(No folder chosen yet)");
    }

    // ---------------- Source of the Selection ----------------
    _selected() {
        /* Return {src: "local"|"ext"|"example", name} or null. */
        if (this.lbLocal.selectedIndex >= 0)
            return { src: "local", name: this._localNames[this.lbLocal.selectedIndex] };
        if (this.lbExt.selectedIndex >= 0)
            return { src: "ext", name: this._extNames[this.lbExt.selectedIndex] };
        if (this.lbEx.selectedIndex >= 0)
            return { src: "example", name: this.lbEx.value };
        return null;
    }

    async _readSelected(sel) {
        if (sel.src === "local") {
            const content = bankLoad()[sel.name];
            if (content === undefined) throw new Error("The file no longer exists in the Local Bank.");
            return content;
        }
        if (sel.src === "example") {
            const res = await fetch("examples/" + sel.name);
            if (!res.ok) throw new Error("Cannot fetch the example file.");
            return await res.text();
        }
        if (this.app.extDirHandle) {
            const fh = await this.app.extDirHandle.getFileHandle(sel.name);
            const f = await fh.getFile();
            return await f.text();
        }
        const f = this.extFiles.get(sel.name);
        if (!f) throw new Error("The file is not available anymore.");
        return await f.text();
    }

    // ---------------- External Bank ----------------
    async _pickExt() {
        if (!window.showDirectoryPicker) { this._pickFiles(); return; }
        try {
            const dir = await window.showDirectoryPicker({ mode: "readwrite" });
            this.app.extDirHandle = dir;
            S.ext_library_dir = dir.name;
            save_settings();
            this._updateExtLabel();
            this.refresh();
        } catch (e) { /* cancelled */ }
    }

    _pickFiles() {
        const inp = document.createElement("input");
        inp.type = "file";
        inp.accept = ".akari";
        inp.multiple = true;
        inp.addEventListener("change", () => {
            for (const f of inp.files) this.extFiles.set(f.name, f);
            this._updateExtLabel();
            this.refresh();
        });
        inp.click();
    }

    // ---------------- Operations ----------------
    async _continue() {
        const sel = this._selected();
        if (!sel) { bell(); return; }
        if (this.app._edit_locked("Open a puzzle from Akari Bank")) return;
        try {
            const content = await this._readSelected(sel);
            await this.app._load_content(content, sel.name, { ask_lights: true });
        } catch (e) {
            await dlgAlert("Failed to Open", String(e.message || e));
        }
    }

    async _test() {
        const sel = this._selected();
        if (!sel) { bell(); return; }
        let p;
        try {
            p = Puzzle.load(await this._readSelected(sel));
        } catch (e) {
            await dlgAlert("Failed to Open", String(e.message || e));
            return;
        }
        const name = sel.name.replace(/\.akari$/i, "");
        const win = new SolveWindow(this.app, p, { independent: true, name });
        this.app.solveWins.push(win);
    }

    async _export() {
        const sel = this._selected();
        if (!sel) { bell(); return; }
        let p;
        try {
            p = Puzzle.load(await this._readSelected(sel));
        } catch (e) {
            await dlgAlert("Failed to Open", String(e.message || e));
            return;
        }
        let withLights = false;
        if (p.lights.size)
            withLights = await dlgConfirm(
                "Output Puzzle Graph",
                "This puzzle contains lights. Should the output graph contain the lights?\n" +
                "(Choose 「No」 for puzzle collections and 「Yes」 for the answer reference)");
        let base = sel.name.replace(/\.akari$/i, "");
        base += withLights ? "(With Lights)" : "(No Lights)";
        const blob = await export_puzzle_image(p, { cell: 40, show_lights: withLights, format: "png" });
        downloadBlob(blob, base + ".png");
    }

    async _rename() {
        const sel = this._selected();
        if (!sel) { bell(); return; }
        if (sel.src === "example") {
            await dlgAlert("Rename the Puzzle", "Bundled examples are read-only and cannot be renamed.");
            return;
        }
        const old = sel.name.replace(/\.akari$/i, "");
        let nw = await dlgPrompt("Rename the Puzzle",
                                 "Input a new name (The extension .akari is kept automatically):\n\nCurrent name:\n" + old,
                                 old);
        if (nw === null) return;
        nw = nw.trim();
        if (!nw || nw === old) return;
        if (nw.toLowerCase().endsWith(".akari")) nw = nw.slice(0, -6);
        if (/[\\/:*?"<>|]/.test(nw)) {
            await dlgAlert("Failed to Rename", "The name cannot contain the following characters:\n  \\ / : * ? \" < > |");
            return;
        }
        const newName = nw + ".akari";
        try {
            if (sel.src === "local") {
                const bank = bankLoad();
                if (newName in bank) {
                    await dlgAlert("Failed to Rename", "A file with the same name already exists!");
                    return;
                }
                bank[newName] = bank[sel.name];
                delete bank[sel.name];
                bankSave(bank);
            } else if (this.app.extDirHandle) {
                const fh = await this.app.extDirHandle.getFileHandle(sel.name);
                const f = await fh.getFile();
                const content = await f.text();
                try { await this.app.extDirHandle.getFileHandle(newName); 
                      await dlgAlert("Failed to Rename", "A file with the same name already exists!"); return; }
                catch (e) { /* not exists, good */ }
                const nh = await this.app.extDirHandle.getFileHandle(newName, { create: true });
                const w = await nh.createWritable();
                await w.write(content);
                await w.close();
                await this.app.extDirHandle.removeEntry(sel.name);
            } else {
                const f = this.extFiles.get(sel.name);
                if (this.extFiles.has(newName)) {
                    await dlgAlert("Failed to Rename", "A file with the same name already exists!");
                    return;
                }
                this.extFiles.set(newName, new File([f], newName));
                this.extFiles.delete(sel.name);
            }
        } catch (e) {
            await dlgAlert("Failed to Rename", String(e.message || e));
            return;
        }
        this.refresh();
        // Select the renamed item again for convenient continuous operations
        const lb = sel.src === "local" ? this.lbLocal : this.lbExt;
        const names = sel.src === "local" ? this._localNames : this._extNames;
        const idx = names.indexOf(newName);
        if (idx >= 0) lb.selectedIndex = idx;
    }

    async _delete() {
        const sel = this._selected();
        if (!sel) { bell(); return; }
        if (sel.src === "example") {
            await dlgAlert("Delete the Puzzle", "Bundled examples are read-only and cannot be deleted.");
            return;
        }
        if (!await dlgConfirm("Delete the Puzzle",
                              `Are you sure to delete the following puzzle file?\n\n${sel.name}\n\nCAUTION: Deleting directly removes the file without entering the Recycle Bin, and it cannot be restored.`))
            return;
        try {
            if (sel.src === "local") {
                const bank = bankLoad();
                delete bank[sel.name];
                bankSave(bank);
            } else if (this.app.extDirHandle) {
                await this.app.extDirHandle.removeEntry(sel.name);
            } else {
                this.extFiles.delete(sel.name);
            }
        } catch (e) {
            await dlgAlert("Failed to Delete", String(e.message || e));
            return;
        }
        this.refresh();
    }

    _close() {
        this.overlay.remove();
        this.app.libraryWin = null;
    }
}

// ============================================================
// Download Helper
// ============================================================

function downloadBlob(blob, filename) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 800);
}

// ============================================================
// Settings Dialog (Theme & Display Options & Color of Elements)
// ============================================================

class SettingsDialog {
    constructor(app) {
        this.app = app;
        this.optVars = {};

        const ov = document.createElement("div");
        ov.className = "dlg-overlay";
        this.overlay = ov;
        const box = document.createElement("div");
        box.className = "dlg-box dlg-settings";
        ov.appendChild(box);
        document.body.appendChild(ov);
        ov.style.zIndex = overlayZ();

        const h = document.createElement("div");
        h.className = "dlg-title";
        h.textContent = "Settings";
        box.appendChild(h);

        // ---- Theme ----
        const f1 = document.createElement("fieldset");
        f1.className = "dlg-fieldset";
        f1.innerHTML = "<legend>Theme</legend>";
        box.appendChild(f1);
        for (const [key, label] of [["light", "DAY"], ["dark", "NIGHT"]]) {
            const lb = document.createElement("label");
            lb.className = "dlg-radio dlg-radio-inline";
            const r = document.createElement("input");
            r.type = "radio";
            r.name = "set-theme";
            r.value = key;
            r.checked = S.theme === key;
            r.addEventListener("change", () => this._setTheme(key));
            lb.appendChild(r);
            lb.appendChild(document.createTextNode(label));
            f1.appendChild(lb);
        }

        // ---- Display Options ----
        const f2 = document.createElement("fieldset");
        f2.className = "dlg-fieldset";
        f2.innerHTML = "<legend>Display Options (Affect Design & Test Mode)</legend>";
        box.appendChild(f2);
        for (const [key, label] of [
            ["hide_lit_marks", "Hide “×” on lighted cells"],
            ["hide_inactive_clues", "Hide not provided clues (Instead of being fainter)"],
            ["clue_countdown", "Show remaining number of lights in Test Mode (-1 when light beside a clue)"],
            ["red_unsatisfied", "Mark unfuifilled clues in red"],
        ]) {
            const lb = document.createElement("label");
            lb.className = "dlg-radio";
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.checked = S[key];
            cb.addEventListener("change", () => this._applyOptions());
            this.optVars[key] = cb;
            lb.appendChild(cb);
            lb.appendChild(document.createTextNode(label));
            f2.appendChild(lb);
        }

        // ---- Clues Recounting and Effect ----
        const f2b = document.createElement("fieldset");
        f2b.className = "dlg-fieldset";
        f2b.innerHTML = "<legend>Clues Recounting and Effect</legend>";
        box.appendChild(f2b);
        const cap = document.createElement("div");
        cap.className = "lib-sub";
        cap.textContent = "Recounting Strategy under 「Lights First」:";
        f2b.appendChild(cap);
        for (const [val, label] of [
            ["ask", "Always ask when manually set clues are being covered (Default, Recommended)"],
            ["auto", "Always recount (Manually set clues may be covered) (No more reminder)"],
            ["keep", "Never recount (Manually set clues will be kept)"],
        ]) {
            const lb = document.createElement("label");
            lb.className = "dlg-radio dlg-indent";
            const r = document.createElement("input");
            r.type = "radio";
            r.name = "set-recalc";
            r.value = val;
            r.checked = S.clue_recalc === val;
            r.addEventListener("change", () => this._setClueRecalc(val));
            lb.appendChild(r);
            lb.appendChild(document.createTextNode(label));
            f2b.appendChild(lb);
        }
        const lbJ = document.createElement("label");
        lbJ.className = "dlg-radio";
        const cbJ = document.createElement("input");
        cbJ.type = "checkbox";
        cbJ.checked = S.judge_include_hidden;
        cbJ.addEventListener("change", () => this._applyOptions());
        this.optVars.judge_include_hidden = cbJ;
        lbJ.appendChild(cbJ);
        lbJ.appendChild(document.createTextNode("Include fainter/hiden clues when doing determination ①"));
        f2b.appendChild(lbJ);

        // ---- Color Scheme ----
        const f3 = document.createElement("fieldset");
        f3.className = "dlg-fieldset";
        f3.innerHTML = "<legend>Color Scheme for the Current Theme (Click the color block to modify)</legend>";
        box.appendChild(f3);
        const grid = document.createElement("div");
        grid.className = "swatch-grid";
        f3.appendChild(grid);
        this.swatches = {};
        for (const [key, label] of COLOR_KEYS) {
            const lb = document.createElement("label");
            lb.className = "swatch-item";
            const sp = document.createElement("span");
            sp.textContent = label;
            const sw = document.createElement("input");
            sw.type = "color";
            sw.value = S.colors[S.theme][key];
            sw.className = "swatch-color";
            sw.addEventListener("change", () => this._pickColor(key, sw.value, sw));
            lb.appendChild(sp);
            lb.appendChild(sw);
            grid.appendChild(lb);
            this.swatches[key] = sw;
        }
        const btnReset = document.createElement("button");
        btnResetStyle(btnReset);
        btnReset.textContent = "Restore the Default Color Scheme of Current Theme";
        btnReset.addEventListener("click", () => this._resetColors());
        f3.appendChild(btnReset);

        const btnClose = document.createElement("button");
        btnResetStyle(btnClose);
        btnClose.textContent = "Close";
        btnClose.addEventListener("click", () => this._close());
        box.appendChild(btnClose);
        ov.addEventListener("mousedown", (e) => { if (e.target === ov) this._close(); });

        function btnResetStyle(b) { b.className = "dlg-btn"; b.style.margin = "6px auto"; b.style.display = "block"; }
    }

    async _pickColor(key, color, sw) {
        // Color conflict check: prompt when a color is too close to another one
        const conflicts = color_conflicts(key, color);
        if (conflicts.length) {
            const names = Object.fromEntries(COLOR_KEYS);
            const lines = conflicts.map(([other, d]) =>
                ` · ${d < 1 ? "Exactly the same as" : "Very close to"} 「${names[other]}」`);
            if (!await dlgConfirm(
                "Too close colors",
                `After setting this color for 「${names[key]}」:\n    ${lines.join("\n")}\n, these elements may be difficult to distinguish.\nAre you sure to use the settings?`)) {
                sw.value = S.colors[S.theme][key];      // revert the picker
                return;
            }
        }
        S.colors[S.theme][key] = color;
        this._applyOptions();
    }

    _setClueRecalc(policy) {
        S.clue_recalc = policy;
        save_settings();
        const names = { ask: "Always ask when manually set clues are being covered",
                        auto: "Always recount", keep: "Never recount" };
        this.app.status(`Clues : ${names[policy]}.`);
    }

    _resetColors() {
        S.colors[S.theme] = JSON.parse(JSON.stringify(THEMES[S.theme]));
        for (const [key, sw] of Object.entries(this.swatches))
            sw.value = S.colors[S.theme][key];
        this._applyOptions();
    }

    _setTheme(theme) {
        S.theme = theme;
        for (const [key, sw] of Object.entries(this.swatches))
            sw.value = S.colors[theme][key];
        this._applyOptions();
    }

    _applyOptions() {
        for (const [key, cb] of Object.entries(this.optVars)) S[key] = cb.checked;
        save_settings();
        this.app.applyThemeAll();
    }

    _close() {
        this.overlay.remove();
        this.app.settingsDlg = null;
    }
}
