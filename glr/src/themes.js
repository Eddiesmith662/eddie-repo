/*
 * Site themes: the look of every page, chosen on the Site settings page (admins). A theme is CSS variables and a few
 * extra rules layered on the base styles in index.js, plus how the header shows the league.
 *
 *   vspeed  the plain VSPEED look: the default for any league using the site
 *   glr     Goat Locker Racing: the GLR logo, black / white / GLR red, condensed italic headings like the GLR graphics
 *
 * To add a league's theme, add an entry here: label, vars (the colours), fonts (Google Fonts link or ""), css (extra
 * rules) and brand(short) (the header's left side). A light theme can add dark (rules under html.dark): visitors then
 * get a dark mode switch in the header.
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
    note: "Matches goatlockerracing.org: white pages, the black goat logo, Roboto headings, Poppins text and the site's monospace menu.",
    vars: "--bg:#ffffff;--card:#ffffff;--line:#e2e2e2;--text:#171717;--dim:#6f6f6f;--accent:#d7141a;--link:#b5121b",
    fonts: "https://fonts.googleapis.com/css2?family=Roboto:wght@500;600;700;800&family=Poppins:wght@400;500;600&family=JetBrains+Mono:wght@500;600&display=swap",
    css: `
:root{color-scheme:light}
body{font-family:Poppins,system-ui,Segoe UI,Arial,sans-serif;background:#f6f6f6}
header{background:#fff;border-bottom:1px solid var(--line);box-shadow:0 2px 10px rgba(0,0,0,.06);padding:8px 20px}
header .brand{display:flex;align-items:center;gap:12px}header .brand img{height:56px;width:auto;display:block}
header .brand b{font:600 13px/1 "JetBrains Mono",monospace;text-transform:uppercase;letter-spacing:-.04em;color:var(--dim)}
header .me{column-gap:0}
header .me a,header .me .tag,button.link{font:600 13px "JetBrains Mono",monospace;text-transform:uppercase;letter-spacing:-.04em;color:#33373d}
header .me > a,header .me > span,header .me > form{padding:0 9px;border-left:1px solid #d5d5d5}header .me > :first-child{border-left:0}
header .me a:hover{color:var(--accent)}
main{background:#fff;max-width:1040px;margin:24px auto;padding:24px 20px 48px;border:1px solid var(--line);border-radius:6px}
h1,h2,.card b,.wt b{font-family:Roboto,Arial,sans-serif;text-transform:uppercase}
h1{font-size:28px;font-weight:800;border-left-color:var(--accent)}h2{font-size:18px;font-weight:700}
.tabs a{font:600 13px "JetBrains Mono",monospace;text-transform:uppercase;letter-spacing:-.03em;color:#33373d}.tabs a.on{color:var(--text)}
th{font-family:"JetBrains Mono",monospace;letter-spacing:-.02em;color:#54595f;background:#fafafa}
.wrap{background:#fff}tr:hover td{background:#fafafa}
.card{background:#fff;color:var(--text)}.card:hover{border-color:#bdbdbd;box-shadow:0 2px 10px rgba(0,0,0,.06)}
.stat,.lead div{background:#fafafa}
.btn{font:600 14px Roboto,Arial,sans-serif;text-transform:uppercase;letter-spacing:.03em;border-radius:4px}
.btn.ghost{background:#33373d;color:#fff}
.cls{background:#ececec;color:#33373d}.prov{background:#fff3cd;color:#7a5a00}
.msg.ok{background:#eef8f0}.msg.bad{background:#fdeeee}
.seg2 button.on{background:#ececec;color:var(--text)}
select,input[type=number],input[type=date],input[type=time],input[type=text],textarea{color-scheme:light}
.grid-r td.d{background:#fff}.grid-r .w{background:#ffe08a;color:#5a4300}.grid-r .t5{background:#d9f2df}.grid-r .t10{background:#dde9f8}.grid-r .dnf{color:#c62828}
.st{color:#a15c00}.st.good{color:#1e7d36}.st.bad{color:#c62828}
code.key{background:#f3f3f3;color:var(--text)}
header .me{order:1}.mode{order:2;margin-left:16px;flex:none;position:relative;width:48px;height:26px;border-radius:13px;border:0;padding:0;cursor:pointer;background:#e2e2e2;transition:background .2s}
.mode .knob{position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:#fff;color:#d7141a;box-shadow:0 1px 3px rgba(0,0,0,.25);display:grid;place-items:center;transition:transform .2s}
.mode svg{width:13px;height:13px;fill:currentColor;stroke:currentColor;stroke-width:2;stroke-linecap:round}.mode svg:last-child{display:none;stroke:none}
.mode:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
@media (max-width:640px){.mode{order:0;margin-left:auto}header .me{width:100%}main{margin:0;border:0;border-radius:0;padding:18px 16px 40px}header .brand img{height:44px}header .me > a,header .me > span,header .me > form{padding:0 6px}}`,
    // dark mode: only when the visitor turns it on with the switch in the header (remembered in a cookie)
    dark: `
html.dark{color-scheme:dark;--bg:#121214;--card:#1b1b1e;--line:#2e2e33;--text:#ececec;--dim:#a2a2a9;--accent:#e5262c;--link:#ff7a7f}
html.dark body{background:#121214}
html.dark header,html.dark main,html.dark .wrap,html.dark .card,html.dark .grid-r td.d{background:#1b1b1e}
html.dark header,html.dark .card:hover{box-shadow:0 2px 10px rgba(0,0,0,.4)}
html.dark header .me a,html.dark header .me .tag,html.dark button.link,html.dark .tabs a{color:#cfcfd4}
html.dark header .me > a,html.dark header .me > span,html.dark header .me > form{border-left-color:#3a3a40}
html.dark th,html.dark .stat,html.dark .lead div,html.dark tr:hover td{background:#222226}html.dark th{color:#a9a9b0}
html.dark .card:hover{border-color:#4a4a50}
html.dark .btn.ghost{background:#e6e6e6;color:#141414}
html.dark .cls,html.dark .seg2 button.on,html.dark code.key{background:#2a2a2f;color:#e2e2e6}
html.dark .prov{background:#3a2f0c;color:#ffd76a}
html.dark .msg.ok{background:#14301d}html.dark .msg.bad{background:#3a1616}
html.dark select,html.dark input,html.dark textarea{color-scheme:dark}
html.dark .grid-r .w{background:#5a4600;color:#ffe08a}html.dark .grid-r .t5{background:#173a22}html.dark .grid-r .t10{background:#1a2c45}html.dark .grid-r .dnf{color:#ff6b6b}
html.dark .st{color:#e3a54a}html.dark .st.good{color:#4cc36a}html.dark .st.bad{color:#ff6b6b}
header .brand img.on-dark,html.dark header .brand img.on-light{display:none}html.dark header .brand img.on-dark{display:block}
html.dark .mode{background:#3a3a40}html.dark .mode .knob{transform:translateX(22px);background:#121214;color:#ffd76a}
html.dark .mode svg:first-child{display:none}html.dark .mode svg:last-child{display:block}`,
    brand: () => `<img class="on-light" src="${BASE}/theme/glr-logo.png" alt="Goat Locker Racing" width="93" height="56"><img class="on-dark" src="${BASE}/theme/glr-logo-dark.png" alt="Goat Locker Racing" width="93" height="56"><b>Results &amp; standings</b>`,
  },
};

export const DEFAULT_THEME = "vspeed";
export const themeOf = name => THEMES[name] ? name : DEFAULT_THEME;
