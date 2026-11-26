/* core.js —— Akari Designer · Algorithm Core Layer (Web port of akari_core.py)
 * Pure logic module, independent of the DOM. Loaded by both the main page
 * and the Web Worker. Including: data model, puzzle file I/O, constraint
 * solving engine, logic solver based on human techniques and difficulty
 * quantification, and 「Dig for Hard!」.
 */
"use strict";

const WHITE = 0, WALL = 1, OUTSIDE = 2;   // Not Wall Cell / Wall / Hole
const FILE_FORMAT = "akari";
const FILE_VERSION = 2;

const RC = (r, c) => r + "," + c;          // canonical cell key
const unRC = (k) => k.split(",").map(Number);

class Puzzle {
    /* Puzzle data: grid records cell types; clues records clues on walls;
     * clue_active records whether each clue is currently valid;
     * lights records the currently put lights. */
    constructor(rows, cols) {
        this.rows = rows; this.cols = cols;
        this.grid = Array.from({ length: rows }, () => new Array(cols).fill(WHITE));
        this.clues = new Map();        // "r,c" -> int, walls only
        this.clue_active = new Map();  // "r,c" -> bool
        this.lights = new Set();       // "r,c"
    }

    *white_cells() {
        for (let r = 0; r < this.rows; r++)
            for (let c = 0; c < this.cols; c++)
                if (this.grid[r][c] === WHITE) yield [r, c];
    }
    white_count() {
        let n = 0;
        for (let r = 0; r < this.rows; r++)
            for (let c = 0; c < this.cols; c++)
                if (this.grid[r][c] === WHITE) n++;
        return n;
    }

    lit_info() {
        /* Return Map {Not Wall cell: how many lights light it} (only lighted cells). */
        const info = new Map();
        const add = (k) => info.set(k, (info.get(k) || 0) + 1);
        for (const key of this.lights) {
            const [r, c] = unRC(key);
            add(key);
            for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                let rr = r + dr, cc = c + dc;
                while (rr >= 0 && rr < this.rows && cc >= 0 && cc < this.cols
                       && this.grid[rr][cc] === WHITE) {
                    add(RC(rr, cc));
                    rr += dr; cc += dc;
                }
            }
        }
        return info;
    }

    // ---------------- Puzzle file I/O (.akari, JSON text format) ----------------
    to_dict() {
        const out = [], walls = [];
        for (let r = 0; r < this.rows; r++)
            for (let c = 0; c < this.cols; c++) {
                if (this.grid[r][c] === OUTSIDE) out.push([r, c]);
                else if (this.grid[r][c] === WALL) walls.push([r, c]);
            }
        const clues = {};
        for (const [k, v] of this.clues)
            clues[k] = { n: v, on: this.clue_active.get(k) !== false };
        return {
            format: FILE_FORMAT, version: FILE_VERSION,
            rows: this.rows, cols: this.cols,
            outside: out, walls: walls, clues: clues,
            lights: [...this.lights].map(unRC),
        };
    }
    serialize() { return JSON.stringify(this.to_dict(), null, 1); }

    static from_dict(d) {
        /* Raise Error when the format mismatches. */
        if (!d || typeof d !== "object" || d.format !== FILE_FORMAT)
            throw new Error("This is not a puzzle file of this software (format mark mismatched).");
        try {
            const R = parseInt(d.rows), C = parseInt(d.cols);
            if (!(R >= 1 && R <= 60 && C >= 1 && C <= 60)) throw new Error("size out of range");
            const p = new Puzzle(R, C);
            for (const [r, c] of d.outside || []) {
                if (!(r >= 0 && r < R && c >= 0 && c < C)) throw new Error("bad outside");
                p.grid[r][c] = OUTSIDE;
            }
            for (const [r, c] of d.walls || []) {
                if (!(r >= 0 && r < R && c >= 0 && c < C)) throw new Error("bad wall");
                if (p.grid[r][c] !== WHITE) throw new Error("overlap");
                p.grid[r][c] = WALL;
            }
            for (const [key, v] of Object.entries(d.clues || {})) {
                const [r, c] = unRC(key);
                if (p.grid[r][c] !== WALL || !(+v.n >= 0 && +v.n <= 4)) throw new Error("bad clue");
                p.clues.set(key, +v.n);
                p.clue_active.set(key, v.on !== false);
            }
            for (const [r, c] of d.lights || []) {
                if (!(r >= 0 && r < R && c >= 0 && c < C && p.grid[r][c] === WHITE))
                    throw new Error("bad light");
                p.lights.add(RC(r, c));
            }
            return p;
        } catch (e) {
            throw new Error("The puzzle file is broken or illegal: " + e.message);
        }
    }
    static load(text) {
        let d;
        try { d = JSON.parse(text); }
        catch (e) { throw new Error("Cannot read the file: " + e.message); }
        return Puzzle.from_dict(d);
    }
}

class Contradiction extends Error { /* A contradiction is found during propagation. */ }

// ============================================================
// Constraint Solving Engine (Existence / Uniqueness / Another Solution)
// ============================================================

class Solver {
    /* Akari constraint solver: constraint propagation + partition-style
     * backtracking without repetition.
     * count_solutions(limit=2) is used for the Uniqueness Determination
     * (Only needs to count up to 2 solutions). */
    constructor(puzzle, use_clues = true, node_cap = 200000) {
        this.n = 0;
        this.idx = new Map();
        this.cells = [];
        for (let r = 0; r < puzzle.rows; r++)
            for (let c = 0; c < puzzle.cols; c++)
                if (puzzle.grid[r][c] === WHITE) {
                    this.idx.set(RC(r, c), this.n);
                    this.cells.push([r, c]);
                    this.n++;
                }
        // rays[v]: ids of all the Not Wall cells that a light at v can light (v itself included).
        this.rays = [];
        for (const [r, c] of this.cells) {
            const see = [this.idx.get(RC(r, c))];
            for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                let rr = r + dr, cc = c + dc;
                while (this.idx.has(RC(rr, cc))) {
                    see.push(this.idx.get(RC(rr, cc)));
                    rr += dr; cc += dc;
                }
            }
            this.rays.push(see);
        }
        // Clue constraints (Only 「valid」 clues are collected)
        this.clues = [];
        this.cell_clues = Array.from({ length: this.n }, () => []);
        if (use_clues) {
            for (const [key, k] of puzzle.clues) {
                const [r, c] = unRC(key);
                if (puzzle.grid[r][c] !== WALL) continue;
                if (puzzle.clue_active.get(key) === false) continue;
                const nb = [];
                for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                    const id = this.idx.get(RC(r + dr, c + dc));
                    if (id !== undefined) nb.push(id);
                }
                const ci = this.clues.length;
                this.clues.push([nb, k]);
                for (const v of nb) this.cell_clues[v].push(ci);
            }
        }
        this.node_cap = node_cap;
        this.nodes = 0;
        this.aborted = false;
    }

    // ---------- State Operations ----------
    new_state() {
        return {
            light: new Uint8Array(this.n), banned: new Uint8Array(this.n),
            lit: new Array(this.n).fill(0),
            cplaced: new Array(this.clues.length).fill(0),
            cfree: this.clues.map(([nb]) => nb.length),
            queue: [], lights: [],
        };
    }
    copy_state(st) {
        return {
            light: st.light.slice(), banned: st.banned.slice(),
            lit: st.lit.slice(), cplaced: st.cplaced.slice(), cfree: st.cfree.slice(),
            queue: [], lights: st.lights.slice(),
        };
    }
    _ban(st, v) {
        if (st.light[v]) throw new Contradiction();
        if (st.banned[v]) return;
        st.banned[v] = 1;
        for (const ci of this.cell_clues[v]) {
            st.cfree[ci]--;
            st.queue.push(['clue', ci]);
        }
        for (const x of this.rays[v])            // x loses one candidate that may light it
            if (st.lit[x] === 0) st.queue.push(['cell', x]);
    }
    _place(st, v) {
        if (st.banned[v]) throw new Contradiction();
        if (st.light[v]) return;
        st.light[v] = 1;
        st.lights.push(v);
        for (const ci of this.cell_clues[v]) {
            st.cplaced[ci]++;
            st.cfree[ci]--;
            st.queue.push(['clue', ci]);
        }
        for (const w of this.rays[v]) {
            st.lit[w]++;
            if (w !== v && !st.light[w] && !st.banned[w]) this._ban(st, w);
        }
    }

    // ---------- Constraint Propagation ----------
    propagate(st) {
        const q = st.queue;
        while (q.length) {
            const [kind, i] = q.pop();
            if (kind === 'clue') {
                const [nb, k] = this.clues[i];
                const placed = st.cplaced[i], free = st.cfree[i];
                if (placed > k || placed + free < k) throw new Contradiction();
                if (free > 0) {
                    if (placed === k) {              // satisfied → ban all the other adjacent cells
                        for (const v of nb)
                            if (!st.light[v] && !st.banned[v]) this._ban(st, v);
                    } else if (free === k - placed) { // all the remaining cells must be lights
                        for (const v of nb)
                            if (!st.light[v] && !st.banned[v]) this._place(st, v);
                    }
                }
            } else {                                 // an unlighted cell must be able to be lighted
                const x = i;
                if (st.lit[x] > 0) continue;
                const cand = this.rays[x].filter(v => !st.banned[v]);
                if (!cand.length) throw new Contradiction();
                if (cand.length === 1) this._place(st, cand[0]);
            }
        }
        return true;
    }

    // ---------- Backtracking Search (Partition-style branching, no repeated counting) ----------
    search(st, limit, out) {
        this.nodes++;
        if (this.nodes > this.node_cap) { this.aborted = true; return; }
        try { this.propagate(st); } catch (e) {
            if (e instanceof Contradiction) return; throw e;
        }
        let target = -1, best = null;
        for (let x = 0; x < this.n; x++) {
            if (st.lit[x] === 0) {
                const cand = this.rays[x].filter(v => !st.banned[v]);
                if (best === null || cand.length < best.length) {
                    target = x; best = cand;
                    if (best.length === 2) break;
                }
            }
        }
        if (target < 0) {                            // all lighted → a complete solution
            out.push(st.lights.map(v => this.cells[v]));
            return;
        }
        for (let j = 0; j < best.length; j++) {
            const st2 = this.copy_state(st);
            try {
                for (let u = 0; u < j; u++) this._ban(st2, best[u]); // ban the first j-1 candidates
                this._place(st2, best[j]);                           // put a light at the j-th candidate
            } catch (e) {
                if (e instanceof Contradiction) continue; throw e;
            }
            this.search(st2, limit, out);
            if (out.length >= limit || this.aborted) return;
        }
    }

    count_solutions(limit = 2) {
        /* Return [list of solutions, whether aborted by the node cap]. */
        this.nodes = 0;
        this.aborted = false;
        const out = [];
        try { this.search(this.new_state(), limit, out); }
        catch (e) { if (!(e instanceof Contradiction)) throw e; }
        return [out, this.aborted];
    }
}

// ============================================================
// Logic Solver Based on Human Techniques & Difficulty Quantification
// ============================================================
//   T1 Direct Deduction from Numbers (×1) · T2 Only Light (×3)
//   T3 Structure Technique (×8) · T4 Shallow 「Reductio Ad Absurdum」 (×25)
//   GUESS Deep Assumption (×300)
// Difficulty level division (A self-defined standard of this software):
//   <30 NOVICE | 30~99 EASY | 100~299 MEDIUM | 300~999 HARD
//   ≥1000 or assumptions needed EXPERT

class LogicSolver extends Solver {
    constructor(puzzle) {
        super(puzzle, true);
        this.stats = { T1: 0, T2: 0, T3: 0, T4: 0 };
    }
    static W = { T1: 1, T2: 3, T3: 8, T4: 25, GUESS: 300 };

    _ban_l(st, v, tech) {
        if (st.banned[v] || st.light[v]) return false;
        this._ban(st, v);
        this.stats[tech]++;
        return true;
    }
    _place_l(st, v, tech) {
        if (st.light[v]) return false;
        this._place(st, v);
        this.stats[tech]++;
        return true;
    }

    // ---- T1: Direct Deduction from Numbers ----
    round_T1(st) {
        let changed = false;
        for (let i = 0; i < this.clues.length; i++) {
            const [nb, k] = this.clues[i];
            const placed = st.cplaced[i], free = st.cfree[i];
            if (placed > k || placed + free < k) throw new Contradiction();
            if (free === 0) continue;
            const rest = nb.filter(v => !st.light[v] && !st.banned[v]);
            if (placed === k) {
                for (const v of rest) changed = this._ban_l(st, v, 'T1') || changed;
            } else if (free === k - placed) {
                for (const v of rest) changed = this._place_l(st, v, 'T1') || changed;
            }
        }
        return changed;
    }

    // ---- T2: Only Light ----
    round_T2(st) {
        let changed = false;
        for (let x = 0; x < this.n; x++) {
            if (st.lit[x] === 0) {
                const cand = this.rays[x].filter(v => !st.banned[v]);
                if (!cand.length) throw new Contradiction();
                if (cand.length === 1) changed = this._place_l(st, cand[0], 'T2') || changed;
            }
        }
        return changed;
    }

    // ---- T3: Structure Technique ----
    round_T3(st) {
        let changed = false;
        // (a) 「One short」 diagonal elimination
        for (let i = 0; i < this.clues.length; i++) {
            const [nb, k] = this.clues[i];
            const need = k - st.cplaced[i];
            const rest = nb.filter(v => !st.light[v] && !st.banned[v]);
            if (need >= 1 && rest.length === need + 1) {
                const cnt = new Map();
                for (const v of rest)
                    for (const w of this.rays[v]) cnt.set(w, (cnt.get(w) || 0) + 1);
                const inRest = new Set(rest);
                for (const [w, c] of cnt)
                    if (c >= 2 && !inRest.has(w)) changed = this._ban_l(st, w, 'T3') || changed;
            }
        }
        // (b) Block elimination
        for (let x = 0; x < this.n; x++) {
            if (st.lit[x] === 0) {
                const cand = this.rays[x].filter(v => !st.banned[v]);
                if (!cand.length) throw new Contradiction();
                if (cand.length >= 2 && cand.length <= 4) {
                    const common = new Set(this.rays[cand[0]]);
                    for (const v of cand.slice(1))
                        for (const w of [...common])
                            if (!this.rays[v].includes(w)) common.delete(w);
                    const inCand = new Set(cand);
                    for (const w of common)
                        if (w !== x && !inCand.has(w)) changed = this._ban_l(st, w, 'T3') || changed;
                }
            }
        }
        return changed;
    }

    // ---- T4: Shallow 「Reductio Ad Absurdum」 (One-step assumption) ----
    round_T4(st, max_trials = 40) {
        const cands = new Set();
        for (let i = 0; i < this.clues.length; i++) {
            const [nb, k] = this.clues[i];
            if (k - st.cplaced[i] > 0)
                for (const v of nb)
                    if (!st.light[v] && !st.banned[v]) cands.add(v);
        }
        for (let x = 0; x < this.n; x++) {
            if (st.lit[x] === 0) {
                const c = this.rays[x].filter(v => !st.banned[v]);
                if (c.length >= 2 && c.length <= 3) for (const v of c) cands.add(v);
            }
        }
        for (const v of [...cands].slice(0, max_trials)) {
            const st2 = this.copy_state(st);         // assume v is NOT a light
            try {
                this._ban(st2, v);
                this.propagate(st2);
            } catch (e) {
                if (e instanceof Contradiction) return this._place_l(st, v, 'T4');
                throw e;
            }
            const st3 = this.copy_state(st);         // assume v IS a light
            try {
                this._place(st3, v);
                this.propagate(st3);
            } catch (e) {
                if (e instanceof Contradiction) return this._ban_l(st, v, 'T4');
                throw e;
            }
        }
        return false;
    }

    solve_logically() {
        /* Return [the pure logic solution or null, technique statistics,
         * the number of guesses needed (-1 means clue contradiction)]. */
        this.nodes = 0;
        const st = this.new_state();
        try {
            for (;;) {
                while (this.round_T1(st) || this.round_T2(st)) { /* keep looping */ }
                if (this.round_T3(st)) continue;
                if (this.round_T4(st)) continue;
                break;
            }
            let allLit = true;
            for (let x = 0; x < this.n; x++) if (st.lit[x] === 0) { allLit = false; break; }
            if (allLit)
                return [st.lights.map(v => this.cells[v]), this.stats, 0];
        } catch (e) {
            if (e instanceof Contradiction) return [null, this.stats, -1];
            throw e;
        }
        return [null, this.stats, this._count_guesses(st)];
    }

    _count_guesses(st, depth = 0, cap = 60000) {
        this.nodes++;
        if (this.nodes > cap) return 99;
        try { this.propagate(st); } catch (e) {
            if (e instanceof Contradiction) return null; throw e;
        }
        let target = -1, best = null;
        for (let x = 0; x < this.n; x++) {
            if (st.lit[x] === 0) {
                const cand = this.rays[x].filter(v => !st.banned[v]);
                if (best === null || cand.length < best.length) { target = x; best = cand; }
            }
        }
        if (target < 0) return depth;
        let ans = null;
        for (let j = 0; j < best.length; j++) {
            const st2 = this.copy_state(st);
            try {
                for (let u = 0; u < j; u++) this._ban(st2, best[u]);
                this._place(st2, best[j]);
            } catch (e) {
                if (e instanceof Contradiction) continue; throw e;
            }
            const g = this._count_guesses(st2, depth + 1, cap);
            if (g !== null) ans = (ans === null) ? g : Math.min(ans, g);
        }
        return ans;
    }

    difficulty() {
        const [sol, stats, guesses] = this.solve_logically();
        if (guesses === -1)
            return { ok: false, msg: "The current valid clues contradict each other. " +
                                     "NO SOLUTION. Cannot evaluate the difficulty." };
        const W = LogicSolver.W;
        let score = 0;
        for (const t of ['T1', 'T2', 'T3', 'T4']) score += W[t] * this.stats[t];
        score += W.GUESS * Math.max(guesses, 0);
        let level;
        if (guesses >= 99) level = "EXPERT (MANY Assumptions needed)";
        else if (guesses >= 2) level = "EXPERT (Assumptions needed)";
        else if (guesses === 1) level = "HARD (1 assumption needed)";
        else if (score < 30) level = "NOVICE";
        else if (score < 100) level = "EASY";
        else if (score < 300) level = "MEDIUM";
        else if (score < 1000) level = "HARD";
        else level = "EXPERT";
        return { ok: true, score, level, stats: { ...stats }, guesses,
                 logical_solved: sol !== null };
    }
}

// ============================================================
// Dig for Hard! (Remove clues while keeping the UNIQUE SOLUTION,
// maximizing the difficulty)
// ============================================================

class DigAbort extends Error { /* The user clicks cancel during the digging process. */ }
class _CapReached extends Error { /* Security limit reached (not cancelled by the user). */ }

function _dig_view(puzzle, off) {
    /* A lightweight puzzle view: share grid/clues (read-only) with puzzle,
     * only mark the clues in the 「off」 set as invalid. */
    const q = new Puzzle(puzzle.rows, puzzle.cols);
    q.grid = puzzle.grid;
    q.clues = puzzle.clues;
    q.clue_active = new Map();
    for (const cell of puzzle.clues.keys())
        q.clue_active.set(cell, !off.has(cell) && puzzle.clue_active.get(cell) !== false);
    return q;
}

function dig_for_hardest(puzzle, { mode = "greedy", enum_limit = 28, logic_only = false,
                                   check_cap = 60000, eval_cap = 2000,
                                   on_progress = null, should_cancel = null } = {}) {
    /* Starting from the current valid clues, find the hardest deletion among
     * those that 「keep the UNIQUE SOLUTION」. */
    const candidates = [...puzzle.clues.keys()].filter(cell => puzzle.clue_active.get(cell) !== false);
    const k = candidates.length;
    if (k === 0) return { ok: false, msg: "No hints to delete!" };

    const state = { checks: 0, evals: 0, pruned: 0, aborted_unknown: 0 };
    const _cancelled = () => should_cancel !== null && should_cancel();
    const _progress = (t) => { if (on_progress !== null) on_progress(t); };

    // ---------- Basic determination: the current (undug) puzzle must HAVE a UNIQUE SOLUTION ----------
    const [sols0, ab0] = new Solver(puzzle, true).count_solutions(2);
    if (ab0 && !sols0.length)
        return { ok: false, msg: "This puzzle is TOO LARGE to determine the uniqueness.\nCannot dig on it! >_<" };
    if (sols0.length === 0)
        return { ok: false, msg: "This puzzle has NO SOLUTION.\nPlease correct it first!" };
    if (sols0.length > 1)
        return { ok: false, msg: "This puzzle already has MULTIPLE SOLUTIONS.\nPlease re-add some hints or change some walls." };

    // ---------- Inner tools ----------
    function unique_ok(off) {
        /* true=UNIQUE SOLUTION; false=NO/MULTIPLE SOLUTIONS; null=TOO LARGE. */
        if (_cancelled()) throw new DigAbort();
        state.checks++;
        if (state.checks % 50 === 0)
            _progress(`Uniqueness verification: ${state.checks} times executed...`);
        if (state.checks > check_cap)
            throw new _CapReached("Max operation times of uniqueness verification reached!");
        const [sols, aborted] = new Solver(_dig_view(puzzle, off), true).count_solutions(2);
        if (aborted) { state.aborted_unknown++; return null; }
        return sols.length === 1;
    }
    function accept(off) {
        const u = unique_ok(off);
        if (u !== true) return u;
        if (logic_only) {
            const [sol] = new LogicSolver(_dig_view(puzzle, off)).solve_logically();
            if (sol === null) return false;    // reject when the assumption method must be used
        }
        return true;
    }
    function diff_eval(off) {
        state.evals++;
        if (state.evals > eval_cap)
            throw new _CapReached("Max operation times of difficulty evaluating reached!");
        const d = new LogicSolver(_dig_view(puzzle, off)).difficulty();
        if (!d.ok) return [-1, d];
        return [d.score, d];
    }

    // ---------- Mode 1: Digging by the greedy algorithm ----------
    if (mode === "greedy") {
        const removed = new Set();
        let remaining = [...candidates];
        /* Record the 「historical hardest」 state each round: the greedy algorithm
         * leads to a locally optimized solution, and the difficulty may decrease
         * after further deletions, so ultimately return the deletion set with
         * the highest difficulty coefficient throughout the entire process. */
        const best = { score: -1, off: new Set(), d: null };
        let truncated = null;
        try {
            for (;;) {
                if (_cancelled()) throw new DigAbort();
                const feasible = [];
                for (const cell of remaining)
                    if (accept(new Set([...removed, cell])) === true) feasible.push(cell);
                if (!feasible.length) break;
                const scored = [];
                for (const cell of feasible) {
                    if (_cancelled()) throw new DigAbort();
                    const [s, d] = diff_eval(new Set([...removed, cell]));
                    scored.push([s, cell, d]);
                }
                scored.sort((a, b) => b[0] - a[0]);
                const [s, cell, d] = scored[0];
                removed.add(cell);
                remaining = remaining.filter(x => x !== cell);
                if (s > best.score) { best.score = s; best.off = new Set(removed); best.d = d; }
                _progress(`${removed.size}/${k} hints removed, current difficulty coefficient is ${s}, historical best is ${best.score}...`);
            }
        } catch (e) {
            if (e instanceof _CapReached) truncated = e.message;
            else throw e;
        }
        if (best.d === null)
            return { ok: false, msg: "No hints can be removed from the current board!",
                       checks: state.checks, evals: state.evals };
        const d = best.d;
        return { ok: true, removed: [...best.off].map(unRC).sort((a, b) => a[0] - b[0] || a[1] - b[1]),
                 score: d.score, level: d.level, guesses: d.guesses,
                 logical_solved: d.logical_solved,
                 checks: state.checks, evals: state.evals,
                 pruned: 0, max_removed: best.off.size, truncated };
    }

    // ---------- Mode 2: Complete Enumeration (Monotonicity pruning using DFS) ----------
    if (candidates.length > enum_limit)
        return { ok: false, msg: `${k} valid hints here, more than the upper limit ${enum_limit}!\nPlease use Greedy Mode or reduce hints first.` };
    const cand = [...candidates].sort();
    const best = { score: -1, off: null, d: null };
    const max_removed = { n: 0 };

    function dfs(idx, off) {
        /* off is a validated deletion set that maintains uniqueness; we attempt
         * to continue expanding it with cand[idx:] here. Only 'maximal deletion
         * sets' are involved in difficulty comparisons. */
        if (_cancelled()) throw new DigAbort();
        let extended = false;
        for (let j = idx; j < cand.length; j++) {
            const a = accept(new Set([...off, cand[j]]));
            if (a === true) {
                extended = true;
                dfs(j + 1, new Set([...off, cand[j]]));
            } else {
                // MULTIPLE SOLUTIONS or too large scale: cut all its hypersets off.
                state.pruned += (1 << (cand.length - j - 1)) - 1;
            }
        }
        if (!extended) {
            max_removed.n = Math.max(max_removed.n, off.size);
            const [s, d] = diff_eval(off);
            if (s > best.score) {
                best.score = s; best.off = new Set(off); best.d = d;
                _progress(`Enumarating: ${state.checks} subsets verified, historical best is ${s} (Delete ${off.size} hints)...`);
            }
        }
    }

    let truncated = null;
    try { dfs(0, new Set()); }
    catch (e) {
        if (e instanceof _CapReached) truncated = e.message;
        else throw e;
    }
    if (best.off === null)
        return { ok: false, msg: "No deletion founded after enumeration!" + (truncated ? `(${truncated})` : ""),
                   checks: state.checks, evals: state.evals };
    const d = best.d;
    return { ok: true, removed: [...best.off].map(unRC).sort((a, b) => a[0] - b[0] || a[1] - b[1]),
             score: d.score, level: d.level, guesses: d.guesses,
             logical_solved: d.logical_solved,
             checks: state.checks, evals: state.evals,
             pruned: state.pruned, max_removed: max_removed.n,
             aborted_unknown: state.aborted_unknown, truncated };
}

// Export for both browser window and Web Worker global scope
const _g = (typeof self !== "undefined") ? self : window;
Object.assign(_g, { WHITE, WALL, OUTSIDE, FILE_FORMAT, FILE_VERSION, RC, unRC,
                    Puzzle, Contradiction, Solver, LogicSolver,
                    DigAbort, dig_for_hardest });
