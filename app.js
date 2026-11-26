/* app.js —— Akari Designer · Main Program Layer (Web port of akari_app.py)
 * Main window (Design Mode) and entrance of the web app.
 *   · 2 Design Approaches: Lights First(以灯定数) / Clues First(以数验题)
 *   · Attribute of cells (0/1/2/3/4/No Clue/Not Wall & Hole)
 *   · 「×」 marks (Design aid), Reference cell, Symmetry options,
 *     Flip the Board, Undo (Ctrl+Z), Naming, Automatic file names,
 *     Solvability/Uniqueness determination, Difficulty evaluation,
 *     Dig for Hard!, I/O of .akari files and .png/.bmp graphs, Akari Bank.
 */
"use strict";

class AkariDesignerApp {
    static MAX_DIM = 50;
    static UNDO_CAP = 60;          // max operations that can be undone

    // Cell attributes under 「Clues First」 (the sequence is also that when right-clicking)
    static B_STATES = ["s0", "s1", "s2", "s3", "s4", "swall", "swhite", "shole"];
    static B_LABELS = { s0: "0", s1: "1", s2: "2", s3: "3", s4: "4",
                        swall: "No Clue", swhite: "No Wall", shole: "Hole",
                        slight: "Light", smark: "× Mark" };
    // Difficulties
    static LEVEL_EN = [["NOVICE", "Novice"], ["EASY", "Easy"], ["MEDIUM", "Medium"],
                       ["HARD", "Hard"], ["EXPERT", "Expert"]];

    constructor() {
        load_settings();
        this.drag_op = null;       // operation when dragging (Wall/Un-Wall/Remove/Restore)
        this.last_cell = null;
        this.anchor = null;        // reference cell: base of adding/deleting rows/columns
        this.backup_lights = null;
        this.solveWin = null;      // main Test Mode window (locks the board)
        this.solveWins = [];       // independent Test windows from Akari Bank
        this.settingsDlg = null;
        this.digDlg = null;
        this.digOpen = false;      // digging dialog open (undo disabled, board read-only)
        this.libraryWin = null;
        this.extDirHandle = null;  // File System Access handle of the External Bank
        this._dig_undo = null;     // snapshot of clues before digging
        this._undo_stack = [];     // snapshots before operations
        this.marks = new Set();    // 「×」 marks on the design board (not saved into .akari files)
        this._verified_unique = false;

        this.paradigm = "lights";  // lights=Lights First, walls=Clues First
        this.edit_tool = "wall";

        this._bindToolbar();
        this._buildEditRow();
        this.board = new BoardView(document.getElementById("boardArea"), this);
        this.statusEl = document.getElementById("statusText");
        this.zoomBar = makeZoomBar(() => this.board.zoom, (v) => this.board.set_zoom(v));
        document.getElementById("zoomHost").appendChild(this.zoomBar);
        this.board.onzoom = () => this.zoomBar.refresh();

        this.puzzle = new Puzzle(10, 10);
        this.board.build(this.puzzle);
        this.applyThemeAll();

        document.addEventListener("keydown", (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
                const t = e.target;
                if (t && (t.tagName === "INPUT" && !["checkbox", "radio", "range"].includes(t.type)
                          || t.tagName === "TEXTAREA")) return;   // keep native undo in text fields
                e.preventDefault();
                this.undo();
            }
        });

        this.status("Ready." +
                    "\nClick any cell on the board to record it as 「Reference Cell」, " +
                    "you can operate in「Add/Del Rows/Cols ▾」 based on it." +
                    "\n「Design Approach」 can be switched whenever you like.");
    }

    status(t) { this.statusEl.textContent = t; }

    // ---------------- Toolbar wiring ----------------
    _bindToolbar() {
        const $ = (id) => document.getElementById(id);
        $("btnSettings").addEventListener("click", () => this.open_settings());
        $("btnRebuild").addEventListener("click", () => this.new_puzzle());
        $("paraLights").addEventListener("change", () => this._switch_paradigm("lights"));
        $("paraWalls").addEventListener("change", () => this._switch_paradigm("walls"));
        $("btnSolvable").addEventListener("click", () => this.check_solvable());
        $("btnUnique").addEventListener("click", () => this.check_unique());
        $("btnDifficulty").addEventListener("click", () => this.check_difficulty());
        $("btnDig").addEventListener("click", () => this.open_dig());
        $("btnUndo").addEventListener("click", () => this.undo());
        $("btnUndoDig").addEventListener("click", () => this.undo_dig());
        $("btnClearLights").addEventListener("click", () => this.clear_lights());
        $("btnBackup").addEventListener("click", () => this.open_backup());
        $("btnOpen").addEventListener("click", () => this.open_puzzle());
        $("btnImportImg").addEventListener("click", () => this.import_image());
        $("btnSave").addEventListener("click", () => this.save_puzzle());
        $("btnQuickSave").addEventListener("click", () => this.quick_save_library());
        $("btnLibrary").addEventListener("click", () => this.open_library());
        $("btnTestMode").addEventListener("click", () => this.enter_solve());
        $("fileOpen").addEventListener("change", async (e) => {
            const f = e.target.files[0];
            e.target.value = "";
            if (f) await this._load_content(await f.text(), f.name, { ask_lights: true });
        });
        $("fileImport").addEventListener("change", async (e) => {
            const f = e.target.files[0];
            e.target.value = "";
            if (f) await this._import_image_file(f);
        });

        // ---- Add/Del Rows/Cols menu ----
        this._attachMenu($("btnAddDel"), [
            { label: "Add 1 Row", sub: [
                { label: "Add 1 Row ↑↑", fn: () => this.insert_row(0, "top") },
                { label: "Add 1 Row ↓↓", fn: () => this.insert_row(null, "bottom") },
                { sep: true },
                { label: "Add 1 Row ↑", fn: () => this.insert_row_rel("above") },
                { label: "Add 1 Row ↓", fn: () => this.insert_row_rel("below") },
            ]},
            { label: "Add 1 Col", sub: [
                { label: "Add 1 Col ←←", fn: () => this.insert_col(0, "leftmost") },
                { label: "Add 1 Col →→", fn: () => this.insert_col(null, "rightmost") },
                { sep: true },
                { label: "Add 1 Col ←", fn: () => this.insert_col_rel("left") },
                { label: "Add 1 Col →", fn: () => this.insert_col_rel("right") },
            ]},
            { label: "Del 1 Row", sub: [
                { label: "Del 1 Row ↑↑", fn: () => this.delete_row(0, "top") },
                { label: "Del 1 Row ↓↓", fn: () => this.delete_row(null, "bottom") },
                { sep: true },
                { label: "Del This Row", fn: () => this.delete_row_rel() },
            ]},
            { label: "Del 1 Col", sub: [
                { label: "Del 1 Col ←←", fn: () => this.delete_col(0, "leftmost") },
                { label: "Del 1 Col →→", fn: () => this.delete_col(null, "rightmost") },
                { sep: true },
                { label: "Del This Col", fn: () => this.delete_col_rel() },
            ]},
        ]);
        // ---- Flip the Board menu ----
        this._attachMenu($("btnFlip"), [
            { label: "Flip Horiz. (←→)", fn: () => this.flip_puzzle("h") },
            { label: "Flip Verti. (↑↓)", fn: () => this.flip_puzzle("v") },
            { label: "Rotate 180°", fn: () => this.flip_puzzle("c") },
            { label: "Transpose (Main Diag. \\)", fn: () => this.flip_puzzle("d") },
            { label: "Transpose (Anti-Diag. /)", fn: () => this.flip_puzzle("a") },
        ]);
        // ---- Output Akari Graph menu ----
        this._attachMenu($("btnExportImg"), [
            { label: "(No Lights)", fn: () => this.export_image(false) },
            { label: "(With Lights)", fn: () => this.export_image(true) },
        ]);
    }

    // ---------------- Dropdown menu (one level of submenus) ----------------
    _attachMenu(btn, items) {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            document.querySelectorAll(".menu-pop").forEach(m => m.remove());
            if (btn.disabled) return;
            const pop = document.createElement("div");
            pop.className = "menu-pop";
            const closeAll = () => { pop.remove(); document.removeEventListener("click", onDoc); };
            const onDoc = (ev) => { if (!pop.contains(ev.target)) closeAll(); };
            setTimeout(() => document.addEventListener("click", onDoc), 0);
            const buildInto = (container, list) => {
                for (const it of list) {
                    if (it.sep) {
                        const s = document.createElement("div");
                        s.className = "menu-sep";
                        container.appendChild(s);
                        continue;
                    }
                    const wrap = document.createElement("div");
                    wrap.className = "menu-item-wrap";
                    const b = document.createElement("button");
                    b.className = "menu-item" + (it.sub ? " has-sub" : "");
                    b.textContent = it.label;
                    if (it.sub) {
                        let sub = null;
                        const openSub = () => {
                            if (sub) return;
                            sub = document.createElement("div");
                            sub.className = "menu-sub";
                            buildInto(sub, it.sub);
                            wrap.appendChild(sub);
                        };
                        const closeSub = () => { if (sub) { sub.remove(); sub = null; } };
                        b.addEventListener("click", (ev) => { ev.stopPropagation(); sub ? closeSub() : openSub(); });
                        wrap.addEventListener("mouseenter", openSub);
                        wrap.addEventListener("mouseleave", closeSub);
                    } else {
                        b.addEventListener("click", () => { closeAll(); it.fn(); });
                    }
                    wrap.appendChild(b);
                    container.appendChild(wrap);
                }
            };
            buildInto(pop, items);
            btn.parentElement.appendChild(pop);
        });
    }

    // ---------------- Row 2(Right): Edit tools (change with Design Approach) ----------------
    _buildEditRow() {
        const row = document.getElementById("editRow");
        row.innerHTML = "";
        const mkLbl = (t) => {
            const s = document.createElement("span");
            s.className = "tb-lbl";
            s.textContent = t;
            row.appendChild(s);
        };
        const mkRadio = (text, val) => {
            const lb = document.createElement("label");
            lb.className = "tb-chk lockable";
            const r = document.createElement("input");
            r.type = "radio";
            r.name = "edit-tool";
            r.value = val;
            r.checked = this.edit_tool === val;
            r.addEventListener("change", () => { this.edit_tool = val; });
            lb.appendChild(r);
            lb.appendChild(document.createTextNode(text));
            row.appendChild(lb);
        };
        if (this.paradigm === "lights") {
            mkLbl("Mode:");
            if (!["wall", "mask", "light", "clue", "mark"].includes(this.edit_tool))
                this.edit_tool = "wall";
            for (const [txt, val] of [["Wall", "wall"], ["Hole", "mask"], ["Light", "light"],
                                      ["Clue", "clue"], ["× Mark", "mark"]])
                mkRadio(txt, val);
        } else {
            mkLbl("Attribute:");
            if (![...AkariDesignerApp.B_STATES, "slight", "smark"].includes(this.edit_tool))
                this.edit_tool = "s0";
            for (const val of [...AkariDesignerApp.B_STATES, "slight", "smark"])
                mkRadio(AkariDesignerApp.B_LABELS[val], val);
            const hint = document.createElement("span");
            hint.className = "tb-hint";
            hint.textContent = "(Left-click: Direct Set / Right-click: Switch)";
            row.appendChild(hint);
        }
        this._refresh_lock_ui();
    }

    _switch_paradigm(v) {
        this.paradigm = v;
        this._buildEditRow();
        // Faded clues under 「Clues First」 still exist
        this.board.show_inactive = (v === "walls");
        this._redraw();
        if (v === "walls") {
            const hidden = [...this.puzzle.clue_active.values()].filter(x => !x).length;
            let tip = "「Clues First」 Approach: Directly put walls and set their attributes!" +
                      "\nClues are not counted by lights; putting lights is only for testing.";
            if (hidden)
                tip += ` CAUTION: ${hidden} fainter clues showed in paler color,` +
                       "\nwhich cannot be involved in the determination ① and ②!" +
                       "\nYou can right-click to explicitly show them.";
            this.status(tip);
        } else {
            let tip = "「Lights First」 Approach: Put lights to automatically generate or update clues!" +
                      "\nYou can use 「Dig for hard!」 to reduce clues.";
            if (this._clues_diverge())
                tip += " CAUTION:Current clues not matched with the lights!" +
                       "\nYou can set how Clues update when putting lights or removing a cell" +
                       "\nat「⚙ Settings → Clues Recounting and Effect」.";
            this.status(tip);
        }
    }

    // ---------------- 「Modifying Lock」 of Test Mode ----------------
    _solving() { return this.solveWin !== null; }

    _refresh_lock_ui() {
        /* Switch of Test Mode: only disable 「Puzzle Modifying」 widgets. */
        const locked = this._solving();
        document.querySelectorAll(".lockable").forEach(el => {
            if (el.tagName === "INPUT" || el.tagName === "BUTTON") el.disabled = locked;
            else el.querySelectorAll("input,button").forEach(x => { x.disabled = locked; });
        });
        let title = `Akari Designer —— v${APP_VERSION} —— Design Mode (by Acxis_Official)`;
        if (locked) title += "(In Test Mode: Board Protected)";
        document.title = title;
    }
    _set_edit_lock(locked) {
        // locked=true is called by the Test Mode window itself; false by exit_solve
        this._refresh_lock_ui();
    }

    _edit_locked(action = "This function") {
        if (this._solving()) {
            this.status(`In Test Mode(Board protected): ${action} is not avaiable!`);
            bell();
            return true;
        }
        return false;
    }

    // ---------------- Reference cell ----------------
    _set_anchor(cell) {
        if (JSON.stringify(cell) !== JSON.stringify(this.anchor)) {
            this.anchor = cell;
            this.board.set_anchor(cell);
            if (cell !== null)
                this.status(`Reference cell: (${cell[0] + 1},${cell[1] + 1}). ` +
                            "You can operate based on it at 「Add/Del Rows/Cols ▾」.");
        }
    }

    // ---------------- Add Rows/Cols ----------------
    insert_row(idx, label) {
        if (this._edit_locked("Add/Del Rows/Cols")) return;
        const p = this.puzzle;
        if (p.rows >= AkariDesignerApp.MAX_DIM) {
            this.status(`No more than ${AkariDesignerApp.MAX_DIM} rows!`);
            bell();
            return;
        }
        if (idx === null) idx = p.rows;
        this._push_undo("Add 1 Row");
        p.grid.splice(idx, 0, new Array(p.cols).fill(WHITE));
        p.rows++;
        p.clues = new Map([...p.clues].map(([k, v]) => { const [r, c] = unRC(k); return [RC(r + (r >= idx), c), v]; }));
        p.clue_active = new Map([...p.clue_active].map(([k, v]) => { const [r, c] = unRC(k); return [RC(r + (r >= idx), c), v]; }));
        p.lights = new Set([...p.lights].map(k => { const [r, c] = unRC(k); return RC(r + (r >= idx), c); }));
        this._shift_marks((r, c) => [r + (r >= idx), c]);
        if (this.anchor && this.anchor[0] >= idx) this.anchor = [this.anchor[0] + 1, this.anchor[1]];
        this._mark_unverified();
        this._after_resize();
        this.status(`Added 1 row at ${label} (${p.rows} × ${p.cols} now).`);
    }

    insert_col(idx, label) {
        if (this._edit_locked("Add/Del Rows/Cols")) return;
        const p = this.puzzle;
        if (p.cols >= AkariDesignerApp.MAX_DIM) {
            this.status(`No more than ${AkariDesignerApp.MAX_DIM} columns!`);
            bell();
            return;
        }
        if (idx === null) idx = p.cols;
        this._push_undo("Add 1 Column");
        for (const row of p.grid) row.splice(idx, 0, WHITE);
        p.cols++;
        p.clues = new Map([...p.clues].map(([k, v]) => { const [r, c] = unRC(k); return [RC(r, c + (c >= idx)), v]; }));
        p.clue_active = new Map([...p.clue_active].map(([k, v]) => { const [r, c] = unRC(k); return [RC(r, c + (c >= idx)), v]; }));
        p.lights = new Set([...p.lights].map(k => { const [r, c] = unRC(k); return RC(r, c + (c >= idx)); }));
        this._shift_marks((r, c) => [r, c + (c >= idx)]);
        if (this.anchor && this.anchor[1] >= idx) this.anchor = [this.anchor[0], this.anchor[1] + 1];
        this._mark_unverified();
        this._after_resize();
        this.status(`Added 1 column at ${label} (${p.rows} × ${p.cols} now).`);
    }

    // ---------------- Delete Rows/Cols ----------------
    delete_row(idx, label) {
        if (this._edit_locked("Add/Del Rows/Cols")) return;
        const p = this.puzzle;
        if (p.rows <= 2) {
            this.status("Please remain at least 2 rows. Cannot delete!");
            bell();
            return;
        }
        if (idx === null) idx = p.rows - 1;
        this._push_undo("Del 1 Row");
        p.grid.splice(idx, 1);
        p.rows--;
        const remap = (k) => { const [r, c] = unRC(k); return r === idx ? null : RC(r - (r > idx), c); };
        p.clues = new Map([...p.clues].map(([k, v]) => [remap(k), v]).filter(([k]) => k !== null));
        p.clue_active = new Map([...p.clue_active].map(([k, v]) => [remap(k), v]).filter(([k]) => k !== null));
        p.lights = new Set([...p.lights].map(remap).filter(k => k !== null));
        this._shift_marks((r, c) => r === idx ? null : [r - (r > idx), c]);
        if (this.anchor) {
            if (this.anchor[0] === idx) this.anchor = null;
            else if (this.anchor[0] > idx) this.anchor = [this.anchor[0] - 1, this.anchor[1]];
        }
        this._mark_unverified();
        this._after_resize();
        this.status(`Deleted 1 row at ${label} (${p.rows} × ${p.cols} now).`);
    }

    delete_col(idx, label) {
        if (this._edit_locked("Add/Del Rows/Cols")) return;
        const p = this.puzzle;
        if (p.cols <= 2) {
            this.status("Please remain at least 2 columns. Cannot delete!");
            bell();
            return;
        }
        if (idx === null) idx = p.cols - 1;
        this._push_undo("Del 1 Column");
        for (const row of p.grid) row.splice(idx, 1);
        p.cols--;
        const remap = (k) => { const [r, c] = unRC(k); return c === idx ? null : RC(r, c - (c > idx)); };
        p.clues = new Map([...p.clues].map(([k, v]) => [remap(k), v]).filter(([k]) => k !== null));
        p.clue_active = new Map([...p.clue_active].map(([k, v]) => [remap(k), v]).filter(([k]) => k !== null));
        p.lights = new Set([...p.lights].map(remap).filter(k => k !== null));
        this._shift_marks((r, c) => c === idx ? null : [r, c - (c > idx)]);
        if (this.anchor) {
            if (this.anchor[1] === idx) this.anchor = null;
            else if (this.anchor[1] > idx) this.anchor = [this.anchor[0], this.anchor[1] - 1];
        }
        this._mark_unverified();
        this._after_resize();
        this.status(`Deleted 1 column at ${label} (${p.rows} × ${p.cols} now).`);
    }

    insert_row_rel(where) {
        if (this.anchor === null) { this._need_anchor(); return; }
        const idx = where === "above" ? this.anchor[0] : this.anchor[0] + 1;
        this.insert_row(idx, `${where === "above" ? "above" : "below"} the reference cell`);
    }
    insert_col_rel(where) {
        if (this.anchor === null) { this._need_anchor(); return; }
        const idx = where === "left" ? this.anchor[1] : this.anchor[1] + 1;
        this.insert_col(idx, `on the ${where === "left" ? "left of" : "right of"} the reference cell`);
    }
    delete_row_rel() {
        if (this.anchor === null) { this._need_anchor(); return; }
        this.delete_row(this.anchor[0], "the reference cell");
    }
    delete_col_rel() {
        if (this.anchor === null) { this._need_anchor(); return; }
        this.delete_col(this.anchor[1], "the reference cell");
    }
    _need_anchor() {
        this.status("Please select a 「Reference Cell」 first!");
        bell();
    }

    _after_resize() {
        const p = this.puzzle;
        this.board.build(p);
        this.board.set_anchor(this.anchor);
        document.getElementById("inpRows").value = p.rows;
        document.getElementById("inpCols").value = p.cols;
        this.zoomBar.refresh();
    }

    _redraw() { this.board.redraw({ marks: this.marks }); }

    _shift_marks(f) {
        /* Move the 「×」 marks along with row/column inserting/deleting:
         * f maps an old coordinate to a new one (null = the mark disappears). */
        const nw = new Set();
        for (const k of this.marks) {
            const tgt = f(...unRC(k));
            if (tgt !== null) nw.add(RC(...tgt));
        }
        this.marks = nw;
    }

    // ---------------- Flip the Board ----------------
    static FLIP_OPS = {
        h: ["Flip Horiz.", (r, c, R, C) => [r, C - 1 - c]],
        v: ["Flip Verti.", (r, c, R, C) => [R - 1 - r, c]],
        c: ["Rotate 180°", (r, c, R, C) => [R - 1 - r, C - 1 - c]],
        d: ["Transpose (Main Diag.)", (r, c, R, C) => [c, r]],
        a: ["Transpose (Anti-Diag.)", (r, c, R, C) => [C - 1 - c, R - 1 - r]],
    };

    flip_puzzle(kind) {
        /* Flip/Transpose the whole puzzle: cell types, clues (with their
         * valid states), lights, 「×」 marks and the reference cell are all
         * transformed together. Undoable by 「↩ Undo (Ctrl+Z)」. */
        if (this._edit_locked("Flip the Board")) return;
        const [label, f] = AkariDesignerApp.FLIP_OPS[kind];
        const p = this.puzzle;
        const R = p.rows, Cn = p.cols;
        const [nR, nC] = (kind === "d" || kind === "a") ? [Cn, R] : [R, Cn];
        this._push_undo(label);
        const q = new Puzzle(nR, nC);
        for (let r = 0; r < R; r++)
            for (let c = 0; c < Cn; c++) {
                const [rr, cc] = f(r, c, R, Cn);
                q.grid[rr][cc] = p.grid[r][c];
            }
        const mapKey = (k) => { const [r, c] = unRC(k); return RC(...f(r, c, R, Cn)); };
        q.clues = new Map([...p.clues].map(([k, v]) => [mapKey(k), v]));
        q.clue_active = new Map([...p.clue_active].map(([k, v]) => [mapKey(k), v]));
        q.lights = new Set([...p.lights].map(mapKey));
        this.puzzle = q;
        this.marks = new Set([...this.marks].map(mapKey));
        if (this.anchor !== null) this.anchor = f(this.anchor[0], this.anchor[1], R, Cn);
        this._mark_unverified();
        this._after_resize();
        this._redraw();
        this.status(`${label} completed (${nR} × ${nC} now).`);
    }

    // ---------------- Undo (Ctrl+Z) ----------------
    _snapshot() {
        const p = this.puzzle;
        return { rows: p.rows, cols: p.cols,
                 grid: p.grid.map(row => row.slice()),
                 clues: new Map(p.clues),
                 clue_active: new Map(p.clue_active),
                 lights: new Set(p.lights),
                 marks: new Set(this.marks),
                 name: document.getElementById("inpName").value,
                 anchor: this.anchor ? [...this.anchor] : null,
                 verified: this._verified_unique };
    }
    _push_undo(label) {
        /* Save a snapshot BEFORE an operation. Call it at the beginning of
         * every 「Puzzle Modifying」 operation (after all the guards that may
         * cancel the operation). */
        this._undo_stack.push([label, this._snapshot()]);
        if (this._undo_stack.length > AkariDesignerApp.UNDO_CAP) this._undo_stack.shift();
    }
    undo() {
        if (this.digOpen) { bell(); return; }   // board data is read-only for the digging worker
        if (this._edit_locked("Undo")) return;
        if (!this._undo_stack.length) {
            this.status("Nothing can be undone!");
            bell();
            return;
        }
        const [label, snap] = this._undo_stack.pop();
        const p = new Puzzle(snap.rows, snap.cols);
        p.grid = snap.grid.map(row => row.slice());
        p.clues = new Map(snap.clues);
        p.clue_active = new Map(snap.clue_active);
        p.lights = new Set(snap.lights);
        this.puzzle = p;
        this.marks = new Set(snap.marks);
        document.getElementById("inpName").value = snap.name;
        this.anchor = snap.anchor;
        this._verified_unique = snap.verified;
        this._after_resize();
        this._redraw();
        const left = this._undo_stack.length;
        this.status(`Undone: ${label}.` +
                    (left ? ` (${left} more operations can be undone)` : " (No more operations can be undone)"));
    }
}

// ============================================================
// AkariDesignerApp —— Part 2: Board Interaction & Editing
// ============================================================

Object.assign(AkariDesignerApp.prototype, {

    // ---------------- Canvas events under Design Mode (BoardView handler interface) ----------------
    canvas_press(cell, e) {
        if (cell === null) return;
        if (this._edit_locked("Edit the Board")) return;
        this._set_anchor(cell);
        if (this.paradigm === "walls") { this._press_walls(cell); return; }
        const mode = this.edit_tool;
        const p = this.puzzle;
        const [r, c] = cell;
        if (mode === "wall") {
            if (p.grid[r][c] === OUTSIDE) return;
            // Drag from a wall cell = Wipe out a wall; from a not wall cell = Draw a wall
            this._push_undo("Paint/Wipe Walls");
            this.drag_op = p.grid[r][c] === WALL ? WHITE : WALL;
            this._apply_wall(cell);
            this.last_cell = cell;
        } else if (mode === "mask") {
            this._push_undo("Dig/Fill Holes");
            this.drag_op = p.grid[r][c] !== OUTSIDE ? OUTSIDE : WHITE;
            this._apply_mask(cell);
            this.last_cell = cell;
        } else if (mode === "light") {
            this._toggle_light(cell);
        } else if (mode === "clue") {
            this._toggle_clue(cell);
        } else if (mode === "mark") {
            this._toggle_mark(cell);
        }
    },

    canvas_drag(cell, e) {
        if (this.drag_op === null || this.last_cell === null || cell === null) return;
        if (this._solving()) return;         // another insurance
        if (cell[0] === this.last_cell[0] && cell[1] === this.last_cell[1]) return;
        for (const cc of BoardView.line_cells(this.last_cell, cell)) {
            if (this.edit_tool === "wall") this._apply_wall(cc);
            else if (this.edit_tool === "mask") this._apply_mask(cc);
        }
        this.last_cell = cell;
    },

    canvas_release(cell, e) {
        this.drag_op = null;
        this.last_cell = null;
    },

    canvas_right(cell, e) {
        /* Clues First: switch the attribute of the cell;
         * Clues First → × Mark / Lights First → × Mark: put/remove a 「×」 mark;
         * Lights First → Wall: remove the wall at the cell;
         * Lights First → Hole: remove the hole at the cell. */
        if (cell === null) return;
        if (this._edit_locked("Edit the Board")) return;
        this._set_anchor(cell);
        const p = this.puzzle;
        const [r, c] = cell;
        if (this.paradigm === "walls") {
            const tool = this.edit_tool;
            if (tool === "slight") return;   // right-click does nothing when putting lights
            if (tool === "smark") { this._toggle_mark(cell); return; }
            const pre = this._cell_state(r, c);
            const B = AkariDesignerApp.B_STATES;
            const nxt = B[(B.indexOf(pre) + 1) % B.length];
            this._push_undo("Switch the Attribute");
            for (const rc of this._sym_targets(cell, pre)) this._apply_state(rc, nxt);
            this._mark_unverified();
            this._redraw();
            this.status(`Attribute of (${r + 1},${c + 1}) has been switch to 「${AkariDesignerApp.B_LABELS[nxt]}」.`);
            return;
        }
        if (this.edit_tool === "mark") {
            this._toggle_mark(cell);
        } else if (this.edit_tool === "wall" && p.grid[r][c] === WALL) {
            this._push_undo("Wipe a Wall");
            this.drag_op = WHITE;
            this._apply_wall(cell);
            this.drag_op = null;
        } else if (this.edit_tool === "mask" && p.grid[r][c] === OUTSIDE) {
            this._push_undo("Fill a Hole");
            this.drag_op = WHITE;
            this._apply_mask(cell);
            this.drag_op = null;
        }
    },

    // ---------------- Cell Attributes (Clues First) ----------------
    _cell_state(r, c) {
        /* Attribute string of cells: s0~s4 / swall / swhite / shole. */
        const p = this.puzzle;
        const t = p.grid[r][c];
        if (t === OUTSIDE) return "shole";
        if (t === WALL) return p.clues.has(RC(r, c)) ? `s${p.clues.get(RC(r, c))}` : "swall";
        return "swhite";
    },

    _apply_state(cell, state) {
        /* Set the attribute of one cell (symmetry processing not included). */
        const p = this.puzzle;
        const [r, c] = cell;
        const key = RC(r, c);
        if (state === "shole") p.grid[r][c] = OUTSIDE;
        else if (state === "swhite") p.grid[r][c] = WHITE;
        else p.grid[r][c] = WALL;
        if (["shole", "swhite", "swall"].includes(state)) {
            p.clues.delete(key);
            p.clue_active.delete(key);
        } else {                             // s0~s4: walls with clues
            p.clues.set(key, parseInt(state[1]));
            p.clue_active.set(key, true);
        }
        if (p.grid[r][c] !== WHITE) p.lights.delete(key);
    },

    _press_walls(cell) {
        /* Left-click under 「Clues First」: set the attribute of the cell. */
        const tool = this.edit_tool;
        if (tool === "slight") { this._toggle_light(cell); return; }
        if (tool === "smark") { this._toggle_mark(cell); return; }
        const pre = this._cell_state(...cell);
        if (pre === tool) return;            // no change, no undo record either
        this._push_undo("Set the Attribute");
        for (const rc of this._sym_targets(cell, pre)) this._apply_state(rc, tool);
        this._mark_unverified();
        this._redraw();
    },

    // ---------------- Symmetry ----------------
    _sym_cells(r, c) {
        /* The symmetric cell set of (r, c) under the checked symmetry options.
         * Diagonal symmetries only add the cells that are still inside the
         * board (may be absent when rows ≠ columns). */
        const p = this.puzzle;
        const cells = new Map();
        const add = (rr, cc) => cells.set(RC(rr, cc), [rr, cc]);
        add(r, c);
        if (document.getElementById("symH").checked) add(r, p.cols - 1 - c);
        if (document.getElementById("symV").checked) add(p.rows - 1 - r, c);
        if (document.getElementById("symC").checked) add(p.rows - 1 - r, p.cols - 1 - c);
        if (document.getElementById("symD").checked && c < p.rows && r < p.cols) add(c, r);  // Main Diagonal (\)
        if (document.getElementById("symA").checked) {
            const rr = p.cols - 1 - c, cc = p.rows - 1 - r;
            if (rr >= 0 && rr < p.rows && cc >= 0 && cc < p.cols) add(rr, cc);                // Anti-Diagonal (/)
        }
        return [...cells.values()];
    },

    _sym_targets(cell, pre_state) {
        /* The actually effective cell set of this operation: the cell itself &
         * the symmetric cell (if its current state remains consistent with
         * that before the cell was modified). */
        return this._sym_cells(...cell).filter(rc =>
            (rc[0] === cell[0] && rc[1] === cell[1]) || this._cell_state(...rc) === pre_state);
    },

    // ---------------- Edit Operations (Lights First) ----------------
    _apply_wall(cell) {
        const p = this.puzzle;
        const pre = this._cell_state(...cell);
        for (const [r, c] of this._sym_targets(cell, pre)) {
            const key = RC(r, c);
            if (p.grid[r][c] === OUTSIDE) continue;     // holes cannot be walls
            if (this.drag_op === WALL) {
                p.grid[r][c] = WALL;
                p.lights.delete(key);
                this._update_clue(r, c);
            } else {
                p.grid[r][c] = WHITE;
                p.clues.delete(key);
                p.clue_active.delete(key);
                this._update_neighbors_clue(r, c);
            }
        }
        this._mark_unverified();
        this._redraw();
    },

    _apply_mask(cell) {
        const p = this.puzzle;
        const pre = this._cell_state(...cell);
        for (const [r, c] of this._sym_targets(cell, pre)) {
            const key = RC(r, c);
            if (this.drag_op === OUTSIDE) {
                p.grid[r][c] = OUTSIDE;
                p.lights.delete(key);
                p.clues.delete(key);
                p.clue_active.delete(key);
            } else {
                p.grid[r][c] = WHITE;
            }
            this._update_neighbors_clue(r, c);
        }
        this._mark_unverified();
        this._redraw();
    },

    async _toggle_light(cell) {
        /* Put/Remove lights (usable under both Design Approaches; does not
         * update clues under 「Clues First」). */
        const p = this.puzzle;
        const [r, c] = cell;
        const key = RC(r, c);
        if (p.grid[r][c] !== WHITE) return;
        const pre = p.lights.has(key);
        if (!pre && (p.lit_info().get(key) || 0) > 0) {
            // Checked BEFORE any modification, so a conflict never leaves half-modified symmetric cells
            this.status("This cell is already illuminated!");
            this.board.flash_conflict(cell);
            bell();
            return;
        }
        const targets = this._sym_cells(r, c).filter(rc =>
            (rc[0] === r && rc[1] === c) || (p.lights.has(RC(...rc)) === pre));
        this._push_undo("Put/Remove Lights");
        for (const rc of targets) {
            const [rr, cc] = rc;
            const k2 = RC(rr, cc);
            if (p.grid[rr][cc] !== WHITE) continue;
            if (pre) p.lights.delete(k2);
            else {
                if ((p.lit_info().get(k2) || 0) > 0) continue;   // silently skip on conflict at symmetric cell
                p.lights.add(k2);
            }
        }
        if (this.paradigm === "lights") await this._auto_update_clues();
        this._mark_unverified();
        this._redraw();
    },

    _toggle_mark(cell) {
        /* Put/Remove 「×」 marks on Not Wall cells without lights
         * (Design aid; symmetric operation included; not saved into .akari files). */
        const p = this.puzzle;
        const [r, c] = cell;
        const key = RC(r, c);
        if (p.grid[r][c] !== WHITE || p.lights.has(key)) return;
        const pre = this.marks.has(key);
        const targets = this._sym_cells(r, c).filter(rc => {
            const k2 = RC(...rc);
            return (rc[0] === r && rc[1] === c) ||
                   (p.grid[rc[0]][rc[1]] === WHITE && !p.lights.has(k2) && (this.marks.has(k2) === pre));
        });
        if (!targets.length) return;
        this._push_undo("Mark 「×」");
        for (const rc of targets) {
            const k2 = RC(...rc);
            if (pre) this.marks.delete(k2);
            else this.marks.add(k2);
        }
        this.status(`「×」 @(${r + 1},${c + 1}) ${pre ? "removed" : "marked"}` +
                    `(${targets.length} in total including symmetric ones).`);
        this._redraw();
    },

    _toggle_clue(cell) {
        /* Clue mode under 「Lights First」: whether they are given.
         * Normal = Given; Fainter = Not given. Symmetric operation included. */
        const p = this.puzzle;
        const [r, c] = cell;
        const key = RC(r, c);
        if (p.grid[r][c] === WALL && p.clues.has(key)) {
            const pre = p.clue_active.get(key) !== false;
            const targets = this._sym_cells(r, c).filter(rc => {
                const k2 = RC(...rc);
                return (rc[0] === r && rc[1] === c) ||
                       (p.grid[rc[0]][rc[1]] === WALL && p.clues.has(k2)
                        && (p.clue_active.get(k2) !== false) === pre);
            });
            this._push_undo("Give/Remove a Clue");
            for (const rc of targets) p.clue_active.set(RC(...rc), !pre);
            const state = !pre ? "restored" : "removed(Fainter) (Click again to restore)";
            this.status(`Clue ${p.clues.get(key)} @(${r + 1},${c + 1}) ${state}` +
                        `(${targets.length} in total including symmetric ones).`);
            this._mark_unverified();
            this._redraw();
        }
    },

    // ---------------- Clues Maintenance ----------------
    _clue_of(r, c) {
        const p = this.puzzle;
        let n = 0;
        for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const rr = r + dr, cc = c + dc;
            if (rr >= 0 && rr < p.rows && cc >= 0 && cc < p.cols && p.lights.has(RC(rr, cc))) n++;
        }
        return n;
    },
    _update_clue(r, c) {
        const p = this.puzzle;
        if (p.grid[r][c] === WALL) {
            p.clues.set(RC(r, c), this._clue_of(r, c));
            if (!p.clue_active.has(RC(r, c))) p.clue_active.set(RC(r, c), true);
        }
    },
    _update_neighbors_clue(r, c) {
        const p = this.puzzle;
        for (const [dr, dc] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const rr = r + dr, cc = c + dc;
            if (rr >= 0 && rr < p.rows && cc >= 0 && cc < p.cols) this._update_clue(rr, cc);
        }
    },
    _update_all_clues() {
        const p = this.puzzle;
        for (let r = 0; r < p.rows; r++)
            for (let c = 0; c < p.cols; c++)
                if (p.grid[r][c] === WALL) {
                    p.clues.set(RC(r, c), this._clue_of(r, c));
                    if (!p.clue_active.has(RC(r, c))) p.clue_active.set(RC(r, c), true);
                }
    },

    _clues_diverge() {
        /* Whether current clues are inconsistent with lights. */
        const p = this.puzzle;
        for (let r = 0; r < p.rows; r++)
            for (let c = 0; c < p.cols; c++)
                if (p.grid[r][c] === WALL && p.clues.get(RC(r, c)) !== this._clue_of(r, c))
                    return true;
        return false;
    },

    async _auto_update_clues() {
        /* Recounting strategy under 「Lights First」:
         * ask (default) / auto / keep. Return whether recounting is executed. */
        const policy = S.clue_recalc || "ask";
        if (policy === "keep") {
            this.status("Manually set clues kept (No auto recount).\n" +
                        "You can set recounting strategy at 「⚙ Settings → Clues Recounting and Effect」).");
            return false;
        }
        if (policy === "ask" && this._clues_diverge()) {
            const yes = await dlgConfirm(
                "Clues Recounting",
                "Under rules of 「Lights First」, all clues should be recount.\n" +
                "Recounting may cover your clue settings.\n\n" +
                "Continue?\n" +
                "「Yes」Recount & Cover　「No」Keep\n" +
                "(You can set recounting strategy at 「⚙ Settings → Clues Recounting and Effect」)");
            if (!yes) {
                this.status("Manually set clues kept (No auto recount).");
                return false;
            }
        }
        this._update_all_clues();
        return true;
    },

    _mark_unverified() { this._verified_unique = false; },

    async clear_lights() {
        if (this._edit_locked("Clear All Lights")) return;
        if (!this.puzzle.lights.size) {
            this.status("No lights to clear!");
            bell();
            return;
        }
        this._push_undo("Clear All Lights");
        this.puzzle.lights.clear();
        if (this.paradigm === "lights") await this._auto_update_clues();
        this._mark_unverified();
        this._redraw();
        this.status("All Lights Cleared!");
    },

    async new_puzzle() {
        if (this._edit_locked("Rebuild the Board")) return;
        const R = parseInt(document.getElementById("inpRows").value);
        const Cn = parseInt(document.getElementById("inpCols").value);
        if (isNaN(R) || isNaN(Cn)) {
            await dlgAlert("Input Error", "The number of rows and columns must be integers!");
            return;
        }
        if (!(R >= 2 && R <= AkariDesignerApp.MAX_DIM && Cn >= 2 && Cn <= AkariDesignerApp.MAX_DIM)) {
            await dlgAlert("Input Error",
                           `The number of rows and columns must be between 2 and ${AkariDesignerApp.MAX_DIM}(Inclusive)!`);
            return;
        }
        if (!await dlgConfirm("Confirm", "ALL ELEMENTS will be cleared after rebuilding the board, Continue?"))
            return;
        this._push_undo("Rebuild the Board");
        this.puzzle = new Puzzle(R, Cn);
        this.anchor = null;
        this.backup_lights = null;
        this._dig_undo = null;
        this._verified_unique = false;
        this.marks.clear();
        document.getElementById("inpName").value = "";
        this.board.set_anchor(null);
        this.board.build(this.puzzle);
        this._redraw();
        this.status(`Void board of ${R} × ${Cn} is rebuilt! Please choose the Design Approach and start designing.`);
    },
});

// ============================================================
// AkariDesignerApp —— Part 3: Determinations ①②③
// ============================================================

Object.assign(AkariDesignerApp.prototype, {

    _judged_puzzle() {
        /* Construct puzzle for determination: consider valid clues; whether to
         * consider fainter(hidden) clues depends on settings.
         * Return [tmp, active_n, hidden_n, hidden_used]. */
        const p = this.puzzle;
        const includeHidden = !!S.judge_include_hidden;
        const tmp = new Puzzle(p.rows, p.cols);
        tmp.grid = p.grid.map(row => row.slice());
        let activeN = 0, hiddenN = 0;
        for (const [key, k] of p.clues) {
            const [r, c] = unRC(key);
            if (p.grid[r][c] !== WALL) continue;
            if (p.clue_active.get(key) !== false) activeN++;
            else {
                hiddenN++;
                if (!includeHidden) continue;      // hidden clues are not included
            }
            tmp.clues.set(key, k);
            tmp.clue_active.set(key, true);
        }
        return [tmp, activeN, hiddenN, includeHidden];
    },

    async check_solvable() {
        const p = this.puzzle;
        const w = p.white_count();
        if (!w) {
            await dlgAlert("Cannot Determine", "No valid 「Not Wall」 cells!");
            return;
        }
        if (w > 300 && !await dlgConfirm("Scale Prompt",
                `${w} 「Not Wall」 cells currently. Determination may last long, continue?`))
            return;

        const [tmp, activeN, hiddenN, hiddenUsed] = this._judged_puzzle();
        // Explicit statement of clues effect
        let clueNote = `${activeN} valid clues considered in this determination`;
        if (hiddenN) {
            if (hiddenUsed)
                clueNote += `. ${hiddenN} fainter/hiden clues considered additionally (Checked in settings to consider).`;
            else
                clueNote += `; ${hiddenN} other fainter/hiden clues not considered.` +
                            "\nYou can change this setting in 「⚙ Settings → Clues Recounting and Effect」.";
        } else clueNote += "; no fainter/hiden clues.";

        this.status(`Solvability determinating (${activeN + (hiddenUsed ? hiddenN : 0)} clues considered)...`);

        // (1) Existence: consider walls together with clues
        const res1 = await runTask("count", { puzzle: tmp.to_dict(), use_clues: true, limit: 2 });
        const sols = res1.sols.map(sol => new Set(sol.map(([r, c]) => RC(r, c))));
        const aborted = res1.aborted;
        if (aborted && !sols.length) {
            this.status("Determination ①: Too large scale, cannot determine in time limit!");
            await dlgAlert("Solvability Determination",
                           "Too large searching scale, cannot determine!\nYou can downsize the board or add clues.\n\n" + clueNote);
            return;
        }
        if (!sols.length) {
            // Diagnosis: is the cause of NO SOLUTION related to clues or just to the walls
            const res0 = await runTask("count", { puzzle: p.to_dict(), use_clues: false, limit: 1 });
            this.status("Determination ①:NO SOLUTION ✘ (Under current walls and clues)");
            const msg = res0.sols.length
                ? "NO SOLUTION ✘:\n      There exists some feasible light positions only regarding the walls.\n      But they will all go wrong under current clues!\n      Please change some clues or walls before determinating again."
                : "NO SOLUTION ✘:\n      There does not exist any feasible light positions even only regarding the walls!\n      Please change some walls before determinating again.";
            await dlgAlert("Solvability Determination", msg + "\n\n" + clueNote);
            return;
        }
        let S_ = sols[0];
        this.backup_lights = S_;

        // (2) Uniqueness: consider clues and the walls
        let uniqMsg;
        if (aborted) {
            uniqMsg = "Uniqueness Determination: Too large scale, cannot determine!";
        } else if (sols.length >= 2) {
            uniqMsg = "MULTIPLE SOLUTIONS for considered clues ✔✘!\nAnother solution has been showed for backup configuration.";
            const cur = new Set(p.lights);
            const same = (a, b) => a.size === b.size && [...a].every(x => b.has(x));
            const alt = same(cur, sols[0]) ? sols[1] : sols[0];
            S_ = alt;
            this.backup_lights = alt;
        } else {
            uniqMsg = "UNIQUE SOLUTION for considered clues ✔✔!";
        }

        // (3) Uniqueness only considering the walls
        const res2 = await runTask("count", { puzzle: p.to_dict(), use_clues: false, limit: 2 });
        let inherent;
        if (res2.aborted && res2.sols.length < 2)
            inherent = "Uniqueness Determination (Only considering the walls): Too large scale, cannot determine!";
        else if (res2.sols.length >= 2)
            inherent = "MULTIPLE SOLUTIONS when only considering the walls ✔✘!";
        else
            inherent = "UNIQUE SOLUTION even when only considering the walls ✔✔!";

        this._show_backup(S_, "Backup Configuration (Another solution found by Determination ①)");
        this.status("Determination ① completed:" + uniqMsg.replace(/\n/g, " "));
        await dlgAlert("Solvability Determination",
                       `Feasible light positions exist ✔! (${S_.size} lights in total, showed as backup configuation)\n\n${uniqMsg}\n\n${inherent}\n\n${clueNote}`);
    },

    // ---------------- Determination ②: Uniqueness (NO/UNIQUE/MULTIPLE SOLUTIONS) ----------------
    async check_unique() {
        const p = this.puzzle;
        const [tmp, active, hiddenN, hiddenUsed] = this._judged_puzzle();
        let hiddenNote = "";
        if (hiddenN)
            hiddenNote = hiddenUsed ? ` (${hiddenN} fainter clues considered additionally)`
                                    : ` (${hiddenN} fainter clues not considered)`;
        const w = p.white_count();
        if (w > 300 && !await dlgConfirm("Scale Prompt",
                `${w} Not Wall cells currently (${active + (hiddenUsed ? hiddenN : 0)} clues considered ${hiddenNote}),` +
                "The time complexity of Uniqueness Determination is an exponential function of the number of Not Wall cells." +
                "The determination may last long. Continue?"))
            return;
        this.status(`Determinating uniqueness with ${active + (hiddenUsed ? hiddenN : 0)} clues${hiddenNote}, please wait...`);

        const res = await runTask("count", { puzzle: tmp.to_dict(), use_clues: true, limit: 2 });
        const sols = res.sols.map(sol => new Set(sol.map(([r, c]) => RC(r, c))));
        const aborted = res.aborted;
        if (aborted && !sols.length) {
            this.status("Determination ②: Too large scale, cannot determine in time limit!");
            await dlgAlert("Uniqueness Determination",
                           "Too large searching scale, cannot determine!\nYou can downsize the board or add clues.");
            return;
        }
        if (!sols.length) {
            this._verified_unique = false;
            this.status("Determination ②: NO SOLUTION ✘ - Cannot meet all Akari rules wherever lights are set.");
            await dlgAlert("Uniqueness Determination",
                           "NO SOLUTION ✘:\nCannot meet all Akari rules wherever lights are set under current walls and clues.\n");
            return;
        }
        const same = (a, b) => a.size === b.size && [...a].every(x => b.has(x));
        if (sols.length === 1) {
            const S_ = sols[0];
            this._verified_unique = true;
            let msg;
            if (same(new Set(p.lights), S_)) {
                msg = "UNIQUE SOLUTION ✔✔!\nCurrent light positions are just the solution!";
            } else if (this._user_board_complete()) {
                msg = "UNIQUE SOLUTION ✔✔!\nCurrent light positions are not the solution!\nThe solution has been showed in an independent window.";
                this._show_backup(S_, "The UNIQUE SOLUTION");
            } else {
                msg = "UNIQUE SOLUTION under current clues ✔✔!\nYou can continue putting lights.";
            }
            this.status("Determination ②:" + msg.replace(/\n/g, " "));
            await dlgAlert("Uniqueness Determination", msg);
            return;
        }

        this._verified_unique = false;
        const alt = !same(new Set(p.lights), sols[0]) ? sols[0] : sols[1];
        this._show_backup(alt, "Another Solution");
        this.status("Determination ②: MULTIPLE SOLUTIONS ✔✘ - Another solution must exist however lights are put.");
        await dlgAlert("Uniqueness Determination",
                       "MULTIPLE SOLUTIONS ✔✘!\nThere must exist another solution under current walls and clues.\n\n" +
                       "Another solution has been showed in an independent window.\n" +
                       "You can restore some clues, add some clues or change the walls to determine again.");
    },

    _user_board_complete() {
        const p = this.puzzle;
        const lit = p.lit_info();
        for (const cell of p.white_cells()) {
            const k = RC(...cell);
            if (!(lit.get(k) > 0) && !p.lights.has(k)) return false;
        }
        return true;
    },

    // ---------------- Determination ③: Difficulty Evaluation ----------------
    async check_difficulty() {
        this.status("Difficulty evaluating (Priority given to logical deduction)...");
        const res = await runTask("difficulty", { puzzle: this.puzzle.to_dict() });
        const d = res.result;
        if (!d.ok) {
            this.status("Determination ③:" + d.msg);
            await dlgAlert("Difficulty Evaluation", d.msg);
            return;
        }
        const s = d.stats;
        const lines = [
            `Difficulty Coefficient: ${d.score}`,
            `Difficulty Level: ${d.level}`,
            "",
            "Used Skills Statistics:",
            `     T1 Direct Deduction                                  × ${s.T1 || 0} (Weighted 1)`,
            `     T2 Only Light                                             × ${s.T2 || 0} (Weighted 3)`,
            `     T3 Structure Technique                            × ${s.T3 || 0} (Weighted 8)`,
            `     T4 Shallow 「Reductio Ad Absurdum」 × ${s.T4 || 0} (Weighted 25)`,
        ];
        if (d.guesses > 0)
            lines.push(`     T5 Necessary Assumption Branches       × ${d.guesses} (Weighted 300)`);
        else
            lines.push("     No assumptions needed! ✔");
        lines.push("",
                   "Difficulty Ranges:",
                   "     ≤29                                                    NOVICE",
                   "     30~99                                                EASY",
                   "     100~299                                            MEDIUM",
                   "     300~999                                            HARD",
                   "     ≥1000 (Or Assumption Needed)   EXPERT");
        this.status(`Determination ③:Difficulty Coefficient ${d.score} → ${d.level}`);
        await dlgAlert("Difficulty Evaluation", lines.join("\n"));
    },
});

// ============================================================
// AkariDesignerApp —— Part 4: Digging, File I/O, Graphs, Bank, Settings
// ============================================================

Object.assign(AkariDesignerApp.prototype, {

    // ---------------- Determination ④: Dig for Hard! ----------------
    open_dig() {
        if (this.digDlg) return;             // already open
        if (this._edit_locked("Dig for Hard!")) return;
        if (![...this.puzzle.clue_active.values()].some(v => v)) {
            dlgAlert("Cannot Dig", "No valid clues to remove!");
            return;
        }
        this.digDlg = new DigDialog(this);
    },

    apply_dig(removed) {
        /* Apply the digging result: removed clues are marked as invalid
         * (Fainter), and a snapshot is saved for 「↩ Undo Digging」. */
        if (this._edit_locked("Apply the Digging Result")) return;
        const p = this.puzzle;
        this._push_undo("Dig for Hard!");
        this._dig_undo = new Map();
        for (const [r, c] of removed) {
            const key = RC(r, c);
            if (p.clues.has(key)) this._dig_undo.set(key, p.clue_active.get(key) !== false);
        }
        for (const [r, c] of removed) {
            const key = RC(r, c);
            if (p.clues.has(key)) p.clue_active.set(key, false);
        }
        // Uniqueness of the digging result has been guaranteed by the digging algorithm.
        this._verified_unique = true;
        this._redraw();
        this.status(`Digging completed: ${removed.length} clues removed (Showed in fainter color).\n` +
                    "You can click 「↩ Undo Digging」 to restore them, or manually set one by one.");
    },

    undo_dig() {
        if (this._edit_locked("Undo Digging")) return;
        if (!this._dig_undo) {
            this.status("No digging operation can be undone!");
            bell();
            return;
        }
        this._push_undo("Undo Digging");
        let restored = 0;
        for (const [key, on] of this._dig_undo) {
            if (this.puzzle.clues.has(key)) {
                this.puzzle.clue_active.set(key, on);
                restored++;
            }
        }
        this._dig_undo = null;
        this._mark_unverified();
        this._redraw();
        this.status(`${restored} clues before digging restored.`);
    },

    // ---------------- Puzzle File: Open / Save (interface metadata included) ----------------
    _save_text() {
        /* .akari data: puzzle data + interface metadata (Design Approach &
         * Puzzle Name). Metadata lives in an independent UI field and is
         * ignored by old versions of the software. */
        const d = this.puzzle.to_dict();
        d.ui = { paradigm: this.paradigm,
                 name: document.getElementById("inpName").value.trim() };
        return JSON.stringify(d, null, 1);
    },

    _adopt_puzzle(p, paradigm = null, name = "", source = "") {
        /* Load a puzzle into the main interface (Open & Import). */
        this._push_undo("Open/Import a Puzzle");
        this.puzzle = p;
        this.marks.clear();
        if (!["lights", "walls"].includes(paradigm))
            // No metadata → a reasonable deduce: no lights probably leads to 「Clues First」
            paradigm = (p.clues.size && !p.lights.size) ? "walls" : "lights";
        this.paradigm = paradigm;
        document.getElementById("paraLights").checked = paradigm === "lights";
        document.getElementById("paraWalls").checked = paradigm === "walls";
        this._buildEditRow();
        this.board.show_inactive = (paradigm === "walls");
        document.getElementById("inpName").value = name;
        this.anchor = null;
        this.backup_lights = null;
        this._dig_undo = null;
        this._verified_unique = false;
        this.board.set_anchor(null);
        this.board.build(this.puzzle);
        this._redraw();
        this.status(`Opened: ${source}(${p.rows} × ${p.cols}, ${paradigm === "walls" ? "Clues First" : "Lights First"})`);
        this.zoomBar.refresh();
    },

    async save_puzzle() {
        const name = await this.auto_filename();
        downloadBlob(new Blob([this._save_text()], { type: "application/json" }), name + ".akari");
        this.status(`Akari saved: ${name}.akari (Check the Downloads folder)`);
    },

    async quick_save_library() {
        /* Saving into Akari Bank via one-click: automatically named. */
        const name = await this.auto_filename();
        const bank = bankLoad();
        let finalName = name, i = 1;
        while (finalName + ".akari" in bank) finalName = `${name}_${++i}`;
        bank[finalName + ".akari"] = this._save_text();
        bankSave(bank);
        this.status(`Akari saved into Akari Bank: ${finalName}.akari`);
        this._refresh_library();
    },

    open_puzzle() {
        if (this._edit_locked("Open Akari")) return;
        document.getElementById("fileOpen").click();
    },

    async _load_content(text, sourceName, { ask_lights = true } = {}) {
        let p, ui = {};
        try {
            const d = JSON.parse(text);
            ui = (d && typeof d === "object" && d.ui) || {};
            p = Puzzle.from_dict(d);
        } catch (e) {
            await dlgAlert("Failed to open!", String(e.message || e));
            return false;
        }
        if (p.lights.size && ask_lights) {
            const ans = await dlgYesNoCancel(
                "Open Akari",
                "This akari file contains lights. Keep them?\n\n" +
                "「Yes」 Open with the lights\n(Recommended for continuing designing the puzzle)\n" +
                "「No」 Open without the lights\n(Recommended for testing the puzzle)\n" +
                "You can select 「No」 to avoid being spoiled by seeing the answer!\n" +
                "「Cancel」 Cancel opening");
            if (ans === null) return false;
            if (!ans) p.lights.clear();
        }
        this._adopt_puzzle(p, ui.paradigm || null, ui.name || "", sourceName);
        return true;
    },

    // ---------------- Import graphs ----------------
    import_image() {
        if (this._edit_locked("Import Akari Graph")) return;
        document.getElementById("fileImport").click();
    },

    async _import_image_file(file) {
        let p, st;
        try {
            [p, st] = await import_puzzle_image(file);
        } catch (e) {
            await dlgAlert("Failed to import!", String(e.message || e));
            return;
        }
        let msg = `Graph identified: ${st.rows} × ${st.cols} board, ${st.clues} clues` +
                  `${st.lights ? ", lights included" : ""}.`;
        if (st.dim)
            msg += `\nCAUTION: ${st.dim} clues on the wall cannot be identified. ` +
                   "\nThey are regarded as 「No Clue」 walls. Please check manually.";
        if (st.uncertain)
            msg += `\nCAUTION: The color of ${st.uncertain} sampling points deviate significantly from the known theme, ` +
                   "indicating a potential error in the grid pattern.\nPlease check manually.";
        if (p.lights.size) {
            const ans = await dlgYesNoCancel(
                "Import Akari Graph",
                msg + "\n\nLights included in the graph, keep them?\n" +
                "(Recommended for testing the puzzle. Select 「No」 to avoid being spoiled by seeing the answer!)");
            if (ans === null) return;
            if (!ans) p.lights.clear();
        } else {
            await dlgAlert("Import Akari Graph", msg);
        }
        this._adopt_puzzle(p, null, "", file.name);
    },

    // ---------------- Default file name format ----------------
    _next_serial() {
        /* The next serial number in the Local Bank (scan all 6-digit prefixes). */
        let n = 0;
        for (const fn of Object.keys(bankLoad())) {
            const m = fn.match(/^(\d{6})_/);
            if (m) n = Math.max(n, parseInt(m[1]));
        }
        return n + 1;
    },

    _level_en(level) {
        for (const [prefix, en] of AkariDesignerApp.LEVEL_EN)
            if (level.startsWith(prefix)) return en;
        return "Unknown";
    },

    _completeness() {
        /* The Completeness tag in the default file name:
         * (Sparse_k_w) = k valid clues on w walls in total;
         * (Full_w) = every one of the w walls has a valid clue.
         * Marked only when Uniqueness Determination has been executed, or "▲" there. */
        if (!this._verified_unique) return "▲";
        const p = this.puzzle;
        let walls = 0;
        for (let r = 0; r < p.rows; r++)
            for (let c = 0; c < p.cols; c++)
                if (p.grid[r][c] === WALL) walls++;
        const active = [...p.clue_active.entries()]
            .filter(([k, v]) => v && p.grid[unRC(k)[0]][unRC(k)[1]] === WALL).length;
        return active === walls ? `(Full_${walls})` : `(Sparse_${active}_${walls})`;
    },

    async auto_filename() {
        /* e.g. 「000005_Hard(Sparse_6_16)_【Ciallo】_20261121_181100」.
         * Difficulty is evaluated on the spot (only when there are no more
         * than 1888 Not Wall cells and at least 1 valid clue, or "▲" there). */
        const serial = String(this._next_serial()).padStart(6, "0");
        const p = this.puzzle;
        const active = [...p.clue_active.values()].filter(v => v).length;
        const w = p.white_count();
        let level = "▲";
        if (active > 0 && w <= 1888) {
            try {
                const res = await runTask("difficulty", { puzzle: p.to_dict() });
                if (res.result.ok) level = this._level_en(res.result.level);
            } catch (e) { /* keep ▲ */ }
        }
        const sparse = this._completeness();
        const name = document.getElementById("inpName").value.trim();
        const namePart = name ? `【${name}】` : "【▲】";
        const d = new Date();
        const t = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}` +
                  `_${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}`;
        return `${serial}_${level}${sparse}_${namePart}_${t}`;
    },

    // ---------------- Akari Bank ----------------
    open_library() {
        if (this.libraryWin) return;
        this.libraryWin = new LibraryWindow(this);
    },
    _refresh_library() { if (this.libraryWin) this.libraryWin.refresh(); },

    // ---------------- Output graphs ----------------
    async export_image(with_lights) {
        /* Default file name: same format as saving a puzzle file, plus
         * 「(No Lights)」/「(With Lights)」 at the end. PNG output (BMP is
         * available through the console; most users pick PNG). */
        let name = await this.auto_filename();
        name += with_lights ? "(With Lights)" : "(No Lights)";
        const blob = await export_puzzle_image(this.puzzle, { cell: 40, show_lights: with_lights, format: "png" });
        downloadBlob(blob, name + ".png");
        this.status(`Graph output: ${name}.png (Check the Downloads folder)\nUse 「Import Akari Graph...」 to import graphs.`);
    },

    // ---------------- Settings dialog ----------------
    open_settings() {
        if (this.settingsDlg) return;
        this.settingsDlg = new SettingsDialog(this);
    },

    applyThemeAll() {
        /* Theme/display options changed: re-color everything. */
        this.board.apply_theme();
        this._redraw();
        if (this.solveWin)
            this.solveWin.board.redraw({ solve_feedback: true,
                                         marks: this.solveWin.marks,
                                         alarms: this.solveWin._alarms });
        for (const w of this.solveWins)
            w.board.redraw({ solve_feedback: true, marks: w.marks, alarms: w._alarms });
    },

    // ---------------- Test Mode ----------------
    enter_solve() {
        if (this.solveWin) return;
        if (!this.puzzle.white_count()) {
            dlgAlert("Cannot Enter!", "No valid cells to fill!");
            return;
        }
        this.solveWin = new SolveWindow(this, this.puzzle);
        this.status("Test Mode opened. Puzzle board protected.");
    },
    exit_solve() {
        this.solveWin = null;
        this._set_edit_lock(false);          // unlock all edit widgets and restore the title
        this._redraw();
        this.status("Back to Design Mode.");
    },

    // ---------------- Backup configuration window ----------------
    _show_backup(lights, title) {
        showSolutionWindow(this.puzzle, lights, title);
    },
    open_backup() {
        if (this.backup_lights === null) {
            this.status("No backup configuration: Please click 「① Solvab. Determ.」 first.");
            return;
        }
        this._show_backup(this.backup_lights, "Backup Configuration");
    },
});

// ============================================================
// Entrance
// ============================================================
window.addEventListener("DOMContentLoaded", () => {
    window.app = new AkariDesignerApp();
});
