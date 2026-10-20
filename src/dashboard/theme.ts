/**
 * Dashboard design system. LIGHT ONLY by design (the client wants a white dashboard; it deliberately ignores a dark
 * operating-system setting). Colors come from the validated data-viz palette: chart blue and critical red pass the
 * six checks on the #fcfcfb surface (worst colour-blind separation dE 23.8), status colours always ship with an icon
 * and a label, and text never wears a series colour.
 *
 * Layout idea: a pale-blue hero band carries one big number and the 14-day chart; everything below sits on a soft
 * grey-blue plane as white panels, separated by hairlines rather than shadows.
 */
const BASE = `
:root{
  color-scheme:light;
  --plane:#f2f5f9;--surface:#fcfcfb;
  /* Brand accent: buttons, links, active menu, hero. Set per deployment (BRAND_COLOR); the data colours below never change. */
  --brand:#2a78d6;--brand-deep:#184f95;--brand-wash:#e9f1fb;--brand-line:#cfe0f5;
  --wash:var(--brand-wash);--wash-line:var(--brand-line);
  --ink:#0b0b0b;--ink2:#52514e;--muted:#898781;
  --line:#e3e5e8;--grid:#e1e0d9;--axis:#c3c2b7;
  --blue:#2a78d6;--blue-deep:#184f95;--blue-soft:#b7d3f6;--blue-wash:#e9f1fb;
  --good:#0ca30c;--good-text:#006300;--warn:#fab219;--serious:#ec835a;--crit:#d03b3b;--neutral:#898781;
  --h0:#eeede8;--h1:#cde2fb;--h2:#9ec5f4;--h3:#6da7ec;--h4:#3987e5;--h5:#256abf;--h6:#184f95;
  --radius:14px;--radius-sm:8px;
  --font:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--plane);color:var(--ink);font:15px/1.55 var(--font);-webkit-font-smoothing:antialiased}
a{color:var(--brand-deep);text-decoration:none}a:hover{text-decoration:underline}
a:focus-visible,button:focus-visible,[tabindex]:focus-visible,summary:focus-visible{outline:2px solid var(--brand);outline-offset:2px;border-radius:4px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.num{font-variant-numeric:tabular-nums}

/* ---------- top bar ---------- */
.top{background:var(--surface);border-bottom:1px solid var(--line)}
.top .in{max-width:1180px;margin:0 auto;padding:0 24px;height:60px;display:flex;align-items:center;gap:28px}
.brand{display:flex;align-items:center;gap:10px;font-weight:650;letter-spacing:-.01em;font-size:16px;color:var(--ink)}
.brand:hover{text-decoration:none}
.brand .mark{width:26px;height:26px;border-radius:7px;background:var(--brand);display:grid;place-items:center}
.brand small{font-weight:400;color:var(--ink2);font-size:14px}
.top nav{display:flex;gap:2px;align-self:stretch}
.top nav a{display:flex;align-items:center;padding:0 14px;color:var(--ink2);border-bottom:2px solid transparent;margin-bottom:-1px;font-weight:500}
.top nav a:hover{color:var(--ink);text-decoration:none}
.top nav a.on{color:var(--ink);border-bottom-color:var(--brand)}
.top .right{margin-left:auto;display:flex;align-items:center;gap:14px}
.live{display:inline-flex;align-items:center;gap:8px;font-size:13px;color:var(--ink2)}
.dot{width:9px;height:9px;border-radius:50%;background:var(--good);position:relative}
.dot.bad{background:var(--crit)}.dot.warn{background:var(--warn)}
.dot.ok:after{content:"";position:absolute;inset:-4px;border-radius:50%;border:2px solid var(--good);opacity:.0;animation:ping 2.4s ease-out infinite}
button.quiet{background:none;border:0;color:var(--ink2);font:inherit;cursor:pointer;padding:6px 8px;border-radius:6px}
button.quiet:hover{background:var(--plane);color:var(--ink)}
.banner{background:#fdf0cf;border-bottom:1px solid #f1d98f;color:#5a3d06;text-align:center;padding:8px 24px;font-size:14px}
.banner.bad{background:#fbe5e3;border-color:#efb7b3;color:#7c1d1a}
.banner a{font-weight:600;color:inherit;text-decoration:underline}
.ribbon{background:var(--ink);color:#fff;text-align:center;padding:6px;font-size:13px;letter-spacing:.02em}

/* ---------- hero ---------- */
.hero{background:var(--wash);border-bottom:1px solid var(--wash-line)}
.hero .in{max-width:1180px;margin:0 auto;padding:34px 24px 38px;display:grid;grid-template-columns:minmax(0,5fr) minmax(0,7fr);gap:36px;align-items:stretch}
.eyebrow{font-size:12px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:var(--ink2)}
.hello{font-size:15px;color:var(--ink2);margin:0 0 4px}
.hero h1{font-size:30px;line-height:1.15;letter-spacing:-.02em;margin:0 0 6px;font-weight:650}
.lede{color:var(--ink2);margin:0 0 24px;max-width:46ch}
.bignum{font-size:76px;line-height:1;letter-spacing:-.04em;font-weight:650;color:var(--brand-deep);margin:6px 0 6px}
.bignum small{font-size:28px;letter-spacing:-.02em;font-weight:600;margin-left:4px}
.equiv{color:var(--ink2);max-width:40ch}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:18px}
.chip{display:inline-flex;align-items:center;gap:7px;padding:5px 12px;border-radius:999px;background:var(--surface);border:1px solid var(--wash-line);font-size:13px;color:var(--ink)}
.chip b{font-weight:650}
.hero .panel{align-self:stretch}

/* ---------- layout ---------- */
.wrap{max-width:1180px;margin:0 auto;padding:26px 24px 60px}
.row{display:grid;gap:18px;margin-bottom:18px}
.r2{grid-template-columns:repeat(2,minmax(0,1fr))}.r32{grid-template-columns:minmax(0,3fr) minmax(0,2fr)}.r23{grid-template-columns:minmax(0,2fr) minmax(0,3fr)}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:18px 20px;min-width:0}
.panel h2{font-size:17px;margin:2px 0 2px;letter-spacing:-.01em;font-weight:650}
.panel .sub{color:var(--ink2);font-size:13px;margin:0 0 14px}
.head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:6px}
.head a{font-size:13px;font-weight:500}
h2.sec{font-size:13px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:var(--ink2);margin:30px 0 12px}
.range{display:inline-flex;background:var(--surface);border:1px solid var(--line);border-radius:999px;padding:3px;gap:2px;margin-bottom:18px}
.range a{padding:5px 14px;border-radius:999px;color:var(--ink2);font-weight:500;font-size:14px}
.range a:hover{text-decoration:none;color:var(--ink)}.range a.on{background:var(--brand);color:#fff}

/* ---------- stat strip ---------- */
.strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);margin-bottom:18px;overflow:hidden}
.stat{padding:16px 20px;border-right:1px solid var(--line);min-width:0}.stat:last-child{border-right:0}
.stat .l{color:var(--ink2);font-size:13px}
.stat .v{font-size:32px;line-height:1.15;letter-spacing:-.025em;font-weight:650;margin:2px 0}
.stat .n{font-size:12.5px;color:var(--ink2);display:flex;align-items:center;gap:8px;justify-content:space-between}
.up{color:var(--good-text);font-weight:600}.down{color:var(--crit);font-weight:600}
.spark{display:block}

/* ---------- pipeline ---------- */
.pipe{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:0;margin-top:6px}
.stage{position:relative;padding:4px 14px 0 0;min-width:0}
.stage .k{font-size:13px;color:var(--ink2);min-height:2.6em}
.stage .c{font-size:34px;font-weight:650;letter-spacing:-.03em;line-height:1.1;margin:2px 0 8px}
.stage .bar{height:12px;border-radius:4px 4px 4px 4px;background:var(--h0);overflow:hidden}
.stage .bar i{display:block;height:100%;border-radius:4px}
.stage .drop{font-size:12.5px;color:var(--ink2);margin-top:8px;min-height:3em}
.stage .drop b{color:var(--ink);font-weight:600}
.stage a.cover{position:absolute;inset:0}
.stage:hover .c{color:var(--brand-deep)}

/* ---------- desk (needs you) ---------- */
.desk{list-style:none;margin:0;padding:0}
.desk li{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:14px;padding:13px 0;border-top:1px solid var(--line);align-items:start}
.desk li:first-child{border-top:0}
.desk .who{font-weight:600}.desk .why{color:var(--ink2);font-size:14px}
.desk .when{font-size:12.5px;color:var(--ink2);white-space:nowrap}
.clear{display:flex;gap:14px;align-items:center;color:var(--ink2);padding:6px 0}
.clear svg{flex:none}

/* ---------- ledger ---------- */
.scroll{overflow-x:auto;margin:0 -20px;padding:0 20px}
table.ledger{width:100%;border-collapse:collapse;min-width:720px}
.ledger th{font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--ink2);text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
.ledger td{padding:12px 10px;border-bottom:1px solid var(--line);vertical-align:middle}
.ledger tr:last-child td{border-bottom:0}
.ledger tbody tr:hover{background:#f7f9fc}
.ledger .r{text-align:right}
.cust{display:flex;align-items:center;gap:11px;min-width:0}
.av{flex:none;width:34px;height:34px;border-radius:50%;background:var(--brand-wash);color:var(--brand-deep);display:grid;place-items:center;font-weight:650;font-size:13px}
.cust .nm{font-weight:600;line-height:1.25;overflow-wrap:anywhere}.cust .em{font-size:12.5px;color:var(--ink2);overflow-wrap:anywhere}
.st{display:inline-flex;align-items:center;gap:6px;padding:3px 10px 3px 8px;border-radius:999px;font-size:12.5px;font-weight:500;white-space:nowrap;color:var(--ink)}
.st.good{background:#e6f5e6}.st.warn{background:#fef3d4}.st.crit{background:#fbe5e3}.st.neutral{background:#eeede8}
.flag{display:inline-block;margin-left:6px;padding:1px 7px;border-radius:5px;font-size:11.5px;background:#fef3d4;color:#5a3d06;font-weight:500}
.meter{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--ink2);white-space:nowrap}
.pager{display:flex;gap:14px;align-items:center;margin-top:14px;font-size:14px;color:var(--ink2)}
.tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px}
.tabs a{padding:6px 14px;border-radius:999px;border:1px solid var(--line);background:var(--surface);color:var(--ink2);font-weight:500;font-size:14px}
.tabs a:hover{text-decoration:none;color:var(--ink)}.tabs a.on{background:var(--ink);color:#fff;border-color:var(--ink)}
.empty{padding:30px;text-align:center;color:var(--ink2);border:1px dashed var(--axis);border-radius:var(--radius);background:var(--surface)}

/* ---------- charts ---------- */
figure{margin:0}
figcaption{font-size:13px;color:var(--ink2)}
svg text{font-family:var(--font)}
.t{fill:var(--ink2);font-size:11.5px}.tm{fill:var(--muted);font-size:11px}.tv{fill:var(--ink);font-size:12px;font-weight:600}
.gl{stroke:var(--grid);stroke-width:1}.ax{stroke:var(--axis);stroke-width:1}
.f-blue{fill:var(--blue)}.f-crit{fill:var(--crit)}.f-good{fill:var(--good)}.f-warn{fill:var(--warn)}.f-neutral{fill:var(--neutral)}
.f-track{fill:var(--blue-soft)}.s-blue{stroke:var(--blue)}
.f-s1{fill:#86b6ef}.f-s2{fill:#5598e7}.f-s3{fill:#3987e5}.f-s4{fill:#256abf}.f-s5{fill:#184f95}
.f-h0{fill:var(--h0)}.f-h1{fill:var(--h1)}.f-h2{fill:var(--h2)}.f-h3{fill:var(--h3)}.f-h4{fill:var(--h4)}.f-h5{fill:var(--h5)}.f-h6{fill:var(--h6)}
.ring{fill:var(--surface)}
[data-tip]{cursor:default}
g.col:hover rect.mk,g.col:focus rect.mk{filter:brightness(1.08)}
g.col:hover .hit,g.col:focus .hit{fill:rgba(42,120,214,.07)}
.hit{fill:transparent}
rect.cell:hover{stroke:var(--ink);stroke-width:1.5}
.legend{display:flex;flex-wrap:wrap;gap:16px;font-size:13px;color:var(--ink2);margin:0 0 6px}
.legend span{display:inline-flex;align-items:center;gap:7px}
.legend i{width:12px;height:12px;border-radius:3px;display:inline-block}
.legend b{color:var(--ink);font-weight:600}
details.tbl{margin-top:10px;font-size:13px}
details.tbl summary{cursor:pointer;color:var(--brand-deep);font-weight:500}
details.tbl table{margin-top:8px;border-collapse:collapse;width:100%}
details.tbl td,details.tbl th{padding:4px 8px;border-bottom:1px solid var(--line);text-align:left;font-weight:400}
details.tbl th{color:var(--ink2)}
.tip{position:fixed;z-index:50;pointer-events:none;background:var(--ink);color:#fff;padding:7px 10px;border-radius:8px;font-size:12.5px;line-height:1.4;white-space:pre-line;max-width:260px;opacity:0;transition:opacity .08s}
.tip.on{opacity:1}

/* ---------- facts, timeline ---------- */
dl.facts{display:grid;grid-template-columns:minmax(120px,190px) minmax(0,1fr);gap:9px 18px;margin:0}
.facts dt{color:var(--ink2)}.facts dd{margin:0;overflow-wrap:anywhere}
ol.tl{list-style:none;margin:0;padding:0}
ol.tl li{display:grid;grid-template-columns:96px 14px minmax(0,1fr);gap:12px;padding:0 0 16px}
ol.tl .at{font-size:12.5px;color:var(--ink2);text-align:right;padding-top:1px}
ol.tl .pt{position:relative}.tl .pt:before{content:"";position:absolute;left:5px;top:6px;width:9px;height:9px;border-radius:50%;background:var(--brand)}
ol.tl .pt:after{content:"";position:absolute;left:9px;top:18px;bottom:-16px;width:1.5px;background:var(--line)}
ol.tl li:last-child .pt:after{display:none}
ol.tl .what{font-weight:600}.tl .more{color:var(--ink2);font-size:13.5px;overflow-wrap:anywhere}
.btn{display:inline-flex;align-items:center;gap:8px;padding:9px 16px;border-radius:9px;background:var(--brand);color:#fff;font-weight:600;border:0;font:inherit;font-weight:600;cursor:pointer}
.btn:hover{background:var(--brand-deep);text-decoration:none;color:#fff}
.btn.ghost{background:var(--surface);color:var(--ink);border:1px solid var(--line)}.btn.ghost:hover{background:var(--plane);color:var(--ink)}

/* ---------- services ---------- */
.svc{display:grid;grid-template-columns:auto minmax(0,200px) minmax(0,1fr);gap:12px;padding:12px 0;border-top:1px solid var(--line);align-items:center}
.svc:first-child{border-top:0}.svc .nm{font-weight:600}.svc .d{color:var(--ink2);font-size:14px;overflow-wrap:anywhere}
.three{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:18px}
.three .panel p{margin:6px 0;color:var(--ink2)}
.three .panel h3{margin:8px 0 2px;font-size:16px}
.big{font-size:42px;font-weight:650;letter-spacing:-.03em}

/* ---------- login ---------- */
.login{min-height:100vh;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr)}
.login .side{background:var(--wash);border-right:1px solid var(--wash-line);padding:56px;display:flex;flex-direction:column;justify-content:space-between}
.login .side h1{font-size:44px;line-height:1.08;letter-spacing:-.035em;margin:0 0 14px;font-weight:650;color:var(--ink)}
.login .side p{color:var(--ink2);max-width:36ch;font-size:17px}
.login .col{align-self:center;justify-self:center;width:min(380px,86vw);padding:24px 0}
.login label{display:block;font-weight:600;margin-bottom:6px}
.login input{width:100%;padding:11px 12px;border:1px solid var(--axis);border-radius:9px;font:inherit;background:var(--surface);color:var(--ink);margin-bottom:14px}
.login input:focus{outline:2px solid var(--brand);border-color:var(--brand)}
.err{color:var(--crit);margin:0 0 12px;font-weight:500}

/* ---------- people, roles, forms ---------- */
.role{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11.5px;font-weight:600;letter-spacing:.01em;white-space:nowrap;line-height:1.5}
.role.viewer{background:#eeede8;color:#4a4a45}.role.staff{background:#dff1ee;color:#0f4f47}.role.manager{background:#e1ecfb;color:#1a4a8a}.role.owner{background:#184f95;color:#fff}
.top .me{display:flex;align-items:center;gap:9px;padding:4px 8px;border-radius:9px;color:var(--ink)}
.top .me:hover{background:var(--plane);text-decoration:none}.top .me.on{background:var(--plane)}
.me .who{display:flex;flex-direction:column;align-items:flex-start;line-height:1.15;gap:3px}.me .who b{font-size:13px;font-weight:600}
.av.sm{width:28px;height:28px;font-size:11px}
.brand .mark .ck{stroke:var(--brand)}
.brand .logo{display:block;height:30px;width:auto;max-width:160px;object-fit:contain}
.login .side .brand .logo{height:38px;max-width:220px}
.brandfoot{text-align:center;color:var(--ink2);font-size:13px;padding:6px 16px 28px}
.top .brand,.top nav a,.live,button.quiet,.me .who{white-space:nowrap}
@media (max-width:1280px){.live .lt,.brand small{display:none}}
.form label{display:block;font-weight:600;margin:0 0 6px}
.form input[type=text],.form input[type=password],.form input[type=email],.form select,.form textarea{width:100%;padding:10px 12px;border:1px solid var(--axis);border-radius:9px;font:inherit;background:var(--surface);color:var(--ink);margin-bottom:14px}
.form textarea{resize:vertical;min-height:84px}
.form input:focus,.form select:focus,.form textarea:focus{outline:2px solid var(--brand);border-color:var(--brand)}
.form .hint{color:var(--ink2);font-size:13px;margin:-8px 0 14px}
.form.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:0 16px;align-items:start}
.form.cols .actions{grid-column:1/-1}
.actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.btn.sm{padding:6px 12px;font-size:13.5px;border-radius:8px}
.btn.danger{background:var(--surface);color:var(--crit);border:1px solid #e9b4af}.btn.danger:hover{background:#fbe5e3;color:var(--crit)}
.okmsg{background:#e6f5e6;border-radius:8px;padding:8px 12px;margin:0 0 14px;font-weight:500}
.badmsg{background:#fbe5e3;border-radius:8px;padding:8px 12px;margin:0 0 14px;font-weight:500}
ul.notes{list-style:none;margin:0 0 18px;padding:0;display:grid;gap:14px}
.note{display:grid;grid-template-columns:auto minmax(0,1fr);gap:12px;align-items:start}
.note .by{font-size:14px}.note .txt{margin:4px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}
.note.handled .av{background:#e6f5e6;color:#0b6b0b}
.secret{border:1.5px dashed var(--brand);background:var(--brand-wash);border-radius:var(--radius);padding:16px 20px;margin-bottom:18px}
.secret h2{margin:0 0 4px;font-size:17px}.secret p{margin:6px 0}
.secret code{display:inline-block;font:600 22px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.04em;padding:8px 12px;background:var(--surface);border:1px solid var(--line);border-radius:8px;user-select:all;overflow-wrap:anywhere}
.rolecards{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:14px}
.rolecards .panel p{margin:8px 0 0;color:var(--ink2);font-size:14px}
table.matrix{width:100%;border-collapse:collapse;min-width:520px}
.matrix th,.matrix td{padding:9px 10px;border-bottom:1px solid var(--line);text-align:center}
.matrix th:first-child,.matrix td:first-child{text-align:left}
.matrix thead th{font-weight:600;font-size:13px}.matrix tr:last-child td{border-bottom:0}
.matrix .yes{color:var(--good-text)}.matrix .no{color:var(--muted)}
.person-row .em{font-size:12.5px;color:var(--ink2)}
.sess{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 14px;padding:11px 0;border-top:1px solid var(--line)}
.sess:first-of-type{border-top:0}.sess .sub{margin:0}
.you{font-size:12px;color:var(--ink2);margin-left:6px}
.demo-pick{margin-top:26px;padding-top:18px;border-top:1px solid var(--line)}
.demo-pick p{margin:0 0 10px;color:var(--ink2);font-size:13.5px}
.demo-pick .row-btns{display:flex;flex-wrap:wrap;gap:8px}
.login .demo-pick form{display:inline}
.nowrap{white-space:nowrap}
.cap{text-transform:capitalize}
ul.plain{margin:8px 0 0;padding-left:20px}ul.plain li{margin:4px 0}

/* ---------- small utilities (instead of inline styles, which the page's security policy forbids) ---------- */
.pt{font-size:26px;letter-spacing:-.02em;margin:6px 0 4px;font-weight:650}.pt.big{font-size:28px;margin:0}.pt.mb{margin-bottom:16px}
.ptsub{margin:0 0 18px}.foot{margin-top:22px}.mid{align-items:center}.chipsrow{margin:8px 0 20px}
.mb{margin-bottom:18px}.mt{margin-top:18px}.p0{margin:6px 0 0}.p8{margin:8px 0 0}.nm0{margin:0 8px 0 0}.back{margin:4px 0 14px}
.lh{margin:0 0 16px;font-size:22px;letter-spacing:-.02em}.btn.wide{width:100%;justify-content:center}
.msg{max-width:560px;margin:14vh auto}.lead{font-size:16px}

/* ---------- motion (switched off for anyone who prefers reduced motion) ---------- */
@keyframes rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
@keyframes ping{0%{opacity:.55;transform:scale(.6)}80%,100%{opacity:0;transform:scale(1.6)}}
@keyframes grow{from{transform:scaleY(0)}to{transform:scaleY(1)}}
@keyframes growx{from{transform:scaleX(0)}to{transform:scaleX(1)}}
.rise{animation:rise .55s cubic-bezier(.2,.7,.2,1) both}
.d1{animation-delay:.04s}.d2{animation-delay:.1s}.d3{animation-delay:.16s}.d4{animation-delay:.22s}.d5{animation-delay:.28s}.d6{animation-delay:.34s}
.col .mk{transform-box:fill-box;transform-origin:bottom;animation:grow .7s cubic-bezier(.2,.7,.2,1) both}
.hb{transform-box:fill-box;transform-origin:left;animation:growx .8s cubic-bezier(.2,.7,.2,1) both}
.stage .bar i{transform-origin:left;animation:growx .9s cubic-bezier(.2,.7,.2,1) both}
@media (prefers-reduced-motion:reduce){*,*:before,*:after{animation:none!important;transition:none!important}}

/* ---------- small screens ---------- */
@media (max-width:900px){
  .hero .in{grid-template-columns:minmax(0,1fr)}.r2,.r32,.r23{grid-template-columns:minmax(0,1fr)}
  .pipe{grid-template-columns:repeat(2,minmax(0,1fr));row-gap:18px}.login{grid-template-columns:minmax(0,1fr)}.login .side{padding:32px}
  .top .in{gap:12px;height:auto;flex-wrap:wrap;padding:10px 16px}.top nav{order:3;width:100%;overflow-x:auto}.bignum{font-size:60px}
}
@media (max-width:560px){dl.facts{grid-template-columns:minmax(0,1fr)}.wrap,.hero .in{padding-left:16px;padding-right:16px}ol.tl li{grid-template-columns:70px 14px minmax(0,1fr)}.stat{border-right:0;border-bottom:1px solid var(--line)}}
`;

/** Staggered column entrance without inline styles (the page's content-security policy forbids them). */
const STAGGER = Array.from({ length: 16 }, (_, i) => `.k${i} .mk{animation-delay:${i * 28}ms}`).join('');

export const CSS = BASE + STAGGER;
