/* canvas.js —— Akari Designer · Puzzle Board Canvas (Web port of akari_widgets.py)
 * Puzzle board canvas with scrolling and zoom. Mouse/touch events are
 * forwarded to the handler (canvas_press / canvas_drag / canvas_release /
 * canvas_right). Built-in non-blocking animations: conflict flashing, clue
 * shaking, border flashing in red, whole-board color changing.
 */
"use strict";

class BoardView {
    static ZOOM_MIN = 10;
    static ZOOM_MAX = 400;

    constructor(container, handler) {
        this.handler = handler;
        this.puzzle = null;
        this.zoom = 100;
        this.base_cs = 36;
        this.cs = 36;
        this.anchor = null;               // Reference cell (base of inserting/deleting rows/columns)
        // When true, fainter clues are always showed (used by the design
        // canvas under 「Clues First」).
        this.show_inactive = false;
        this._last = { solve_feedback: false, marks: new Set(), alarms: new Set() };
        this._alarms = new Set();
        this._alarmPhase = false;
        this._alarmTimer = null;
        this._flashMap = new Map();       // cell -> color (temporary fill override)
        this._flashTimer = null;
        this._shakeMap = new Map();       // cell -> x offset for clue text
        this._shakeTimer = null;

        this.wrap = container;            // scrollable wrapper (overflow:auto)
        this.wrap.classList.add("board-wrap");
        this.cv = document.createElement("canvas");
        this.cv.classList.add("board-canvas");
        this.wrap.appendChild(this.cv);
        this.ctx = this.cv.getContext("2d");

        // ---------- Mouse events ----------
        this._pressCell = undefined;      // cell of the active left press (undefined = none)
        this.cv.addEventListener("mousedown", (e) => {
            if (e.button === 0) { this._pressCell = this._cellAt(e); this._relay("press", e); }
            else if (e.button === 2) this._relay("right", e);
            e.preventDefault();
        });
        this.cv.addEventListener("mousemove", (e) => {
            if (e.buttons & 1) this._relay("drag", e);
        });
        window.addEventListener("mouseup", (e) => {
            if (this._pressCell !== undefined) { this._relay("release", e); this._pressCell = undefined; }
        });
        this.cv.addEventListener("contextmenu", (e) => e.preventDefault());
        // Ctrl+wheel = zoom (25% per step), like the desktop version
        this.cv.addEventListener("wheel", (e) => {
            if (e.ctrlKey) {
                e.preventDefault();
                this.set_zoom(this.zoom + (e.deltaY < 0 ? 25 : -25));
                if (this.onzoom) this.onzoom(this.zoom);
            }
        }, { passive: false });

        // ---------- Touch events: tap = left-click, long-press = right-click ----------
        let touchTimer = null, touchMoved = false, lastTouch = null;
        this.cv.addEventListener("touchstart", (e) => {
            if (e.touches.length !== 1) return;
            e.preventDefault();
            touchMoved = false;
            lastTouch = e.touches[0];
            this._pressCell = this._cellAt(lastTouch);
            touchTimer = setTimeout(() => {
                if (!touchMoved) { this._relay("right", lastTouch); this._pressCell = undefined; }
            }, 550);
            this._relay("press", lastTouch);
        }, { passive: false });
        this.cv.addEventListener("touchmove", (e) => {
            if (e.touches.length !== 1) return;
            e.preventDefault();
            touchMoved = true;
            clearTimeout(touchTimer);
            lastTouch = e.touches[0];
            this._relay("drag", lastTouch);
        }, { passive: false });
        this.cv.addEventListener("touchend", (e) => {
            clearTimeout(touchTimer);
            if (this._pressCell !== undefined) { this._relay("release", lastTouch || e); this._pressCell = undefined; }
        });
    }

    // ---------- Zoom ----------
    set_zoom(pct) {
        this.zoom = Math.max(BoardView.ZOOM_MIN, Math.min(BoardView.ZOOM_MAX, Math.round(pct)));
        if (this.puzzle !== null) this._rebuild();
        if (this.onzoom) this.onzoom(this.zoom);
    }

    // ---------- Building ----------
    build(puzzle) {
        this.puzzle = puzzle;
        const m = Math.max(puzzle.rows, puzzle.cols);
        this.base_cs = Math.max(16, Math.min(38, Math.floor(680 / Math.max(m, 1)))); // cell width at 100%
        this._rebuild();
    }

    _rebuild() {
        const p = this.puzzle;
        this.cs = Math.max(6, Math.round(this.base_cs * this.zoom / 100));
        const w = p.cols * this.cs + 2, h = p.rows * this.cs + 2;
        const dpr = window.devicePixelRatio || 1;
        this.cv.style.width = w + "px";
        this.cv.style.height = h + "px";
        this.cv.width = Math.round(w * dpr);
        this.cv.height = Math.round(h * dpr);
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.redraw();
    }

    apply_theme() {
        this.wrap.style.background = C("bg");
        this._rebuild();
    }

    set_anchor(cell) {
        this.anchor = cell;
        this.redraw();
    }

    // ---------- Redrawing ----------
    redraw(opts = null) {
        /* opts.solve_feedback: feedback in Test Mode (exceeded clues show
         * negative values; unfulfilled clues are marked red according to the
         * setting; when 「Countdown」 is on, the remaining number is showed);
         * opts.marks: the Set of 「×」 marks (cell keys);
         * opts.alarms: the Set of clues that need continuous flashing alarms. */
        if (opts) {
            this._last = {
                solve_feedback: !!opts.solve_feedback,
                marks: opts.marks || new Set(),
                alarms: opts.alarms || new Set(),
            };
        }
        const { solve_feedback, marks, alarms } = this._last;
        this._alarms = new Set(alarms);
        this._sync_alarm_loop();

        const p = this.puzzle;
        if (p === null) return;
        const ctx = this.ctx, cs = this.cs;
        const w = p.cols * cs + 2, h = p.rows * cs + 2;
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = C("bg");
        ctx.fillRect(0, 0, w, h);

        const lit = p.lit_info();
        const hide_off = S.hide_inactive_clues && !this.show_inactive;
        const red_unsat = S.red_unsatisfied;

        // ---- Cells ----
        for (let r = 0; r < p.rows; r++) {
            for (let c = 0; c < p.cols; c++) {
                const key = RC(r, c);
                const t = p.grid[r][c];
                let color;
                if (t === OUTSIDE) color = C("outside");
                else if (t === WALL) color = C("wall");
                else {
                    const n = lit.get(key) || 0;
                    color = n >= 2 ? C("lit2") : (n === 1 ? C("lit1") : C("unlit"));
                }
                if (this._flashMap.has(key)) color = this._flashMap.get(key);
                const x0 = c * cs + 1, y0 = r * cs + 1;
                ctx.fillStyle = color;
                ctx.fillRect(x0, y0, cs, cs);
                ctx.strokeStyle = C("grid");
                ctx.lineWidth = 1;
                ctx.strokeRect(x0 + 0.5, y0 + 0.5, cs - 1, cs - 1);
            }
        }
        // ---- Clues ----
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        for (const [key, k] of p.clues) {
            const [r, c] = unRC(key);
            if (p.grid[r][c] !== WALL) continue;
            const active = p.clue_active.get(key) !== false;
            if (!active && hide_off) continue;      // clues not used as conditions are directly hidden
            let text = String(k), color = active ? C("clue") : C("clueoff");
            if (solve_feedback && active) {
                const actual = this._adjacent_lights(r, c);
                if (S.clue_countdown) {             // remaining number = clue − adjacent lights
                    const rest = k - actual;
                    text = String(rest);
                    if (rest < 0) color = C("bad"); // too many lights put
                    else if (rest > 0 && red_unsat) color = C("bad");
                } else {
                    if (actual > k) { text = `-${actual - k}`; color = C("bad"); }
                    else if (actual < k && red_unsat) color = C("bad");
                }
            }
            if (this._alarms.has(key) && this._alarmPhase) color = C("bad");
            const dx = this._shakeMap.get(key) || 0;
            ctx.fillStyle = color;
            ctx.font = `bold ${Math.max(9, Math.floor(cs / 2) - 2)}px Arial, sans-serif`;
            ctx.fillText(text, c * cs + 1 + cs / 2 + dx, r * cs + 1 + cs / 2);
        }
        // ---- Lights ----
        for (const key of p.lights) {
            const [r, c] = unRC(key);
            const cx = c * cs + 1 + cs / 2, cy = r * cs + 1 + cs / 2, rad = Math.floor(cs / 3);
            ctx.beginPath();
            ctx.arc(cx, cy, rad, 0, Math.PI * 2);
            ctx.fillStyle = C("bulb");
            ctx.fill();
            ctx.lineWidth = 2;
            ctx.strokeStyle = C("bulb_edge");
            ctx.stroke();
        }
        // ---- 「×」 marks ----
        const hide_lit_marks = S.hide_lit_marks;
        ctx.fillStyle = C("mark");
        ctx.font = `bold ${Math.max(8, Math.floor(cs / 2))}px Arial, sans-serif`;
        for (const key of marks) {
            const [r, c] = unRC(key);
            if (hide_lit_marks && (lit.get(key) || 0) > 0) continue; // hidden on lighted cells per setting
            ctx.fillText("×", c * cs + 1 + cs / 2, r * cs + 1 + cs / 2);
        }
        // ---- Reference cell (small triangle at the upper-left corner) ----
        if (this.anchor !== null) {
            const [r, c] = this.anchor;
            if (r >= 0 && r < p.rows && c >= 0 && c < p.cols) {
                const x0 = c * cs + 1, y0 = r * cs + 1;
                const t = Math.max(5, Math.floor(cs / 4));
                ctx.fillStyle = "#1E88E5";
                ctx.beginPath();
                ctx.moveTo(x0 + 1, y0 + 1);
                ctx.lineTo(x0 + t, y0 + 1);
                ctx.lineTo(x0 + 1, y0 + t);
                ctx.closePath();
                ctx.fill();
            }
        }
    }

    // ---------- Continuous Flashing Alarm of Clues (Test Mode) ----------
    _sync_alarm_loop() {
        if (this._alarms.size && this._alarmTimer === null) {
            this._alarmPhase = false;
            this._alarmTimer = setInterval(() => {
                if (!this._alarms.size) { clearInterval(this._alarmTimer); this._alarmTimer = null; return; }
                this._alarmPhase = !this._alarmPhase;
                this.redraw();
            }, 420);
        } else if (!this._alarms.size && this._alarmTimer !== null) {
            clearInterval(this._alarmTimer);
            this._alarmTimer = null;
        }
    }

    _adjacent_lights(r, c) {
        const p = this.puzzle;
        let n = 0;
        for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const rr = r + dr, cc = c + dc;
            if (rr >= 0 && rr < p.rows && cc >= 0 && cc < p.cols && p.lights.has(RC(rr, cc))) n++;
        }
        return n;
    }

    // ---------- Non-blocking Animations ----------
    flash_cells(cells, color = FLASH_RED, times = 4, interval = 110) {
        /* Let a group of cells flash between the given color and their
         * original colors several times (light-conflict prompts). */
        const p = this.puzzle;
        cells = cells.filter(([r, c]) => r >= 0 && r < p.rows && c >= 0 && c < p.cols);
        clearInterval(this._flashTimer);
        let i = 0;
        const step = () => {
            if (i >= times * 2) {
                this._flashMap.clear();
                this._flashTimer = null;
                this.redraw();
                return;
            }
            this._flashMap.clear();
            if (i % 2 === 0) for (const [r, c] of cells) this._flashMap.set(RC(r, c), color);
            this.redraw();
            i++;
        };
        step();
        this._flashTimer = setInterval(step, interval);
    }

    flash_conflict(cell) {
        /* For light conflicts: flash the cell and the whole line segment
         * between each light lighting it and the cell. */
        const p = this.puzzle;
        const [r, c] = cell;
        const cells = new Set([RC(r, c)]);
        for (const lk of p.lights) {
            const [lr, lc] = unRC(lk);
            if (lr === r) {
                const lo = Math.min(lc, c), hi = Math.max(lc, c);
                let ok = true;
                for (let cc = lo; cc <= hi; cc++) if (p.grid[r][cc] !== WHITE) { ok = false; break; }
                if (ok) for (let cc = lo; cc <= hi; cc++) cells.add(RC(r, cc));
            } else if (lc === c) {
                const lo = Math.min(lr, r), hi = Math.max(lr, r);
                let ok = true;
                for (let rr = lo; rr <= hi; rr++) if (p.grid[rr][c] !== WHITE) { ok = false; break; }
                if (ok) for (let rr = lo; rr <= hi; rr++) cells.add(RC(rr, c));
            }
        }
        this.flash_cells([...cells].map(unRC));
    }

    shake_cell(key, dx = 3, times = 8, interval = 45) {
        /* Let a clue text shake left and right (clue warnings). */
        clearInterval(this._shakeTimer);
        let i = times;
        const step = () => {
            if (i <= 0) {
                this._shakeMap.delete(key);
                this._shakeTimer = null;
                this.redraw();
                return;
            }
            this._shakeMap.set(key, (i % 2 === 0) ? dx : -dx);
            this.redraw();
            i--;
        };
        step();
        this._shakeTimer = setInterval(step, interval);
    }

    flash_border(color = FLASH_RED, times = 3, interval = 130) {
        /* Flash the canvas border in red (「All lighted but some clues
         * unfulfilled」 warning). */
        let i = 0;
        const step = () => {
            if (i >= times * 2) { this.wrap.style.boxShadow = ""; return; }
            this.wrap.style.boxShadow = (i % 2 === 0) ? `inset 0 0 0 5px ${color}` : "";
            i++;
            setTimeout(step, interval);
        };
        step();
    }

    flash_bg(colors = [FLASH_GOOD, FLASH_GOLD], times = 4, interval = 130) {
        /* Flash the whole-board background color (completion celebration). */
        let i = 0;
        const step = () => {
            if (i >= times * 2) { this.wrap.style.background = C("bg"); return; }
            this.wrap.style.background = colors[i % colors.length];
            i++;
            setTimeout(step, interval);
        };
        step();
    }

    // ---------- Event helpers ----------
    _cellAt(e) {
        if (this.puzzle === null) return null;
        const rect = this.cv.getBoundingClientRect();
        const x = e.clientX - rect.left, y = e.clientY - rect.top;
        const c = Math.floor(x / this.cs), r = Math.floor(y / this.cs);
        if (r >= 0 && r < this.puzzle.rows && c >= 0 && c < this.puzzle.cols) return [r, c];
        return null;
    }
    _relay(kind, e) {
        const cell = this._cellAt(e);
        const fn = this.handler["canvas_" + kind];
        if (fn) fn.call(this.handler, cell, e);
    }

    static line_cells(a, b) {
        /* An 8-connected interpolation path between two cells (endpoints
         * included), ensuring that dragging a diagonal line can also paint
         * walls continuously. */
        const [[r0, c0], [r1, c1]] = [a, b];
        const dr = r1 - r0, dc = c1 - c0;
        const steps = Math.max(Math.abs(dr), Math.abs(dc));
        if (steps === 0) return [a];
        const out = [];
        for (let i = 0; i <= steps; i++)
            out.push([r0 + Math.floor(dr * i / steps + 0.5),
                      c0 + Math.floor(dc * i / steps + 0.5)]);
        return out;
    }
}
