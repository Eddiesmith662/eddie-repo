/*
 * Site themes: the look of every page, chosen on the Site settings page (admins). A theme is CSS variables and a few
 * extra rules layered on the base styles in index.js, plus how the header shows the league.
 *
 *   vspeed  the plain VSPEED look: the default for any league using the site
 *   glr     Goat Locker Racing: the GLR logo, black / white / GLR red, condensed italic headings like the GLR graphics
 *
 * To add a league's theme, add an entry here: label, vars (the colours), fonts (Google Fonts link or ""), css (extra
 * rules) and brand(short) (the header's left side).
 */
const BASE = "/glr";

export const THEMES = {
  vspeed: {
    label: "VSPEED",
    note: "The standard VSPEED look. The default for other leagues.",
    vars: "--bg:#141416;--card:#1d1d21;--line:#2c2c32;--text:#eee;--dim:#9a9aa3;--accent:#FF0D40;--link:#7fb6ff",
    fonts: "",
    css: "",
    brand: short => `VSPEED <span>${short}</span>`,
  },
  glr: {
    label: "Goat Locker Racing",
    note: "GLR's own look: the goat logo, black, white and GLR red, with headings in the style of the GLR graphics.",
    vars: "--bg:#0c0c0c;--card:#161616;--line:#2a2a2a;--text:#f2f2f2;--dim:#a3a3a3;--accent:#e31b1b;--link:#ff6b6b",
    fonts: "https://fonts.googleapis.com/css2?family=Barlow+Condensed:ital,wght@0,600;0,800;1,800;1,900&family=Barlow:wght@400;600&display=swap",
    css: `
body{font-family:Barlow,system-ui,Segoe UI,Arial,sans-serif;background:var(--bg) radial-gradient(rgba(255,255,255,.035) 1px,transparent 1px) 0 0/6px 6px}
header{background:#000;border-bottom:3px solid var(--accent);padding:6px 16px}
header .brand{display:flex;align-items:center;gap:10px}header .brand img{height:48px;width:auto;display:block}
header .brand b{font:italic 900 20px/1 "Barlow Condensed",sans-serif;letter-spacing:.02em;text-transform:uppercase;color:#fff}
header .me a,header .me .tag,button.link{font-family:"Barlow Condensed",sans-serif;font-weight:600;font-size:16px;text-transform:uppercase;letter-spacing:.03em}
header .me a{color:#fff}header .me a:hover{color:var(--link)}
h1{font:italic 900 34px/1.05 "Barlow Condensed",sans-serif;text-transform:uppercase;letter-spacing:.01em;border-left:0;padding:4px 18px 4px 14px;
  display:inline-block;background:var(--accent);color:#fff;transform:skewX(-6deg);box-shadow:4px 4px 0 #000}
h2{font:italic 800 22px/1.2 "Barlow Condensed",sans-serif;text-transform:uppercase;letter-spacing:.02em}
.sub{padding-left:2px;margin-top:8px}.crumb{padding-left:2px}
th{font-family:"Barlow Condensed",sans-serif;font-size:13px;letter-spacing:.06em}
.tabs a{font:italic 800 17px "Barlow Condensed",sans-serif;text-transform:uppercase;letter-spacing:.02em}
.card b{font:italic 900 24px "Barlow Condensed",sans-serif;text-transform:uppercase;border-left-width:4px}
.stat b,.lead b{font-family:"Barlow Condensed",sans-serif;font-weight:800;font-size:24px}
.btn{font:italic 800 17px "Barlow Condensed",sans-serif;text-transform:uppercase;letter-spacing:.03em;border-radius:3px}
.cls{background:#2a2a2a}`,
    brand: () => `<img src="${BASE}/theme/glr-logo.png" alt="Goat Locker Racing" width="80" height="48"><b>Results &amp; standings</b>`,
  },
};

export const DEFAULT_THEME = "vspeed";
export const themeOf = name => THEMES[name] ? name : DEFAULT_THEME;
