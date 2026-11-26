/* worker.js —— Akari Designer · Background Computation Worker
 * Runs the constraint solver / logic solver / 「Dig for Hard!」 off the main
 * thread, so the page never freezes on large boards. Cancel = terminate().
 */
"use strict";
importScripts("core.js");

function revivePuzzle(d) {
    return Puzzle.from_dict(d);
}

self.onmessage = function (e) {
    const { id, type } = e.data;
    try {
        if (type === "count") {
            // Count solutions (limit given), optionally on a 「judged view」
            const p = revivePuzzle(e.data.puzzle);
            const [sols, aborted] = new Solver(p, e.data.use_clues !== false)
                .count_solutions(e.data.limit || 2);
            self.postMessage({ id, kind: "done", sols, aborted });
        } else if (type === "difficulty") {
            const p = revivePuzzle(e.data.puzzle);
            const d = new LogicSolver(p).difficulty();
            self.postMessage({ id, kind: "done", result: d });
        } else if (type === "dig") {
            const p = revivePuzzle(e.data.puzzle);
            const res = dig_for_hardest(p, {
                mode: e.data.mode, enum_limit: e.data.enum_limit,
                logic_only: e.data.logic_only,
                on_progress: (t) => self.postMessage({ id, kind: "progress", text: t }),
            });
            self.postMessage({ id, kind: "done", result: res });
        }
    } catch (err) {
        self.postMessage({ id, kind: "error", error: String(err && err.message || err) });
    }
};
