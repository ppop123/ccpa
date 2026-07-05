export function renderMonitorPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ccpa Monitor</title>
    <style>
*{box-sizing:border-box}
:root{--bg:#f4f1ea;--panel:#fffdf9;--panel2:#faf6ee;--inset:#efe9dd;--line:#e8e1d3;--line2:#d9cfbd;--ink:#221d16;--ink2:#6f6555;--ink3:#a79d8c;--brand:#cf5a2c;--brand2:#b0461c;--brand-soft:rgba(207,90,44,.12);--ok:#2c8a58;--ok-soft:rgba(44,138,88,.12);--warn:#b47f13;--warn-soft:rgba(180,127,19,.14);--err:#cd3f26;--err-soft:rgba(205,63,38,.10);--err-line:rgba(205,63,38,.45);--teal:#2f7d73;--mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;--sans:"Segoe UI",system-ui,-apple-system,Roboto,Helvetica,Arial,sans-serif;--sh:0 1px 2px rgba(60,40,20,.05);--sh2:0 18px 46px rgba(60,40,20,.14);--pad:14px;--gap:12px}
.theme-dark{--bg:#100f0d;--panel:#1a1916;--panel2:#201d19;--inset:#161410;--line:#2b2823;--line2:#3b362d;--ink:#f2ede3;--ink2:#a79d8c;--ink3:#726a5c;--brand:#e2703d;--brand2:#c85a28;--brand-soft:rgba(226,112,61,.16);--ok:#46b47e;--ok-soft:rgba(70,180,126,.14);--warn:#d8a53c;--warn-soft:rgba(216,165,60,.16);--err:#e5654a;--err-soft:rgba(229,101,74,.13);--err-line:rgba(229,101,74,.5);--teal:#4fb3a6;--sh:0 1px 2px rgba(0,0,0,.35);--sh2:0 20px 50px rgba(0,0,0,.6)}
.cozy{--pad:18px;--gap:16px}
html{background:var(--bg)}
body{margin:0}
.app{min-height:100vh;background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:13px;line-height:1.45;-webkit-font-smoothing:antialiased}
.app h1,.app h2,.app h3,.app p{margin:0}
.mono{font-family:var(--mono)}
.top{position:sticky;top:0;z-index:30;background:var(--bg);border-bottom:1px solid var(--line)}
.top-in{width:min(1480px,100% - 40px);margin:0 auto;padding:11px 0;display:flex;align-items:center;justify-content:space-between;gap:16px}
.brand{display:flex;align-items:center;gap:11px}
.logo{width:34px;height:34px;border-radius:9px;background:linear-gradient(135deg,var(--brand),var(--brand2));color:#fff;font-family:var(--mono);font-weight:700;font-size:13px;letter-spacing:-.04em;display:flex;align-items:center;justify-content:center;box-shadow:var(--sh)}
.bname{font-size:15px;font-weight:700;letter-spacing:-.02em}
.bsub{color:var(--ink3);font-weight:500;font-size:12px;margin-left:5px}
.bmeta{font-size:10.5px;color:var(--ink3);margin-top:1px}
.top-r{display:flex;align-items:center;gap:10px}
.conn{display:inline-flex;align-items:center;gap:7px;font-size:11.5px;font-weight:600;padding:5px 11px;border-radius:999px;border:1px solid var(--line);background:var(--panel2)}
.upd{font-size:10.5px;color:var(--ink3);letter-spacing:-.01em}
.ibtn{width:34px;height:34px;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--line);border-radius:9px;background:var(--panel2);color:var(--ink2);cursor:pointer;transition:.15s}
.ibtn:hover{color:var(--ink);border-color:var(--line2)}
.page{width:min(1480px,100% - 40px);margin:0 auto;padding:16px 0 52px;display:flex;flex-direction:column;gap:var(--gap)}
.hero{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:15px 20px;display:flex;align-items:center;justify-content:space-between;gap:18px;flex-wrap:wrap;box-shadow:var(--sh)}
.hero-l{display:flex;align-items:center;gap:15px}
.beacon{width:14px;height:14px;border-radius:50%;position:relative;flex:none;background:var(--ink3)}
.beacon::after{content:'';position:absolute;inset:0;border-radius:50%;background:inherit;animation:pulse 2.4s ease-out infinite}
@keyframes pulse{0%{transform:scale(1);opacity:.5}70%{transform:scale(2.6);opacity:0}100%{opacity:0}}
.hero-title{font-size:18px;font-weight:700;letter-spacing:-.02em}
.hero-sub{font-size:12.5px;color:var(--ink2);margin-top:2px}
.hero-r{display:flex;gap:8px;flex-wrap:wrap}
.pchip{display:flex;align-items:center;gap:8px;padding:7px 12px;border:1px solid var(--line);border-radius:10px;background:var(--panel2)}
.pchip-n{font-size:12.5px;font-weight:600}
.pchip-s{font-family:var(--mono);font-size:10.5px;text-transform:lowercase}
.kpis{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:var(--gap)}
.kpi{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:13px 14px;box-shadow:var(--sh)}
.kpi.tap{cursor:pointer;transition:.15s}
.kpi.tap:hover{border-color:var(--brand)}
.kpi-top{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:22px}
.kpi-label{font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:.11em;color:var(--ink3)}
.spark{opacity:.9}
.kpi-val{font-size:27px;font-weight:600;letter-spacing:-.03em;margin:7px 0 3px;line-height:1}
.kpi-sub{font-size:11.5px;color:var(--ink2)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:var(--gap)}
.grid3{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1fr);gap:var(--gap)}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:var(--pad);box-shadow:var(--sh)}
.p-h{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:13px}
.p-h.wrap{flex-wrap:wrap}
.p-k{font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:.12em;color:var(--ink3);margin-bottom:3px}
.p-t{font-size:14px;font-weight:600;letter-spacing:-.01em}
.p-meta{font-size:11px;color:var(--ink3)}
.tb-wrap{display:flex;flex-direction:column;gap:7px}
.tb-plot{position:relative;height:132px}
.tb-bars{position:absolute;inset:0;display:flex;align-items:flex-end;gap:4px}
.tb-col{flex:1;height:100%;display:flex;align-items:flex-end;min-width:0}
.tb-bar{width:100%;background:linear-gradient(180deg,var(--brand),var(--brand2));border-radius:3px 3px 0 0;min-height:2px}
.tb-bar.hb{background:var(--teal)}
.tb-avg{position:absolute;left:0;right:0;border-top:1px dashed var(--line2);pointer-events:none}
.tb-avg-l{position:absolute;right:0;top:-15px;font-size:9.5px;color:var(--ink3);background:var(--panel);padding:0 4px}
.tb-axis{display:flex;gap:4px}
.tb-x{flex:1;text-align:center;font-family:var(--mono);font-size:9.5px;color:var(--ink3);white-space:nowrap;overflow:hidden}
.prov-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.prov{border:1px solid var(--line);border-radius:11px;padding:12px;background:var(--panel2)}
.prov-h{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:11px}
.prov-n{font-size:13.5px;font-weight:600}
.prov-rows{display:grid;gap:7px}
.prow{display:flex;align-items:baseline;justify-content:space-between;gap:10px;font-size:12px}
.prow-k{color:var(--ink2);flex:none}
.prow-v{font-family:var(--mono);text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.acc-list{display:grid;gap:10px}
.acc{border:1px solid var(--line);border-radius:11px;padding:12px;background:var(--panel2)}
.acc.err{border-color:var(--err-line);background:var(--err-soft)}
.acc-h{display:flex;align-items:center;justify-content:space-between;gap:8px}
.acc-m{font-family:var(--mono);font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.acc-cd{font-family:var(--mono);font-size:11.5px;margin-top:5px}
.acc-cd:empty{display:none}
.acc-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:9px;margin:11px 0 9px}
.ag{display:grid;gap:2px}
.ag-k{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink3)}
.ag-v{font-family:var(--mono);font-size:13px;font-weight:600}
.acc-meta{font-family:var(--mono);font-size:10.5px;color:var(--ink3);line-height:1.5}
.acc-err{font-family:var(--mono);font-size:10.5px;color:var(--err);background:var(--err-soft);padding:6px 8px;border-radius:6px;margin-top:7px}
.tabs{display:flex;gap:4px}
.tab{font-size:12px;font-weight:600;padding:5px 11px;border-radius:8px;border:1px solid transparent;background:transparent;color:var(--ink2);cursor:pointer;transition:.12s}
.tab:hover{color:var(--ink)}
.tab.on{background:var(--brand-soft);color:var(--brand)}
.tbl-wrap{overflow-x:auto}
.tbl{width:100%;border-collapse:collapse;font-size:12px}
.tbl th{text-align:left;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--ink3);padding:0 10px 9px;white-space:nowrap}
.tbl td{padding:8px 10px;border-top:1px solid var(--line);vertical-align:middle}
.tbl .num{text-align:right;white-space:nowrap}
.dim{color:var(--ink3)}
.c-name{max-width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.c-share{width:92px}
.share{width:80px;height:6px;background:var(--inset);border-radius:999px;overflow:hidden}
.share-f{height:100%;background:linear-gradient(90deg,var(--brand),var(--brand2));border-radius:999px}
.filters{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.search{position:relative;display:flex;align-items:center}
.s-ico{position:absolute;left:9px;color:var(--ink3);display:flex;pointer-events:none}
.s-in{padding:7px 10px 7px 29px;border:1px solid var(--line);border-radius:8px;background:var(--panel2);color:var(--ink);font-size:12px;width:230px;outline:none;font-family:var(--sans)}
.s-in:focus{border-color:var(--brand)}
.seg{display:inline-flex;background:var(--inset);border:1px solid var(--line);border-radius:8px;padding:2px}
.seg-b{font-size:12px;font-weight:600;padding:4px 11px;border-radius:6px;border:0;background:transparent;color:var(--ink2);cursor:pointer}
.seg-b.on{background:var(--panel);color:var(--ink);box-shadow:var(--sh)}
.sel{font-size:12px;padding:6px 9px;border:1px solid var(--line);border-radius:8px;background:var(--panel2);color:var(--ink);font-family:var(--sans);cursor:pointer}
.rmeta{font-family:var(--mono);font-size:11px;color:var(--ink3);margin-left:auto}
.rtbl td{vertical-align:top}
.rrow.exp{cursor:pointer}
.rrow.exp:hover{background:var(--inset)}
.rrow.err{background:var(--err-soft)}
.r-abs{font-family:var(--mono);font-size:12px}
.r-ago{font-size:10px;margin-top:1px}
.r-ua{font-size:10px;margin-top:1px;max-width:210px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.r-ep{max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tag{font-family:var(--mono);font-size:11px;padding:2px 7px;border-radius:6px;background:var(--inset);color:var(--ink2);border:1px solid var(--line)}
.stat{font-family:var(--mono);font-size:11px;font-weight:600;padding:2px 8px;border-radius:6px}
.stat.ok{color:var(--ok);background:var(--ok-soft)}
.stat.err{color:var(--err);background:var(--err-soft)}
.rdetail td{padding:0;border-top:1px solid var(--line)}
.rd{padding:11px 12px 12px;background:var(--inset);border-left:2px solid var(--err-line)}
.rd-h{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.rd-msg{font-size:12.5px;color:var(--ink)}
.rd-chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.chipx{font-family:var(--mono);font-size:10.5px;padding:2px 7px;border-radius:6px;background:var(--panel);border:1px solid var(--line);color:var(--ink2)}
.rd-ae{font-family:var(--mono);font-size:10.5px;color:var(--err);margin-top:8px}
.foot{font-size:11px;color:var(--ink3);margin-top:13px;line-height:1.6}
.scrim{position:fixed;inset:0;background:rgba(20,14,6,.28);opacity:0;pointer-events:none;transition:.25s;z-index:40}
.scrim.open{opacity:1;pointer-events:auto}
.theme-dark .scrim{background:rgba(0,0,0,.55)}
.drawer{position:fixed;top:0;right:0;height:100vh;width:360px;max-width:92vw;background:var(--panel);border-left:1px solid var(--line);box-shadow:var(--sh2);padding:20px;transform:translateX(102%);transition:transform .26s cubic-bezier(.4,0,.2,1);z-index:50;display:flex;flex-direction:column;gap:14px;overflow-y:auto}
.drawer.open{transform:none}
.dr-h{display:flex;align-items:center;justify-content:space-between}
.dr-p{font-size:12px;color:var(--ink2);line-height:1.55}
.fld{display:grid;gap:6px}
.fld-l{font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--ink3);font-weight:600}
.fld-in{padding:9px 11px;border:1px solid var(--line);border-radius:9px;background:var(--panel2);color:var(--ink);font-size:13px;width:100%;font-family:var(--sans);outline:none}
.fld-in:focus{border-color:var(--brand)}
.chk{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--ink2);cursor:pointer}
.chk input{accent-color:var(--brand);width:15px;height:15px}
.dr-actions{display:flex;gap:8px;margin-top:2px}
.btn{font-size:13px;font-weight:600;padding:9px 14px;border-radius:9px;border:1px solid var(--line);background:var(--panel2);color:var(--ink);cursor:pointer;flex:1;font-family:var(--sans)}
.btn.primary{background:linear-gradient(135deg,var(--brand),var(--brand2));color:#fff;border-color:transparent}
.dr-status{display:flex;align-items:center;gap:8px;font-size:12px;padding:9px 11px;border-radius:9px;background:var(--inset)}
.dr-eps{margin-top:auto;border-top:1px solid var(--line);padding-top:13px;display:grid;gap:5px}
.dr-ep-h{font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--ink3);font-weight:600;margin-bottom:2px}
.ep{font-family:var(--mono);font-size:11.5px;color:var(--ink2)}
.dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--ink3)}
.pill{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:600;padding:3px 9px;border-radius:999px}
.dot.ok,.beacon.ok{background:var(--ok)}
.dot.warn,.beacon.warn{background:var(--warn)}
.dot.err,.beacon.err{background:var(--err)}
.dot.off{background:var(--ink3)}
.pill.ok{background:var(--ok-soft);color:var(--ok)}
.pill.warn{background:var(--warn-soft);color:var(--warn)}
.pill.err{background:var(--err-soft);color:var(--err)}
.pill.off{background:var(--inset);color:var(--ink3)}
.ok{color:var(--ok)}
.warn{color:var(--warn)}
.err{color:var(--err)}
.off{color:var(--ink3)}
.empty-cell{padding:22px 10px;text-align:center;color:var(--ink3);font-size:12.5px}
.empty{padding:16px;border:1px dashed var(--line2);border-radius:10px;color:var(--ink3);background:var(--panel2);text-align:center;font-size:12.5px}
.r-sub{font-size:9.5px;margin-top:1px}
.caret{display:inline-block;margin-left:7px;width:0;height:0;border-left:4px solid var(--ink3);border-top:3px solid transparent;border-bottom:3px solid transparent;transition:transform .15s;vertical-align:middle}
.caret.open{transform:rotate(90deg)}
.alert{display:flex;align-items:flex-start;gap:13px;padding:14px 16px;border-radius:14px;border:1px solid var(--err-line);background:var(--err-soft);box-shadow:var(--sh)}
.alert.warn{border-color:var(--warn);background:var(--warn-soft)}
.alert-ico{flex:none;margin-top:1px;color:var(--err)}
.alert-ico.warn{color:var(--warn)}
.alert-body{flex:1;min-width:0}
.alert-title{font-size:13.5px;font-weight:700}
.alert-list{display:grid;gap:5px;margin-top:8px}
.alert-item{display:flex;align-items:baseline;gap:8px;font-size:12px;flex-wrap:wrap}
.alert-l{font-weight:600}
.alert-d{color:var(--ink2);font-family:var(--mono);font-size:11px}
.alert-actions{display:flex;align-items:center;gap:8px;flex:none}
.alert-btn{font-size:12px;font-weight:600;padding:7px 13px;border-radius:8px;border:1px solid var(--err-line);background:var(--panel);color:var(--err);cursor:pointer}
.alert-btn.warn{border-color:var(--warn);color:var(--warn)}
.gearbtn{position:relative}
.gear-badge{position:absolute;top:-5px;right:-5px;min-width:16px;height:16px;padding:0 4px;border-radius:999px;background:var(--err);color:#fff;font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;font-family:var(--mono)}
.gear-badge.warn{background:var(--warn)}
.chk-alert{margin-top:2px}
@media(max-width:1200px){.kpis{grid-template-columns:repeat(3,1fr)}}
@media(max-width:980px){.grid2,.grid3{grid-template-columns:1fr}}
@media(max-width:680px){.kpis{grid-template-columns:repeat(2,1fr)}.acc-grid{grid-template-columns:repeat(2,1fr)}}
    </style>
  </head>
  <body>
    <div class="app" id="app">
      <header class="top">
        <div class="top-in">
          <div class="brand">
            <div class="logo">cc</div>
            <div>
              <div class="bname">ccpa<span class="bsub">/ monitor</span></div>
              <div class="bmeta mono" id="bar-meta">—</div>
            </div>
          </div>
          <div class="top-r">
            <div class="conn warn" id="conn"><span class="dot warn" id="conn-dot"></span><span id="conn-label">Offline</span></div>
            <span class="upd mono" id="upd"></span>
            <button class="ibtn" id="btn-theme" title="Toggle theme"></button>
            <button class="ibtn" id="btn-refresh" title="Refresh"></button>
            <button class="ibtn gearbtn" id="btn-settings" title="Connection settings"><span class="gear-badge" id="gear-badge" style="display:none"></span></button>
          </div>
        </div>
      </header>
      <main class="page">
        <section class="alert" id="alert" style="display:none"></section>
        <section class="hero">
          <div class="hero-l">
            <span class="beacon" id="beacon"></span>
            <div>
              <div class="hero-title" id="hero-title">Not connected</div>
              <div class="hero-sub" id="hero-sub">Add an API key in settings to load live metrics.</div>
            </div>
          </div>
          <div class="hero-r" id="hero-chips"></div>
        </section>
        <section class="kpis" id="kpis"></section>
        <section class="grid2">
          <div class="panel">
            <div class="p-h"><div><div class="p-k">Traffic</div><h3 class="p-t">Requests over time</h3></div><div class="p-meta mono" id="trend-meta"></div></div>
            <div id="chart-req"></div>
          </div>
          <div class="panel">
            <div class="p-h"><div><div class="p-k">Distribution</div><h3 class="p-t">Requests by hour</h3></div><div class="p-meta mono" id="hour-meta"></div></div>
            <div id="chart-hour"></div>
          </div>
        </section>
        <section class="grid3">
          <div class="panel">
            <div class="p-h"><div><div class="p-k">Providers</div><h3 class="p-t">Upstream health</h3></div></div>
            <div class="prov-grid" id="providers"></div>
          </div>
          <div class="panel">
            <div class="p-h"><div><div class="p-k">Claude accounts</div><h3 class="p-t" id="accounts-title">accounts</h3></div></div>
            <div class="acc-list" id="accounts"></div>
          </div>
        </section>
        <section class="panel">
          <div class="p-h"><div><div class="p-k">Usage breakdown</div><h3 class="p-t">Counters since start</h3></div><div class="tabs" id="tabs"></div></div>
          <div class="tbl-wrap"><table class="tbl"><thead><tr><th class="c-name" id="breakdown-col">Model</th><th class="c-share"></th><th class="num">Requests</th><th class="num">OK</th><th class="num">Fail</th><th class="num">Tokens</th><th class="num">Cache</th><th class="num">Last seen</th></tr></thead><tbody id="breakdown-tbody"></tbody></table></div>
          <div class="empty" id="breakdown-empty" style="display:none">No data yet.</div>
        </section>
        <section class="panel">
          <div class="p-h wrap">
            <div><div class="p-k">Live traffic</div><h3 class="p-t">Recent requests</h3></div>
            <div class="filters">
              <div class="search"><span class="s-ico" id="search-ico"></span><input class="s-in" id="search" type="text" placeholder="filter model, endpoint, ip, error…"></div>
              <div class="seg" id="status-seg"></div>
              <select class="sel" id="sel-provider"></select>
              <select class="sel" id="sel-source"></select>
              <span class="rmeta" id="recent-meta"></span>
            </div>
          </div>
          <div class="tbl-wrap"><table class="tbl rtbl"><thead><tr><th>When</th><th>Source</th><th>Provider</th><th>Endpoint</th><th>Model</th><th class="num">Status</th><th class="num">Latency</th><th class="num">Tokens</th></tr></thead><tbody id="recent-tbody"></tbody></table></div>
          <div class="empty" id="recent-empty" style="display:none"></div>
          <p class="foot">Dashboard shell is public on the local process; live data still requires a valid API key. Metrics are memory-only and reset when the proxy restarts.</p>
        </section>
      </main>
      <div class="scrim" id="scrim"></div>
      <aside class="drawer" id="drawer">
        <div class="dr-h"><h3 class="p-t">Connection</h3><button class="ibtn" id="btn-close"></button></div>
        <p class="dr-p">Live metrics load from the local admin endpoints over same-origin requests. Your key is used only in this browser.</p>
        <label class="fld"><span class="fld-l">API key</span><input class="fld-in mono" id="api-key" type="password" placeholder="sk-…" autocomplete="off"></label>
        <label class="chk"><input type="checkbox" id="remember"><span>Remember on this browser</span></label>
        <label class="fld"><span class="fld-l">Auto-refresh</span><select class="fld-in" id="interval"><option value="5000">Every 5s</option><option value="15000">Every 15s</option><option value="30000">Every 30s</option><option value="60000">Every 60s</option><option value="0">Off</option></select></label>
        <label class="chk chk-alert"><input type="checkbox" id="login-alerts"><span>Alert on Claude / Codex / Grok login-state anomalies</span></label>
        <div class="dr-actions"><button class="btn primary" id="btn-connect">Connect</button><button class="btn" id="btn-refresh2">Refresh now</button></div>
        <div class="dr-status" id="dr-status"><span class="dot warn" id="dr-status-dot"></span><span id="dr-status-msg">Enter an API key to connect.</span></div>
        <div class="dr-eps"><div class="dr-ep-h">Endpoints</div><div class="ep">GET /admin/accounts</div><div class="ep">GET /admin/usage</div><div class="ep">GET /admin/usage/recent</div></div>
      </aside>
    </div>
    <script>
      (function () {
        var STORAGE_KEY = "ccpa-monitor-api-key";
        var THEME_KEY = "ccpa-monitor-theme";
        var REFRESH_KEY = "ccpa-monitor-refresh";
        var ALERTS_KEY = "ccpa-monitor-alerts";

        var ICON = {
          refresh: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11A8 8 0 1 0 18.4 16"/><polyline points="20 4 20 11 13 11"/></svg>',
          gear: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="8" x2="20" y2="8"/><line x1="4" y1="16" x2="20" y2="16"/><circle cx="9" cy="8" r="2.5" fill="var(--panel2)"/><circle cx="15" cy="16" r="2.5" fill="var(--panel2)"/></svg>',
          search: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/></svg>',
          close: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>',
          alert: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a1 1 0 0 0 .86 1.5h18.64a1 1 0 0 0 .86-1.5L13.71 3.86a1 1 0 0 0-1.72 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
          moon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/></svg>',
          sun: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/><line x1="4.9" y1="4.9" x2="6.3" y2="6.3"/><line x1="17.7" y1="17.7" x2="19.1" y2="19.1"/><line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/><line x1="4.9" y1="19.1" x2="6.3" y2="17.7"/><line x1="17.7" y1="6.3" x2="19.1" y2="4.9"/></svg>'
        };

        var $ = function (id) { return document.getElementById(id); };

        var store = { accounts: null, usage: null, recent: null };
        var state = {
          connected: false,
          apiKey: "",
          remember: false,
          autoRefreshMs: 15000,
          statusMsg: "Enter an API key to connect.",
          statusTone: "warn",
          filters: { provider: "all", status: "all", source: "all", q: "" },
          tab: "model",
          expanded: {},
          loginAlerts: true,
          alertDismissKey: "",
          lastLoadedAt: Date.now(),
          theme: "light"
        };
        var lastLoad = 0;
        var timer = null;
        var notifiedSig = "";
        var loading = false;

        function escapeHtml(value) {
          return String(value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
        }
        function num(v) { var n = typeof v === "number" && isFinite(v) ? v : 0; return new Intl.NumberFormat("en-US").format(n); }
        function compact(v) {
          var n = typeof v === "number" && isFinite(v) ? v : 0;
          if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M";
          if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "k";
          return String(Math.round(n));
        }
        function pct(v, d) { var n = typeof v === "number" && isFinite(v) ? v : 0; return (n * 100).toFixed(d == null ? 1 : d) + "%"; }
        function timeAgo(iso, now) {
          if (!iso) return "—";
          var t = new Date(iso).getTime();
          if (isNaN(t)) return String(iso);
          var s = Math.max(0, Math.round((now - t) / 1000));
          if (s < 60) return s + "s ago";
          var m = Math.floor(s / 60);
          if (m < 60) return m + "m ago";
          var hh = Math.floor(m / 60);
          if (hh < 24) return hh + "h " + (m % 60) + "m ago";
          var d = Math.floor(hh / 24);
          return d + "d " + (hh % 24) + "h ago";
        }
        function until(iso, now) {
          if (!iso) return "—";
          var t = new Date(iso).getTime();
          if (isNaN(t)) return String(iso);
          if (t > now) return "in " + dur(t - now);
          return timeAgo(iso, now);
        }
        function clock(iso) {
          if (!iso) return "—";
          var d = new Date(iso);
          if (isNaN(d.getTime())) return String(iso);
          return d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
        }
        function dur(ms) {
          var s = Math.floor(ms / 1000);
          var d = Math.floor(s / 86400);
          var hh = Math.floor((s % 86400) / 3600);
          var m = Math.floor((s % 3600) / 60);
          if (d > 0) return d + "d " + hh + "h";
          if (hh > 0) return hh + "h " + m + "m";
          if (m > 0) return m + "m";
          return s + "s";
        }
        function agoMs(ms, now) {
          if (!ms) return "—";
          var s = Math.max(0, Math.round((now - ms) / 1000));
          if (s < 5) return "just now";
          if (s < 60) return s + "s ago";
          var m = Math.floor(s / 60);
          if (m < 60) return m + "m ago";
          return Math.floor(m / 60) + "h ago";
        }
        function uaShort(ua) { if (!ua) return "no ua"; return ua.length > 34 ? ua.slice(0, 32) + "…" : ua; }
        function mdShort(key) {
          var p = String(key).split("-");
          var mo = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][parseInt(p[1], 10) - 1] || "";
          return mo + " " + parseInt(p[2], 10);
        }
        function spark(vals) {
          if (!vals || vals.length < 2) return "";
          var max = Math.max.apply(null, vals), min = Math.min.apply(null, vals), w = 74, ht = 22;
          var pts = vals.map(function (v, i) {
            var x = (i / (vals.length - 1)) * w;
            var y = ht - 2 - ((v - min) / ((max - min) || 1)) * (ht - 4);
            return x.toFixed(1) + "," + y.toFixed(1);
          }).join(" ");
          return '<svg class="spark" viewBox="0 0 ' + w + " " + ht + '" width="' + w + '" height="' + ht + '" preserveAspectRatio="none"><polyline points="' + pts + '" fill="none" stroke="var(--brand)" stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/></svg>';
        }
        function chartBars(items, barClass, showAvg, axisPred) {
          if (!items || !items.length) return '<div class="empty">No data yet.</div>';
          var vals = items.map(function (x) { return x.value; });
          var max = Math.max.apply(null, vals) || 1;
          var avg = vals.reduce(function (a, b) { return a + b; }, 0) / (vals.length || 1);
          var cols = items.map(function (x) {
            var hp = Math.max(2, Math.round((x.value / max) * 100));
            return '<div class="tb-col" title="' + escapeHtml((x.label || x.short) + ": " + num(x.value) + " req") + '"><div class="tb-bar ' + (barClass || "") + '" style="height:' + hp + '%"></div></div>';
          }).join("");
          var over = showAvg ? '<div class="tb-avg" style="bottom:' + ((avg / max) * 100) + '%"><span class="tb-avg-l mono">avg ' + num(Math.round(avg)) + "</span></div>" : "";
          var axis = items.map(function (x, i) {
            return '<span class="tb-x">' + (axisPred(i, items.length) ? escapeHtml(x.short) : "") + "</span>";
          }).join("");
          return '<div class="tb-wrap"><div class="tb-plot">' + over + '<div class="tb-bars">' + cols + '</div></div><div class="tb-axis">' + axis + "</div></div>";
        }
        function authAlerts(acc, now) {
          var out = [];
          if (!acc) return out;
          var c = acc.claude, cd = acc.codex, g = acc.grok;
          if (c) {
            if (!c.available) out.push({ label: "Claude", level: "err", detail: (c.details && c.details.hint) || "No Claude login is available" });
            var accs = (c.details && c.details.accounts) || acc.accounts || [];
            accs.forEach(function (a) {
              var expired = a.expiresAt && new Date(a.expiresAt).getTime() < now;
              if ((a.refreshFailureCount || 0) > 0) out.push({ label: "Claude · " + a.email, level: "err", detail: "Token refresh failing" + (a.lastError ? (" — " + a.lastError) : "") });
              else if (expired) out.push({ label: "Claude · " + a.email, level: "err", detail: "Token expired — re-login required" });
              else if (a.cooldownUntil && a.cooldownUntil > now) out.push({ label: "Claude · " + a.email, level: "warn", detail: "Cooling down" + (a.lastError ? (" — " + a.lastError) : "") });
            });
          }
          if (cd && cd.details && cd.details.enabled !== false) {
            if (!cd.available) out.push({ label: "Codex", level: "err", detail: cd.details.error || cd.details.hint || "Codex login unavailable" });
          }
          if (g && g.details && g.details.enabled === true) {
            if (!g.available) out.push({ label: "Grok", level: "err", detail: g.details.error || g.details.hint || "Grok login unavailable" });
          }
          return out;
        }

        function applyTheme() {
          document.documentElement.classList.toggle("theme-dark", state.theme === "dark");
          $("btn-theme").innerHTML = state.theme === "dark" ? ICON.sun : ICON.moon;
        }
        function setStatus(msg, tone) {
          state.statusMsg = msg;
          state.statusTone = tone;
          $("dr-status").className = "dr-status";
          $("dr-status-dot").className = "dot " + tone;
          $("dr-status-msg").textContent = msg;
        }

        function loadLive(silent) {
          var key = (state.apiKey || "").trim();
          if (!key) { setStatus("Enter an API key to connect.", "warn"); return; }
          if (loading) return;
          loading = true;
          if (!silent) setStatus("Connecting…", "warn");
          var mk = function (p) {
            return fetch(p, { cache: "no-store", headers: { Authorization: "Bearer " + key } }).then(function (r) {
              return r.text().then(function (t) {
                var b = null;
                try { b = t ? JSON.parse(t) : null; } catch (e) { throw new Error("Expected JSON from " + p); }
                if (!r.ok) throw new Error((b && b.error && b.error.message) || ("HTTP " + r.status + " from " + p));
                return b;
              });
            });
          };
          Promise.all([mk("/admin/accounts"), mk("/admin/usage"), mk("/admin/usage/recent?limit=50")]).then(function (res) {
            lastLoad = Date.now();
            store.accounts = res[0];
            store.usage = res[1];
            store.recent = res[2];
            state.connected = true;
            state.lastLoadedAt = lastLoad;
            try { if (state.remember) localStorage.setItem(STORAGE_KEY, key); else localStorage.removeItem(STORAGE_KEY); } catch (e) {}
            setStatus("Live data connected.", "ok");
            loading = false;
            renderAll();
          }).catch(function (e) {
            state.connected = false;
            setStatus(((e && e.message) || "Failed to load") + ".", "err");
            loading = false;
            renderAll();
          });
        }

        function checkNotify() {
          if (!state.loginAlerts) { notifiedSig = ""; return; }
          var an = authAlerts(store.accounts, Date.now());
          var errs = an.filter(function (a) { return a.level === "err"; });
          var sig = errs.map(function (a) { return a.label; }).join("|");
          if (!sig) { notifiedSig = ""; return; }
          if (sig !== notifiedSig) {
            notifiedSig = sig;
            try {
              if (window.Notification && Notification.permission === "granted") {
                new Notification("ccpa · login-state alert", { body: errs.map(function (a) { return a.label + ": " + a.detail; }).join("; ") });
              }
            } catch (e) {}
          }
        }

        function render() {
          var now = Date.now();
          var connected = state.connected;
          var acc = store.accounts || {};
          var usage = store.usage || {};
          var recent = store.recent || {};
          var srv = acc.server || {};
          var T = usage.totals || {};

          // top bar
          var commit = (srv.build && (srv.build.git_commit || srv.build.commit)) || "local";
          $("bar-meta").textContent = "v" + (srv.version || "—") + " · " + commit + " · up " + (typeof srv.uptime_ms === "number" ? dur(srv.uptime_ms + Math.max(0, now - lastLoad)) : "—");
          $("conn").className = "conn " + (connected ? "ok" : "warn");
          $("conn-dot").className = "dot " + (connected ? "ok" : "warn");
          $("conn-label").textContent = connected ? "Live" : "Offline";
          $("upd").textContent = connected ? agoMs(state.lastLoadedAt, now) : "";

          // hero
          var ps = srv.provider_status || "ok";
          var prov = srv.providers || { total: 0, available: 0, unavailable: [] };
          var grokEnabled = !!(acc.grok && acc.grok.details && acc.grok.details.enabled);
          var anomalies = authAlerts(acc, now);
          if (connected) {
            var statusTone = ps === "ok" ? "ok" : ps === "degraded" ? "warn" : "err";
            $("beacon").className = "beacon " + statusTone;
            $("hero-title").textContent = ps === "ok" ? "All systems operational" : ps === "degraded" ? "Partially degraded" : "Service outage";
            $("hero-sub").textContent = prov.available + " / " + prov.total + " providers ready" +
              (grokEnabled ? "" : " · Grok disabled") +
              ((state.loginAlerts && anomalies.length) ? (" · " + anomalies.length + " login alert" + (anomalies.length > 1 ? "s" : "")) : "") +
              " · updated " + agoMs(state.lastLoadedAt, now);
          } else {
            $("beacon").className = "beacon";
            $("hero-title").textContent = "Not connected";
            $("hero-sub").textContent = "Add an API key in settings to load live metrics.";
          }

          // provider chips
          function chip(name, obj) {
            var det = (obj && obj.details) || {};
            var en = det.enabled !== false;
            var av = !!(obj && obj.available);
            var tone = !connected ? "off" : !en ? "off" : av ? "ok" : "err";
            var st = !connected ? "idle" : !en ? "disabled" : av ? "ready" : "down";
            return '<div class="pchip"><span class="dot ' + tone + '"></span><span class="pchip-n">' + escapeHtml(name) + '</span><span class="pchip-s ' + tone + '">' + escapeHtml(st) + "</span></div>";
          }
          $("hero-chips").innerHTML = chip("Claude", acc.claude) + chip("Codex", acc.codex) + chip("Grok", acc.grok);

          // KPIs
          var recentItems = recent.items || [];
          var recentErrors = recentItems.filter(function (x) { return !x.success; }).length;
          var lat = recentItems.map(function (x) { return x.latencyMs || 0; }).filter(function (x) { return x > 0; });
          var avgLat = lat.length ? Math.round(lat.reduce(function (a, b) { return a + b; }, 0) / lat.length) : 0;
          var dayKeys = Object.keys(usage.requestsByDay || {}).sort();
          var dayItems = dayKeys.map(function (k) { return { value: usage.requestsByDay[k], label: k, short: mdShort(k) }; });
          var dayVals = dayItems.map(function (x) { return x.value; });
          var hourKeys = Object.keys(usage.requestsByHour || {}).sort();
          var hourItems = hourKeys.map(function (k) { return { value: usage.requestsByHour[k], label: k + ":00", short: k }; });
          var srate = T.totalRequests ? T.successCount / T.totalRequests : 0;
          var kpis = [
            { label: "Requests", value: num(T.totalRequests), sub: num(T.successCount) + " ok · " + num(T.failureCount) + " failed", tone: "", spark: spark(dayVals), act: "" },
            { label: "Success rate", value: pct(srate, 1), sub: num(T.failureCount) + " errors since start", tone: srate >= 0.98 ? "ok" : srate >= 0.9 ? "warn" : "err", spark: "", act: "" },
            { label: "Tokens", value: compact(T.totalTokens), sub: compact(T.inputTokens) + " in · " + compact(T.outputTokens) + " out", tone: "", spark: "", act: "" },
            { label: "Cache hit", value: pct(T.cacheHitRate, 0), sub: compact(T.cacheReadInputTokens) + " read · " + compact(T.cacheCreationInputTokens) + " create", tone: "", spark: "", act: "" },
            { label: "Avg latency", value: num(avgLat) + " ms", sub: "over recent " + recentItems.length + " calls", tone: avgLat < 2500 ? "ok" : avgLat < 5000 ? "warn" : "err", spark: "", act: "" },
            { label: "Errors · recent", value: num(recentErrors), sub: recentErrors ? "tap to isolate" : "clean window", tone: recentErrors ? "err" : "ok", spark: "", act: recentErrors ? "filter-error" : "" }
          ];
          $("kpis").innerHTML = kpis.map(function (k) {
            return '<div class="kpi' + (k.act ? " tap" : "") + '"' + (k.act ? ' data-act="' + k.act + '"' : "") + '><div class="kpi-top"><span class="kpi-label">' + escapeHtml(k.label) + "</span>" + (k.spark || "") + '</div><div class="kpi-val mono ' + k.tone + '">' + escapeHtml(k.value) + '</div><div class="kpi-sub">' + escapeHtml(k.sub) + "</div></div>";
          }).join("");

          // charts
          $("chart-req").innerHTML = chartBars(dayItems, "", true, function (i, n) { return i % 3 === 0 || i === n - 1; });
          $("chart-hour").innerHTML = chartBars(hourItems, "hb", false, function (i) { return i % 6 === 0 || i === 23; });
          $("trend-meta").textContent = dayKeys.length + " days · peak " + num(Math.max.apply(null, dayVals.length ? dayVals : [0])) + "/day";
          var busiest = hourItems.reduce(function (a, b) { return b.value > (a ? a.value : -1) ? b : a; }, null);
          $("hour-meta").textContent = "busiest " + (busiest ? (busiest.short + ":00 · " + num(busiest.value)) : "—");

          // provider health
          function pdetail(name, obj) {
            var det = (obj && obj.details) || {};
            var en = det.enabled !== false;
            var av = !!(obj && obj.available);
            var tone = !connected ? "off" : !en ? "off" : av ? "ok" : "err";
            var statusLabel = !connected ? "Idle" : !en ? "Disabled" : av ? "Available" : "Unavailable";
            var rows = [];
            if (connected) {
              if (name === "Claude") {
                var accs = det.accounts || [];
                var ready = accs.filter(function (a) { return a.available; }).length;
                var total = det.accountCount != null ? det.accountCount : accs.length;
                rows.push(["Accounts", String(total)]);
                rows.push(["Ready", ready + " / " + total]);
                if (det.hint) rows.push(["Hint", det.hint]);
              } else {
                if ("authMode" in det) rows.push(["Auth mode", det.authMode || "—"]);
                if (det.accountId) rows.push(["Account", det.accountId]);
                if (det.lastRefresh) rows.push(["Last refresh", timeAgo(det.lastRefresh, now)]);
                if (det.path) rows.push(["Auth file", det.path]);
                if (!en) rows.push(["State", "Not enabled in config"]);
                if (det.error) rows.push(["Error", det.error]);
                if (det.hint && !det.error) rows.push(["Hint", det.hint]);
              }
            }
            var rowsHtml = rows.map(function (r) {
              return '<div class="prow"><span class="prow-k">' + escapeHtml(r[0]) + '</span><span class="prow-v">' + escapeHtml(r[1]) + "</span></div>";
            }).join("");
            return '<div class="prov"><div class="prov-h"><span class="prov-n">' + escapeHtml(name) + '</span><span class="pill ' + tone + '"><span class="dot ' + tone + '"></span>' + escapeHtml(statusLabel) + '</span></div><div class="prov-rows">' + rowsHtml + "</div></div>";
          }
          $("providers").innerHTML = pdetail("Claude", acc.claude) + pdetail("Codex", acc.codex) + pdetail("Grok", acc.grok);

          // accounts
          var accounts = acc.accounts || [];
          $("accounts-title").textContent = (acc.account_count != null ? acc.account_count : accounts.length) + " accounts tracked";
          function ag(k, v, tone) { return '<div class="ag"><span class="ag-k">' + escapeHtml(k) + '</span><span class="ag-v ' + (tone || "") + '">' + escapeHtml(v) + "</span></div>"; }
          if (accounts.length) {
            $("accounts").innerHTML = accounts.map(function (a) {
              var cooling = a.cooldownUntil && a.cooldownUntil > now;
              var expired = a.expiresAt && new Date(a.expiresAt).getTime() < now;
              var refFail = (a.refreshFailureCount || 0) > 0;
              var tone = a.available ? "ok" : cooling ? "warn" : (expired || refFail) ? "err" : "warn";
              var stateLabel = a.available ? "Ready" : cooling ? "Cooling down" : refFail ? "Refresh failing" : expired ? "Expired" : "Unavailable";
              var cd = cooling ? Math.max(0, Math.round((a.cooldownUntil - now) / 1000)) : 0;
              var cooldownText = cooling ? ("resumes in " + cd + "s") : (refFail ? "token refresh is failing" : "");
              return '<div class="acc ' + tone + '">' +
                '<div class="acc-h"><span class="acc-m">' + escapeHtml(a.email || "unknown") + '</span><span class="pill ' + tone + '"><span class="dot ' + tone + '"></span>' + escapeHtml(stateLabel) + "</span></div>" +
                (cooldownText ? '<div class="acc-cd ' + tone + '">' + escapeHtml(cooldownText) + "</div>" : "") +
                '<div class="acc-grid">' +
                  ag("requests", num(a.totalRequests), "") +
                  ag("ok", num(a.totalSuccesses), "ok") +
                  ag("fail", num(a.totalFailures), a.totalFailures > 0 ? "err" : "") +
                  ag("expires", until(a.expiresAt, now), "") +
                  ag("refresh fails", num(a.refreshFailureCount || 0), (a.refreshFailureCount || 0) > 0 ? "err" : "") +
                  ag("next refresh", (a.nextRefreshAttemptAt && a.nextRefreshAttemptAt > now) ? ("in " + dur(a.nextRefreshAttemptAt - now)) : "—", "") +
                "</div>" +
                '<div class="acc-meta">last ok ' + escapeHtml(timeAgo(a.lastSuccessAt, now)) + " · last fail " + escapeHtml(timeAgo(a.lastFailureAt, now)) + " · refreshed " + escapeHtml(timeAgo(a.lastRefreshAt, now)) + "</div>" +
                (a.lastError ? '<div class="acc-err">' + escapeHtml(a.lastError) + "</div>" : "") +
                "</div>";
            }).join("");
          } else {
            $("accounts").innerHTML = '<div class="empty">' + (connected ? "No Claude account is loaded." : "Connect to load account status.") + "</div>";
          }

          // usage breakdown
          var TABS = [["model", "Model", "models"], ["provider", "Provider", "providers"], ["source", "Source", "sources"], ["endpoint", "Endpoint", "endpoints"]];
          $("tabs").innerHTML = TABS.map(function (t) {
            return '<button class="tab ' + (state.tab === t[0] ? "on" : "") + '" data-tab="' + t[0] + '">' + escapeHtml(t[1]) + "</button>";
          }).join("");
          var curTab = TABS.filter(function (t) { return t[0] === state.tab; })[0] || TABS[0];
          $("breakdown-col").textContent = curTab[1];
          var breakStore = usage[curTab[2]] || {};
          var entries = Object.keys(breakStore).map(function (k) { return { name: k, c: breakStore[k] }; }).sort(function (a, b) { return (b.c.totalRequests || 0) - (a.c.totalRequests || 0); });
          var maxReq = entries.reduce(function (m, e) { return Math.max(m, e.c.totalRequests || 0); }, 1);
          if (entries.length) {
            $("breakdown-empty").style.display = "none";
            $("breakdown-tbody").innerHTML = entries.map(function (e) {
              var c = e.c;
              var sharePct = Math.round(((c.totalRequests || 0) / maxReq) * 100);
              return "<tr><td class=\\"c-name mono\\">" + escapeHtml(e.name) +
                "</td><td class=\\"c-share\\"><div class=\\"share\\"><div class=\\"share-f\\" style=\\"width:" + sharePct + "%\\"></div></div></td>" +
                '<td class="num mono">' + num(c.totalRequests) + "</td>" +
                '<td class="num mono ok">' + num(c.successCount) + "</td>" +
                '<td class="num mono ' + (c.failureCount > 0 ? "err" : "dim") + '">' + num(c.failureCount) + "</td>" +
                '<td class="num mono">' + compact(c.totalTokens) + "</td>" +
                '<td class="num mono">' + pct(c.cacheHitRate, 0) + "</td>" +
                '<td class="num mono dim">' + escapeHtml(timeAgo(c.lastRequestAt, now)) + "</td></tr>";
            }).join("");
          } else {
            $("breakdown-tbody").innerHTML = "";
            $("breakdown-empty").style.display = "";
          }

          renderRecent(now, recentItems);
        }

        function renderRecent(now, recentItems) {
          var f = state.filters;
          // filter selects
          var provChoices = ["all"].concat(uniq(recentItems.map(function (x) { return x.provider || "unknown"; })));
          var srcChoices = ["all"].concat(uniq(recentItems.map(function (x) { return x.source || "direct"; })));
          fillSelect($("sel-provider"), provChoices, f.provider, "All providers");
          fillSelect($("sel-source"), srcChoices, f.source, "All sources");
          $("status-seg").innerHTML = [["all", "All"], ["success", "OK"], ["error", "Errors"]].map(function (s) {
            return '<button class="seg-b ' + (f.status === s[0] ? "on" : "") + '" data-status="' + s[0] + '">' + escapeHtml(s[1]) + "</button>";
          }).join("");

          var q = (f.q || "").toLowerCase();
          var filtered = recentItems.filter(function (x) {
            if (f.provider !== "all" && (x.provider || "unknown") !== f.provider) return false;
            if (f.source !== "all" && (x.source || "direct") !== f.source) return false;
            if (f.status === "success" && !x.success) return false;
            if (f.status === "error" && x.success) return false;
            if (q) {
              var hay = ((x.model || "") + " " + (x.endpoint || "") + " " + (x.source || "") + " " + (x.clientIp || "") + " " + (x.provider || "") + " " + ((x.failureContext && x.failureContext.message) || "")).toLowerCase();
              if (hay.indexOf(q) < 0) return false;
            }
            return true;
          });
          $("recent-meta").textContent = "showing " + filtered.length + " of " + recentItems.length;

          if (!filtered.length) {
            $("recent-tbody").innerHTML = "";
            $("recent-empty").style.display = "";
            $("recent-empty").textContent = (f.provider !== "all" || f.source !== "all" || f.status !== "all" || q) ? "No requests match these filters." : (state.connected ? "No recent traffic yet." : "Connect to load recent traffic.");
            return;
          }
          $("recent-empty").style.display = "none";
          $("recent-tbody").innerHTML = filtered.map(function (x, i) {
            var fx = x.failureContext;
            var key = x.id != null ? x.id : i;
            var exp = !!state.expanded[key];
            var chips = [];
            if (fx) {
              if (fx.upstreamStatus != null) chips.push("upstream " + fx.upstreamStatus);
              if (fx.accountEmail) chips.push("acct " + fx.accountEmail);
              var sm = fx.requestSummary || {};
              if (sm.messageCount != null) chips.push("msgs " + sm.messageCount);
              if (sm.inputCount != null) chips.push("input " + sm.inputCount);
              if (sm.toolCount != null) chips.push("tools " + sm.toolCount);
              if (sm.maxTokens != null) chips.push("max " + sm.maxTokens);
              if (sm.stream) chips.push("stream");
              if (fx.cooldownUntil) chips.push("cooldown " + (fx.cooldownUntil > now ? ("in " + Math.round((fx.cooldownUntil - now) / 1000) + "s") : "ended"));
            }
            var cRead = x.cacheReadInputTokens || 0, cCreate = x.cacheCreationInputTokens || 0;
            var tokensSub = (cRead || cCreate) ? ("cache " + compact(cRead) + " / " + compact(cCreate)) : "";
            var rowClass = (x.success ? "" : "err ") + (fx ? "exp" : "");
            var main = '<tr class="rrow ' + rowClass + '"' + (fx ? ' data-row="' + escapeHtml(String(key)) + '"' : "") + ">" +
              '<td><div class="r-abs">' + escapeHtml(clock(x.timestamp)) + '</div><div class="r-ago dim">' + escapeHtml(timeAgo(x.timestamp, now)) + "</div></td>" +
              '<td><div class="mono">' + escapeHtml(x.source || "direct") + '</div><div class="dim r-ua">' + escapeHtml((x.clientIp || "—") + " · " + uaShort(x.userAgent)) + "</div></td>" +
              '<td><span class="tag">' + escapeHtml(x.provider || "unknown") + "</span></td>" +
              '<td class="mono r-ep">' + escapeHtml(x.endpoint || "—") + "</td>" +
              '<td class="mono">' + escapeHtml(x.model || "—") + "</td>" +
              '<td class="num"><span class="stat ' + (x.success ? "ok" : "err") + '">' + escapeHtml(String(x.statusCode || 0)) + "</span>" + (fx ? '<span class="caret ' + (exp ? "open" : "") + '"></span>' : "") + "</td>" +
              '<td class="num mono ' + (x.latencyMs > 5000 ? "warn" : "") + '">' + num(x.latencyMs) + " ms</td>" +
              '<td class="num mono">' + (x.totalTokens ? compact(x.totalTokens) : "—") + (tokensSub ? '<div class="dim r-sub">' + escapeHtml(tokensSub) + "</div>" : "") + "</td>" +
              "</tr>";
            var detail = "";
            if (exp && fx) {
              detail = '<tr class="rdetail"><td colspan="8"><div class="rd"><div class="rd-h"><span class="stat err">' + escapeHtml((fx.stage || "response") + " · " + (fx.kind || "error")) + '</span><span class="rd-msg">' + escapeHtml(fx.message || "-") + "</span></div>" +
                '<div class="rd-chips">' + chips.map(function (c) { return '<span class="chipx">' + escapeHtml(c) + "</span>"; }).join("") + "</div>" +
                (fx.accountLastError ? '<div class="rd-ae">account error · ' + escapeHtml(fx.accountLastError) + "</div>" : "") +
                "</div></td></tr>";
            }
            return main + detail;
          }).join("");
        }

        function renderAlert() {
          var now = Date.now();
          var anomalies = authAlerts(store.accounts, now);
          var alertLevel = anomalies.some(function (a) { return a.level === "err"; }) ? "err" : "warn";
          var alertSig = anomalies.map(function (a) { return a.label + ":" + a.level; }).join("|");
          var hasAnomalies = state.loginAlerts && anomalies.length > 0;
          var showAlert = hasAnomalies && state.alertDismissKey !== alertSig;
          var badge = $("gear-badge");
          if (hasAnomalies) {
            badge.style.display = "";
            badge.className = "gear-badge " + alertLevel;
            badge.textContent = String(anomalies.length);
          } else {
            badge.style.display = "none";
          }
          var el = $("alert");
          if (!showAlert) { el.style.display = "none"; el.innerHTML = ""; return; }
          var items = anomalies.map(function (a) {
            return '<div class="alert-item"><span class="dot ' + a.level + '"></span><span class="alert-l">' + escapeHtml(a.label) + '</span><span class="alert-d">' + escapeHtml(a.detail) + "</span></div>";
          }).join("");
          el.className = "alert " + alertLevel;
          el.style.display = "";
          el.innerHTML = '<div class="alert-ico ' + alertLevel + '">' + ICON.alert + '</div><div class="alert-body"><div class="alert-title">' + escapeHtml(anomalies.length + (anomalies.length === 1 ? " login-state issue detected" : " login-state issues detected")) + '</div><div class="alert-list">' + items + '</div></div><div class="alert-actions"><button class="alert-btn ' + alertLevel + '" data-act="review">Review</button><button class="ibtn" data-act="dismiss" title="Dismiss">' + ICON.close + "</button></div>";
        }

        function uniq(arr) {
          var seen = {}, out = [];
          arr.forEach(function (v) { if (!seen[v]) { seen[v] = 1; out.push(v); } });
          return out;
        }
        function fillSelect(sel, choices, current, allLabel) {
          if (choices.indexOf(current) < 0) { current = "all"; }
          sel.innerHTML = choices.map(function (c) {
            return '<option value="' + escapeHtml(c) + '">' + escapeHtml(c === "all" ? allLabel : c) + "</option>";
          }).join("");
          sel.value = current;
        }

        function renderAll() { render(); renderAlert(); }

        function openSettings() { $("scrim").classList.add("open"); $("drawer").classList.add("open"); }
        function closeSettings() { $("scrim").classList.remove("open"); $("drawer").classList.remove("open"); }

        // ---- events ----
        $("btn-theme").innerHTML = ICON.moon;
        $("btn-refresh").innerHTML = ICON.refresh;
        $("btn-settings").insertAdjacentHTML("afterbegin", ICON.gear);
        $("btn-close").innerHTML = ICON.close;
        $("search-ico").innerHTML = ICON.search;

        document.addEventListener("click", function (e) {
          var t = e.target;
          var actEl = t.closest ? t.closest("[data-act]") : null;
          if (actEl) {
            var act = actEl.getAttribute("data-act");
            if (act === "filter-error") { state.filters.status = "error"; renderAll(); return; }
            if (act === "review") { openSettings(); return; }
            if (act === "dismiss") {
              var an = authAlerts(store.accounts, Date.now());
              state.alertDismissKey = an.map(function (x) { return x.label + ":" + x.level; }).join("|");
              renderAlert();
              return;
            }
          }
          var tabEl = t.closest ? t.closest("[data-tab]") : null;
          if (tabEl) { state.tab = tabEl.getAttribute("data-tab"); renderAll(); return; }
          var segEl = t.closest ? t.closest("[data-status]") : null;
          if (segEl) { state.filters.status = segEl.getAttribute("data-status"); renderAll(); return; }
          var rowEl = t.closest ? t.closest("tr.rrow[data-row]") : null;
          if (rowEl) {
            var key = rowEl.getAttribute("data-row");
            state.expanded[key] = !state.expanded[key];
            renderAll();
            return;
          }
          if (t.id === "btn-refresh" || t.closest("#btn-refresh")) { if ((state.apiKey || "").trim()) loadLive(false); else openSettings(); return; }
          if (t.id === "btn-refresh2" || t.closest("#btn-refresh2")) { loadLive(false); return; }
          if (t.id === "btn-connect") { loadLive(false); return; }
          if (t.id === "btn-settings" || t.closest("#btn-settings")) { openSettings(); return; }
          if (t.id === "btn-close" || t.closest("#btn-close")) { closeSettings(); return; }
          if (t.id === "scrim") { closeSettings(); return; }
          if (t.id === "btn-theme" || t.closest("#btn-theme")) {
            state.theme = state.theme === "dark" ? "light" : "dark";
            try { localStorage.setItem(THEME_KEY, state.theme); } catch (e2) {}
            applyTheme();
            return;
          }
        });

        $("search").addEventListener("input", function (e) { state.filters.q = e.target.value; renderAll(); });
        $("api-key").addEventListener("input", function (e) { state.apiKey = e.target.value; });
        $("remember").addEventListener("change", function (e) { state.remember = e.target.checked; });
        $("interval").addEventListener("change", function (e) {
          state.autoRefreshMs = Number(e.target.value) || 0;
          try { localStorage.setItem(REFRESH_KEY, String(state.autoRefreshMs)); } catch (e2) {}
        });
        $("login-alerts").addEventListener("change", function (e) {
          state.loginAlerts = e.target.checked;
          state.alertDismissKey = "";
          try { localStorage.setItem(ALERTS_KEY, state.loginAlerts ? "1" : "0"); } catch (e2) {}
          if (state.loginAlerts) { try { if (window.Notification && Notification.permission === "default") Notification.requestPermission(); } catch (e3) {} }
          renderAlert();
        });
        document.addEventListener("change", function (e) {
          if (e.target.id === "sel-provider") { state.filters.provider = e.target.value; renderAll(); }
          else if (e.target.id === "sel-source") { state.filters.source = e.target.value; renderAll(); }
        });

        // ---- init ----
        try {
          var savedTheme = localStorage.getItem(THEME_KEY);
          state.theme = savedTheme || (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
        } catch (e) {}
        try { var sk = localStorage.getItem(STORAGE_KEY); if (sk) { state.apiKey = sk; state.remember = true; } } catch (e) {}
        try { var ai = localStorage.getItem(REFRESH_KEY); if (ai != null) state.autoRefreshMs = Number(ai) || 0; } catch (e) {}
        try { var al = localStorage.getItem(ALERTS_KEY); if (al != null) state.loginAlerts = al === "1"; } catch (e) {}

        applyTheme();
        $("api-key").value = state.apiKey;
        $("remember").checked = state.remember;
        $("interval").value = String(state.autoRefreshMs);
        $("login-alerts").checked = state.loginAlerts;

        renderAll();
        if ((state.apiKey || "").trim()) loadLive(false);

        timer = setInterval(function () {
          var now = Date.now();
          if (state.connected) $("upd").textContent = agoMs(state.lastLoadedAt, now);
          checkNotify();
          if (state.connected && state.autoRefreshMs > 0 && now - lastLoad >= state.autoRefreshMs) loadLive(true);
        }, 1000);

        window.addEventListener("beforeunload", function () { if (timer) clearInterval(timer); });
      })();
    </script>
  </body>
</html>`;
}
