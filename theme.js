/* theme.js —— Akari Designer · Theme & Global Settings Layer (Web port of akari_theme.py)
 * Theme colors, global display settings (persisted into localStorage),
 * program version, color tools.
 */
"use strict";

// Element color keys → Displayed names
// (Listed in the Settings dialog box, can be customized one by one)
const COLOR_KEYS = [
    ["bg",        "Canvas Background"],
    ["unlit",     "Unlighted Cell"],
    ["wall",      "Wall"],
    ["lit1",      "Lighted-Once Cell"],
    ["lit2",      "Lighted-Twice Cell"],
    ["outside",   "Hole"],
    ["bulb",      "Light"],
    ["bulb_edge", "Light Edge"],
    ["grid",      "Grid Line"],
    ["clue",      "Clue"],
    ["clueoff",   "Clue(Paler)"],
    ["mark",      "\"×\" Mark"],
    ["bad",       "Warning"],
];

// Themes: DAY / NIGHT
const THEMES = {
    light: {
        bg: "#FFFFFF", unlit: "#FFFFFF",
        lit1: "#FFF3B0", lit2: "#FFE49A",
        wall: "#263238", outside: "#9E9E9E",
        bulb: "#FFD600", bulb_edge: "#8D6E00",
        grid: "#424242", clue: "#FFFFFF", clueoff: "#757575",
        mark: "#546E7A", bad: "#FF5252",
        sb_trough: "#D9D9D9", sb_thumb: "#7F7F7F", sb_active: "#4A4A4A",
    },
    dark: {
        bg: "#161616", unlit: "#232323",
        lit1: "#8C7A2B", lit2: "#9B862E",
        wall: "#E8E8E8", outside: "#4A4A4A",
        bulb: "#FFD600", bulb_edge: "#8D6E00",
        grid: "#9E9E9E", clue: "#1A1A1A", clueoff: "#7A7A7A",
        mark: "#90A4AE", bad: "#FF5252",
        sb_trough: "#2C2C2C", sb_thumb: "#9A9A9A", sb_active: "#D0D0D0",
    },
};

const FLASH_RED = "#FF8A80";      // Soft red for conflict flashing
const FLASH_GOOD = "#C8E6C9";     // Light green for completion celebration
const FLASH_GOLD = "#FFE082";     // Gold for completion celebration

const APP_VERSION = "1.2.0_WEB";  // Web Edition, based on v1.2.0_ENG

const SETTINGS_KEY = "akari_settings";

const S = {                       // Global settings (Shared by all canvases and graph output)
    theme: "light",
    hide_lit_marks: false,        // Hide 「×」 marks on lighted cells
    hide_inactive_clues: false,   // Hide clues not used as conditions (Instead of being fainter)
    red_unsatisfied: false,       // Mark unfulfilled clues in red in Test Mode
    clue_countdown: false,        // Clues show the remaining number in Test Mode
    ext_library_dir: "",          // (Web) name of the External Bank folder handle
    // Recounting strategy of clues under 「Lights First」:
    //   ask  = Ask first when manually set clues would be covered (Default)
    //   auto = Always silently recount; keep = Never recount
    clue_recalc: "ask",
    // Whether determination ① also counts fainter (hidden) clues as conditions
    judge_include_hidden: false,
    colors: JSON.parse(JSON.stringify(THEMES)),
};

function C(key) {                 // Get the color of an element under the current theme
    return S.colors[S.theme][key];
}

function load_settings() {
    let d;
    try { d = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null"); }
    catch (e) { return; }
    if (!d) return;
    if (d.theme in THEMES) S.theme = d.theme;
    for (const k of ["hide_lit_marks", "hide_inactive_clues", "red_unsatisfied",
                     "clue_countdown", "judge_include_hidden"])
        if (typeof d[k] === "boolean") S[k] = d[k];
    if (typeof d.ext_library_dir === "string") S.ext_library_dir = d.ext_library_dir;
    if (["ask", "auto", "keep"].includes(d.clue_recalc)) S.clue_recalc = d.clue_recalc;
    for (const [theme, colors] of Object.entries(d.colors || {}))
        if (theme in THEMES)
            for (const [k, v] of Object.entries(colors))
                if (k in THEMES[theme] && typeof v === "string"
                    && v.startsWith("#") && v.length === 7)
                    S.colors[theme][k] = v;
}

function save_settings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(S)); } catch (e) { /* ignore */ }
}

function hex2rgb(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }

function color_distance(h1, h2) {
    /* Weighted Euclidean distance of two #RRGGBB colors
     * (Approximating human perception; green weighs the most). */
    const [r1, g1, b1] = hex2rgb(h1), [r2, g2, b2] = hex2rgb(h2);
    return Math.sqrt(2 * (r1 - r2) ** 2 + 4 * (g1 - g2) ** 2 + 3 * (b1 - b2) ** 2);
}

// Color conflict check pairs: combinations of elements that adjoin on the
// screen and need to be distinguished
const COLOR_CONFLICT_PAIRS = [
    ["unlit", "lit1"], ["unlit", "lit2"], ["lit1", "lit2"],
    ["unlit", "wall"], ["lit1", "wall"], ["lit2", "wall"],
    ["unlit", "outside"], ["wall", "outside"],
    ["wall", "clue"], ["wall", "clueoff"],
    ["lit1", "bulb"], ["lit2", "bulb"], ["unlit", "bulb"],
    ["unlit", "mark"], ["lit1", "mark"],
];
const COLOR_TOO_CLOSE = 55;       // A distance below this value is regarded as 「too close」

function color_conflicts(key, color) {
    /* Check which elements of the current theme are too close to color
     * when key is set to color. Return [[conflicting key, distance], …] */
    const theme = S.colors[S.theme];
    const out = [];
    for (const [a, b] of COLOR_CONFLICT_PAIRS) {
        let other = null;
        if (key === a) other = b;
        else if (key === b) other = a;
        else continue;
        const d = color_distance(color, theme[other]);
        if (d < COLOR_TOO_CLOSE) out.push([other, d]);
    }
    return out;
}
