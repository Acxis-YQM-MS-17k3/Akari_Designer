/* imageio.js —— Akari Designer · Puzzle Graph I/O Layer (Web port of akari_pngio.py)
 * Graph output in PNG/BMP (following the current theme and display settings)
 * and graph recognition & import in PNG/BMP (fully supports graphs output by
 * this software: walls/holes/clues with their valid states/lights are
 * restored; graphs from other sources are recognized on a best-effort basis).
 */
"use strict";

const FONT5x7 = {   // 5×7 dot-matrix digit font
    '0': ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
    '1': ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
    '2': ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
    '3': ["11111", "00010", "00100", "00010", "00001", "10001", "01110"],
    '4': ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
};

// ============================================================
// Graph Output (PNG via canvas; BMP via manual 24-bit encoder)
// ============================================================

function export_puzzle_image(puzzle, { cell = 40, show_lights = false, format = "png" } = {}) {
    /* Render the puzzle area onto an offscreen canvas. show_lights=false
     * outputs the pure puzzle (no lights); true outputs the current board
     * (lights and lighted ranges included). Digits are drawn with the same
     * 5×7 dot-matrix font as the desktop version, so graphs stay
     * re-importable. Return a Blob. */
    const w = puzzle.cols * cell + 1, h = puzzle.rows * cell + 1;
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    const ctx = cv.getContext("2d");
    ctx.fillStyle = C("bg");
    ctx.fillRect(0, 0, w, h);
    const lit = show_lights ? puzzle.lit_info() : new Map();
    for (let r = 0; r < puzzle.rows; r++) {
        for (let c = 0; c < puzzle.cols; c++) {
            const x0 = c * cell, y0 = r * cell;
            const t = puzzle.grid[r][c];
            let color;
            if (t === OUTSIDE) color = C("outside");
            else if (t === WALL) color = C("wall");
            else {
                const n = lit.get(RC(r, c)) || 0;
                color = n >= 2 ? C("lit2") : (n === 1 ? C("lit1") : C("unlit"));
            }
            ctx.fillStyle = color;
            ctx.fillRect(x0, y0, cell, cell);
            if (t === WALL && puzzle.clues.has(RC(r, c))) {
                const active = puzzle.clue_active.get(RC(r, c)) !== false;
                if (!active && S.hide_inactive_clues) continue;
                ctx.fillStyle = active ? C("clue") : C("clueoff");
                _draw_digit(ctx, String(puzzle.clues.get(RC(r, c))),
                            x0 + Math.floor(cell / 2), y0 + Math.floor(cell / 2),
                            Math.max(1, Math.floor(cell / 14)));
            }
        }
    }
    if (show_lights) {
        for (const key of puzzle.lights) {
            const [r, c] = unRC(key);
            const cx = c * cell + Math.floor(cell / 2), cy = r * cell + Math.floor(cell / 2);
            const rad = Math.floor(cell / 3);
            ctx.beginPath();
            ctx.arc(cx, cy, rad, 0, Math.PI * 2);
            ctx.fillStyle = C("bulb");
            ctx.fill();
            ctx.lineWidth = Math.max(1, Math.floor(cell / 20));
            ctx.strokeStyle = C("bulb_edge");
            ctx.stroke();
        }
    }
    ctx.fillStyle = C("grid");          // grid lines
    for (let x = 0; x < w; x += cell) ctx.fillRect(x, 0, 1, h);
    for (let y = 0; y < h; y += cell) ctx.fillRect(0, y, w, 1);

    if (format === "bmp") return _canvas_to_bmp(cv);
    return new Promise((resolve) => cv.toBlob((b) => resolve(b), "image/png"));
}

function _draw_digit(ctx, ch, cx, cy, scale) {
    const glyph = FONT5x7[ch];
    if (!glyph) return;
    const w = 5 * scale, h = 7 * scale;
    const x0 = cx - Math.floor(w / 2), y0 = cy - Math.floor(h / 2);
    for (let gy = 0; gy < 7; gy++)
        for (let gx = 0; gx < 5; gx++)
            if (glyph[gy][gx] === '1')
                ctx.fillRect(x0 + gx * scale, y0 + gy * scale, scale, scale);
}

function _canvas_to_bmp(cv) {
    /* Encode an uncompressed 24-bit BMP (bottom-up row order,
     * each row padded to a multiple of 4 bytes). */
    const w = cv.width, h = cv.height;
    const data = cv.getContext("2d").getImageData(0, 0, w, h).data;
    const stride = Math.floor((w * 3 + 3) / 4) * 4;
    const imgSize = stride * h;
    const buf = new ArrayBuffer(54 + imgSize);
    const dv = new DataView(buf);
    dv.setUint8(0, 0x42); dv.setUint8(1, 0x4D);            // "BM"
    dv.setUint32(2, 54 + imgSize, true);
    dv.setUint32(10, 54, true);                            // pixel data offset
    dv.setUint32(14, 40, true);                            // header size
    dv.setInt32(18, w, true); dv.setInt32(22, h, true);
    dv.setUint16(26, 1, true);                             // planes
    dv.setUint16(28, 24, true);                            // bpp
    dv.setUint32(34, imgSize, true);
    dv.setInt32(38, 2835, true); dv.setInt32(42, 2835, true);
    const out = new Uint8Array(buf);
    for (let y = 0; y < h; y++) {
        const srcY = h - 1 - y;
        let i = 54 + y * stride;
        for (let x = 0; x < w; x++) {
            const j = (srcY * w + x) * 4;
            out[i] = data[j + 2]; out[i + 1] = data[j + 1]; out[i + 2] = data[j]; // BGR
            i += 3;
        }
    }
    return Promise.resolve(new Blob([buf], { type: "image/bmp" }));
}

// ============================================================
// Graph Reading & Puzzle Graph Recognition/Import
// ============================================================

async function read_image(file) {
    /* Read a graph file into {w, h, rgb(Uint8Array)}. PNG/JPG etc. are decoded
     * by the browser; BMP additionally falls back to a manual decoder
     * (uncompressed 24/32-bit) for browsers without BMP support. */
    const buf = new Uint8Array(await file.arrayBuffer());
    const isBmp = buf[0] === 0x42 && buf[1] === 0x4D;
    if (!isBmp) {
        try {
            const bmp = await createImageBitmap(new Blob([buf]));
            const cv = document.createElement("canvas");
            cv.width = bmp.width; cv.height = bmp.height;
            const ctx = cv.getContext("2d");
            ctx.fillStyle = "#FFFFFF";                     // composite alpha onto white
            ctx.fillRect(0, 0, cv.width, cv.height);
            ctx.drawImage(bmp, 0, 0);
            const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
            const rgb = new Uint8Array(cv.width * cv.height * 3);
            for (let i = 0; i < cv.width * cv.height; i++) {
                rgb[3 * i] = d[4 * i]; rgb[3 * i + 1] = d[4 * i + 1]; rgb[3 * i + 2] = d[4 * i + 2];
            }
            return { w: cv.width, h: cv.height, rgb };
        } catch (e) {
            throw new Error("This graph cannot be decoded (Supported: PNG / BMP).");
        }
    }
    return read_bmp(buf);
}

function read_bmp(data) {
    /* Read a BMP into {w, h, rgb}. Supports uncompressed (BI_RGB) 24-bit /
     * 32-bit BMP, both bottom-up and top-down row orders. */
    if (data.length < 54 || data[0] !== 0x42 || data[1] !== 0x4D)
        throw new Error("This is not a BMP graph.");
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const offset = dv.getUint32(10, true);
    const headerSize = dv.getUint32(14, true);
    if (headerSize < 40) throw new Error("Unsupported BMP header (Too old version).");
    const w = dv.getInt32(18, true);
    let h = dv.getInt32(22, true);
    const planes = dv.getUint16(26, true), bpp = dv.getUint16(28, true);
    const comp = dv.getUint32(30, true);
    if (planes !== 1 || comp !== 0 || ![24, 32].includes(bpp))
        throw new Error("Only uncompressed 24-bit / 32-bit BMP is supported.");
    const topDown = h < 0;
    h = Math.abs(h);
    if (w <= 0 || h <= 0) throw new Error("Illegal BMP size.");
    const stride = Math.floor((w * bpp / 8 + 3) / 4) * 4;
    if (offset + stride * h > data.length)
        throw new Error("The BMP data is too short; the file may be broken.");
    const rgb = new Uint8Array(w * h * 3);
    for (let y = 0; y < h; y++) {
        const srcY = topDown ? y : h - 1 - y;
        const base = offset + srcY * stride;
        for (let x = 0; x < w; x++) {
            const i = base + x * (bpp / 8);
            const j = (y * w + x) * 3;
            rgb[j] = data[i + 2]; rgb[j + 1] = data[i + 1]; rgb[j + 2] = data[i];
        }
    }
    return { w, h, rgb };
}

function _dist2(c1, c2) {
    return (c1[0] - c2[0]) ** 2 + (c1[1] - c2[1]) ** 2 + (c1[2] - c2[2]) ** 2;
}

function _import_palettes() {
    /* Collect the color tables for recognition: (current customized values ∪
     * default values) of both themes. */
    const cellColors = [], clueColors = [], bulbColors = [];
    const seenCell = new Set(), seenClue = new Set();
    for (const theme of ["light", "dark"]) {
        for (const source of [S.colors[theme], THEMES[theme]]) {
            for (const [key, sem] of [["unlit", WHITE], ["lit1", WHITE], ["lit2", WHITE],
                                      ["wall", WALL], ["outside", OUTSIDE], ["bg", "BG"]]) {
                const rgb = hex2rgb(source[key]);
                const sig = rgb.join(",") + "|" + sem;
                if (!seenCell.has(sig)) { seenCell.add(sig); cellColors.push([rgb, sem]); }
            }
            for (const [key, off] of [["clue", false], ["clueoff", true]]) {
                const rgb = hex2rgb(source[key]);
                const sig = rgb.join(",") + "|" + off;
                if (!seenClue.has(sig)) { seenClue.add(sig); clueColors.push([rgb, off]); }
            }
            const rgb = hex2rgb(source.bulb);
            if (!bulbColors.some(b => b.join() === rgb.join())) bulbColors.push(rgb);
        }
    }
    return [cellColors, clueColors, bulbColors];
}

function _glyph_bitmap(ch, s) {
    /* Magnify a 5×7 dot-matrix character by s times, return a boolean matrix. */
    const rows = FONT5x7[ch];
    const out = [];
    for (let y = 0; y < 7 * s; y++) {
        const row = [];
        for (let x = 0; x < 5 * s; x++) row.push(rows[Math.floor(y / s)][Math.floor(x / s)] === "1");
        out.push(row);
    }
    return out;
}

function _bbox(bmp) {
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
    for (let y = 0; y < bmp.length; y++)
        for (let x = 0; x < bmp[0].length; x++)
            if (bmp[y][x]) {
                x0 = Math.min(x0, x); y0 = Math.min(y0, y);
                x1 = Math.max(x1, x); y1 = Math.max(y1, y);
            }
    if (x1 < 0) return null;
    return [x0, y0, x1 + 1, y1 + 1];
}

function _crop(bmp, [x0, y0, x1, y1]) {
    return bmp.slice(y0, y1).map(row => row.slice(x0, x1));
}

function _resize_bool(bmp, tw, th) {
    /* Nearest-neighbor scaling of a boolean matrix to tw×th. */
    const h = bmp.length, w = bmp[0].length;
    const out = [];
    for (let y = 0; y < th; y++) {
        const row = [];
        for (let x = 0; x < tw; x++)
            row.push(bmp[Math.min(h - 1, Math.floor(y * h / th))][Math.min(w - 1, Math.floor(x * w / tw))]);
        out.push(row);
    }
    return out;
}

function _match_score(a, b) {
    let same = 0;
    for (let y = 0; y < a.length; y++)
        for (let x = 0; x < a[0].length; x++)
            if (a[y][x] === b[y][x]) same++;
    return same / (a.length * a[0].length);
}

async function import_puzzle_image(file, max_dim = 60) {
    /* Restore a puzzle from a graph (PNG or BMP).
     * Return [Puzzle, recognition statistics]. */
    const { w, h, rgb } = await read_image(file);
    const px = (x, y) => {
        const i = (y * w + x) * 3;
        return [rgb[i], rgb[i + 1], rgb[i + 2]];
    };

    // ---- 1. Find the grid lines: whole columns/rows in the same color as the top-left pixel ----
    const lineColor = px(0, 0);
    const _lines = (length, scan, vertical) => {
        const pos = [];
        let runStart = null;
        for (let i = 0; i < length; i++) {
            let hits = 0;
            for (let j = 0; j < scan; j += 4) {
                const c = vertical ? px(i, j) : px(j, i);
                if (_dist2(c, lineColor) < 30) hits++;
            }
            if (hits * 4 >= scan * 0.85) {
                if (runStart === null) runStart = i;
            } else if (runStart !== null) {
                pos.push(runStart);
                runStart = null;
            }
        }
        if (runStart !== null) pos.push(runStart);
        return pos;
    };
    const xs = _lines(w, h, true);
    const ys = _lines(h, w, false);
    if (xs.length < 3 || ys.length < 3)
        throw new Error("No board grid can be recognized in the graph (No through grid lines found). " +
                        "Please confirm that the imported graph is output by this software.");
    const dxs = xs.slice(1).map((b, i) => b - xs[i]);
    const dys = ys.slice(1).map((b, i) => b - ys[i]);
    const cell = Math.round([...dxs].sort((a, b) => a - b)[Math.floor(dxs.length / 2)]);
    const cellY = Math.round([...dys].sort((a, b) => a - b)[Math.floor(dys.length / 2)]);
    if (Math.abs(cell - cellY) > 1 || dxs.some(d => Math.abs(d - cell) > 1)
        || dys.some(d => Math.abs(d - cellY) > 1))
        throw new Error("The grid spacing is uneven; cannot be recognized as an Akari puzzle graph.");
    const cols = dxs.length, rows = dys.length;
    if (!(rows >= 2 && rows <= max_dim && cols >= 2 && cols <= max_dim))
        throw new Error(`The recognized board is ${rows} × ${cols}, out of the allowed range.`);

    const [cellColors, clueColors, bulbColors] = _import_palettes();
    const nearest = (rgbv, table) => {
        let best = table[0], bd = Infinity;
        for (const t of table) {
            const d = _dist2(rgbv, t[0]);
            if (d < bd) { bd = d; best = t; }
        }
        return best;
    };

    // ---- 2. Recognize the type of each cell ----
    const p = new Puzzle(rows, cols);
    let uncertain = 0;
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const cx = xs[c] + Math.floor(cell / 2), cy = ys[r] + Math.floor(cell / 2);
            const samples = [px(cx, cy), px(xs[c] + Math.floor(cell / 4), cy),
                             px(xs[c] + Math.floor(3 * cell / 4), cy)];
            const votes = new Map();
            for (const sv of samples) {
                const [rgbv, sem] = nearest(sv, cellColors);
                votes.set(sem, (votes.get(sem) || 0) + 1);
                if (_dist2(sv, rgbv) > 120 * 120) uncertain++;
            }
            let sem = [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0];
            if (sem === "BG") sem = WHITE;
            p.grid[r][c] = sem;
        }
    }

    // ---- 3. Recognize the lights (bulb-colored circles at the centers of Not Wall cells) ----
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            if (p.grid[r][c] !== WHITE) continue;
            const x0 = xs[c], y0 = ys[r];
            let hits = 0, total = 0;
            for (let yy = y0 + 2; yy < y0 + cell - 1; yy += 2) {
                for (let xx = x0 + 2; xx < x0 + cell - 1; xx += 2) {
                    total++;
                    if (Math.min(...bulbColors.map(bc => _dist2(px(xx, yy), bc))) < 70 * 70) hits++;
                }
            }
            if (total && hits / total > 0.12) p.lights.add(RC(r, c));
        }
    }

    // ---- 4. Recognize the clues (dot-matrix digits at the centers of wall cells) ----
    let clueFound = 0, clueDim = 0;
    const scale = Math.max(1, Math.round(cell / 14));
    const templates = {};
    for (const ch of "01234") {
        const bmp = _glyph_bitmap(ch, scale);
        templates[ch] = _crop(bmp, _bbox(bmp));
    }
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            if (p.grid[r][c] !== WALL) continue;
            const x0 = xs[c], y0 = ys[r];
            const wallRgb = nearest(px(x0 + Math.floor(cell / 2), y0 + 3), cellColors)[0];
            const mask = [];
            const cluePix = [];
            for (let yy = y0 + 1; yy < y0 + cell; yy++) {
                const row = [];
                for (let xx = x0 + 1; xx < x0 + cell; xx++) {
                    const v = px(xx, yy);
                    let dClue = Infinity, cref = null;
                    for (const [crgb, off] of clueColors) {
                        const d = _dist2(v, crgb);
                        if (d < dClue) { dClue = d; cref = [crgb, off]; }
                    }
                    const isClue = dClue < 80 * 80 && dClue < _dist2(v, wallRgb);
                    row.push(isClue);
                    if (isClue) cluePix.push(v);
                }
                mask.push(row);
            }
            if (cluePix.length < 5) continue;        // a wall without a clue
            const box = _bbox(mask);
            if (box === null) continue;
            const crop = _crop(mask, box);
            const bh = crop.length, bw = crop[0].length;
            let best = null, bestScore = 0;
            for (const [ch, tbmp] of Object.entries(templates)) {
                const th = tbmp.length, tw = tbmp[0].length;
                if (Math.abs(bw / tw - bh / th) > 0.6) continue;  // aspect ratio mismatched
                const score = _match_score(_resize_bool(crop, tw, th), tbmp);
                if (score > bestScore) { best = ch; bestScore = score; }
            }
            if (best === null || bestScore < 0.72) {
                clueDim++;
                continue;   // traces exist but cannot be recognized → treated as a clueless wall
            }
            p.clues.set(RC(r, c), parseInt(best));
            // Valid state: compare the average color of the digit pixels
            const n = cluePix.length;
            const avg = [0, 1, 2].map(i => Math.floor(cluePix.reduce((s, v) => s + v[i], 0) / n));
            const dOn = Math.min(...clueColors.filter(([, off]) => !off).map(([crgb]) => _dist2(avg, crgb)));
            const dOff = Math.min(...clueColors.filter(([, off]) => off).map(([crgb]) => _dist2(avg, crgb)));
            p.clue_active.set(RC(r, c), dOn <= dOff);
            clueFound++;
        }
    }

    const stats = { rows, cols, cell, clues: clueFound, lights: p.lights.size,
                    uncertain, dim: clueDim };
    return [p, stats];
}
