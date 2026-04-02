export function renderMonitorPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ccpa Monitor</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f4efe6;
        --panel: rgba(255, 250, 243, 0.92);
        --panel-strong: #fffdf8;
        --line: rgba(95, 71, 47, 0.16);
        --text: #2f2419;
        --muted: #7b6856;
        --accent: #d46a3a;
        --accent-strong: #b94f22;
        --good: #2d7a52;
        --bad: #a43f2f;
        --shadow: 0 22px 64px rgba(58, 33, 14, 0.12);
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        font-family: "Avenir Next", "Segoe UI", sans-serif;
        color: var(--text);
        background:
          radial-gradient(circle at top left, rgba(212, 106, 58, 0.18), transparent 28rem),
          radial-gradient(circle at top right, rgba(72, 128, 108, 0.18), transparent 24rem),
          linear-gradient(180deg, #fbf6ee 0%, var(--bg) 100%);
      }

      .shell {
        width: min(1200px, calc(100vw - 32px));
        margin: 0 auto;
        padding: 32px 0 56px;
      }

      .hero {
        display: grid;
        gap: 20px;
        margin-bottom: 20px;
      }

      .hero-card,
      .panel {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 24px;
        box-shadow: var(--shadow);
        backdrop-filter: blur(10px);
      }

      .hero-card {
        padding: 28px;
      }

      h1,
      h2,
      h3,
      p {
        margin: 0;
      }

      h1 {
        font-size: clamp(2.2rem, 5vw, 4.4rem);
        line-height: 0.95;
        letter-spacing: -0.05em;
      }

      .lede {
        max-width: 720px;
        margin-top: 14px;
        font-size: 1rem;
        line-height: 1.6;
        color: var(--muted);
      }

      .endpoint-strip {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 20px;
      }

      .endpoint-pill {
        padding: 8px 12px;
        border-radius: 999px;
        border: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.72);
        color: var(--muted);
        font-family: "JetBrains Mono", "SFMono-Regular", monospace;
        font-size: 0.8rem;
      }

      .auth-card {
        padding: 22px;
        display: grid;
        gap: 16px;
      }

      .auth-grid {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto auto;
        gap: 12px;
        align-items: end;
      }

      label {
        display: grid;
        gap: 8px;
        font-size: 0.86rem;
        font-weight: 600;
        color: var(--muted);
      }

      input[type="password"] {
        width: 100%;
        padding: 14px 16px;
        border-radius: 14px;
        border: 1px solid var(--line);
        background: var(--panel-strong);
        color: var(--text);
        font: inherit;
      }

      .checkbox {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        font-size: 0.9rem;
        color: var(--muted);
        font-weight: 500;
      }

      button {
        height: 48px;
        padding: 0 18px;
        border: 0;
        border-radius: 14px;
        background: linear-gradient(135deg, var(--accent) 0%, var(--accent-strong) 100%);
        color: white;
        font: inherit;
        font-weight: 700;
        cursor: pointer;
      }

      button.secondary {
        background: rgba(255, 255, 255, 0.84);
        color: var(--text);
        border: 1px solid var(--line);
      }

      .status-row {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        align-items: center;
        justify-content: space-between;
      }

      .status-note {
        color: var(--muted);
        font-size: 0.92rem;
      }

      .status-pill {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        border-radius: 999px;
        font-size: 0.84rem;
        font-weight: 700;
      }

      .status-pill.good {
        background: rgba(45, 122, 82, 0.12);
        color: var(--good);
      }

      .status-pill.bad {
        background: rgba(164, 63, 47, 0.12);
        color: var(--bad);
      }

      .grid {
        display: grid;
        gap: 18px;
        grid-template-columns: repeat(12, minmax(0, 1fr));
        margin-top: 20px;
      }

      .panel {
        padding: 22px;
        grid-column: span 12;
      }

      .panel.span-4 {
        grid-column: span 4;
      }

      .panel.span-6 {
        grid-column: span 6;
      }

      .panel-header {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: flex-start;
        margin-bottom: 16px;
      }

      .panel-kicker {
        display: block;
        margin-bottom: 6px;
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.14em;
        font-size: 0.72rem;
      }

      .metric {
        display: grid;
        gap: 6px;
      }

      .metric-value {
        font-size: 2rem;
        line-height: 1;
        letter-spacing: -0.04em;
      }

      .metric-subtle {
        color: var(--muted);
        font-size: 0.9rem;
      }

      .provider-stack,
      .account-stack {
        display: grid;
        gap: 12px;
      }

      .provider-card,
      .account-card {
        padding: 14px 16px;
        border: 1px solid var(--line);
        border-radius: 18px;
        background: rgba(255, 255, 255, 0.68);
      }

      .provider-title,
      .account-title {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        margin-bottom: 8px;
      }

      .muted {
        color: var(--muted);
      }

      .tiny {
        font-size: 0.85rem;
      }

      table {
        width: 100%;
        border-collapse: collapse;
      }

      th,
      td {
        padding: 10px 8px;
        border-top: 1px solid var(--line);
        text-align: left;
        vertical-align: top;
        font-size: 0.92rem;
      }

      th {
        color: var(--muted);
        font-size: 0.76rem;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      code {
        font-family: "JetBrains Mono", "SFMono-Regular", monospace;
        font-size: 0.84rem;
      }

      .empty {
        padding: 18px;
        border-radius: 16px;
        border: 1px dashed var(--line);
        color: var(--muted);
        background: rgba(255, 255, 255, 0.44);
      }

      .footer-note {
        margin-top: 22px;
        color: var(--muted);
        font-size: 0.86rem;
        line-height: 1.6;
      }

      @media (max-width: 960px) {
        .panel.span-4,
        .panel.span-6 {
          grid-column: span 12;
        }

        .auth-grid {
          grid-template-columns: 1fr;
        }

        button {
          width: 100%;
        }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <section class="hero">
        <div class="hero-card">
          <h1>ccpa Monitor</h1>
          <p class="lede">
            Browser dashboard for the local proxy. This page never embeds live stats server-side.
            Enter an API key, then it will fetch the existing admin JSON endpoints over same-origin
            requests.
          </p>
          <div class="endpoint-strip">
            <span class="endpoint-pill">/admin/accounts</span>
            <span class="endpoint-pill">/admin/usage</span>
            <span class="endpoint-pill">/admin/usage/recent</span>
          </div>
        </div>

        <form id="auth-form" class="hero-card auth-card">
          <div class="status-row">
            <div>
              <h2>Live Access</h2>
              <p class="status-note">Use the same API key as your scripts. Existing /admin routes stay protected.</p>
            </div>
            <div id="connection-status" class="status-pill bad">Waiting for API key</div>
          </div>

          <div class="auth-grid">
            <label>
              API key
              <input id="api-key" type="password" placeholder="sk-..." autocomplete="off" />
            </label>
            <label class="checkbox">
              <input id="remember-key" type="checkbox" />
              Remember on this browser
            </label>
            <div style="display:flex; gap:12px; flex-wrap:wrap;">
              <button type="submit">Load Dashboard</button>
              <button id="refresh-button" class="secondary" type="button">Refresh</button>
            </div>
          </div>

          <div class="status-row">
            <p id="status-note" class="status-note">No live data loaded yet.</p>
            <p id="updated-at" class="status-note"></p>
          </div>
        </form>
      </section>

      <section class="grid">
        <article class="panel span-4">
          <div class="panel-header">
            <div>
              <span class="panel-kicker">Traffic</span>
              <h2>Total Requests</h2>
            </div>
          </div>
          <div class="metric">
            <div id="metric-total-requests" class="metric-value">0</div>
            <div id="metric-success-failure" class="metric-subtle">No data yet</div>
          </div>
        </article>

        <article class="panel span-4">
          <div class="panel-header">
            <div>
              <span class="panel-kicker">Tokens</span>
              <h2>Total Tokens</h2>
            </div>
          </div>
          <div class="metric">
            <div id="metric-total-tokens" class="metric-value">0</div>
            <div id="metric-token-breakdown" class="metric-subtle">No data yet</div>
          </div>
        </article>

        <article class="panel span-4">
          <div class="panel-header">
            <div>
              <span class="panel-kicker">Recent</span>
              <h2>Recent Window</h2>
            </div>
          </div>
          <div class="metric">
            <div id="metric-recent-count" class="metric-value">0</div>
            <div id="metric-generated-at" class="metric-subtle">No data yet</div>
          </div>
        </article>

        <article class="panel span-6">
          <div class="panel-header">
            <div>
              <span class="panel-kicker">Providers</span>
              <h2>Provider Status</h2>
            </div>
          </div>
          <div id="provider-status" class="provider-stack">
            <div class="empty">Load the dashboard to inspect Claude and Codex availability.</div>
          </div>
        </article>

        <article class="panel span-6">
          <div class="panel-header">
            <div>
              <span class="panel-kicker">Accounts</span>
              <h2>Claude Account Snapshot</h2>
            </div>
          </div>
          <div id="account-status" class="account-stack">
            <div class="empty">No account data loaded yet.</div>
          </div>
        </article>

        <article class="panel span-6">
          <div class="panel-header">
            <div>
              <span class="panel-kicker">Breakdown</span>
              <h2>Providers & Endpoints</h2>
            </div>
          </div>
          <div id="providers-table"></div>
          <div style="height:16px;"></div>
          <div id="endpoints-table"></div>
        </article>

        <article class="panel span-6">
          <div class="panel-header">
            <div>
              <span class="panel-kicker">Models</span>
              <h2>Model Activity</h2>
            </div>
          </div>
          <div id="models-table"></div>
        </article>

        <article class="panel">
          <div class="panel-header">
            <div>
              <span class="panel-kicker">Recent Requests</span>
              <h2>Latest Calls</h2>
            </div>
          </div>
          <div id="recent-table"></div>
          <p class="footer-note">
            The dashboard shell is public on this local process, but live data still requires a valid API key.
            Metrics remain memory-only and reset when the proxy process restarts.
          </p>
        </article>
      </section>
    </main>

    <script>
      (function () {
        var STORAGE_KEY = "ccpa-monitor-api-key";
        var AUTO_REFRESH_MS = 15000;
        var ENDPOINTS = {
          accounts: "/admin/accounts",
          usage: "/admin/usage",
          recent: "/admin/usage/recent?limit=20"
        };

        var keyInput = document.getElementById("api-key");
        var rememberInput = document.getElementById("remember-key");
        var authForm = document.getElementById("auth-form");
        var refreshButton = document.getElementById("refresh-button");
        var statusNote = document.getElementById("status-note");
        var updatedAt = document.getElementById("updated-at");
        var connectionStatus = document.getElementById("connection-status");
        var refreshTimer = null;

        function setConnectionStatus(ok, text) {
          connectionStatus.textContent = text;
          connectionStatus.className = "status-pill " + (ok ? "good" : "bad");
        }

        function escapeHtml(value) {
          return String(value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
        }

        function formatNumber(value) {
          var number = typeof value === "number" && Number.isFinite(value) ? value : 0;
          return new Intl.NumberFormat().format(number);
        }

        function formatDate(value) {
          if (!value) return "Never";
          var date = new Date(value);
          if (Number.isNaN(date.getTime())) return String(value);
          return date.toLocaleString();
        }

        function maybePersistKey(apiKey) {
          if (rememberInput.checked) {
            localStorage.setItem(STORAGE_KEY, apiKey);
          } else {
            localStorage.removeItem(STORAGE_KEY);
          }
        }

        async function fetchJson(path, apiKey) {
          var response = await fetch(path, {
            headers: {
              Authorization: "Bearer " + apiKey
            }
          });
          var text = await response.text();
          var body = null;

          try {
            body = text ? JSON.parse(text) : null;
          } catch (_error) {
            throw new Error("Expected JSON from " + path + " but received: " + text.slice(0, 160));
          }

          if (!response.ok) {
            var message =
              body && body.error && body.error.message
                ? body.error.message
                : "HTTP " + response.status + " from " + path;
            throw new Error(message);
          }

          return body;
        }

        function renderProviderCard(name, provider) {
          var available = !!(provider && provider.available);
          var details = provider && provider.details ? provider.details : {};
          var meta = [];

          if (typeof details.accountCount === "number") meta.push("accounts: " + details.accountCount);
          if (typeof details.enabled === "boolean") meta.push("enabled: " + details.enabled);
          if (details.authMode) meta.push("auth: " + details.authMode);
          if (details.accountId) meta.push("account: " + details.accountId);
          if (details.lastRefresh) meta.push("last refresh: " + formatDate(details.lastRefresh));
          if (details.path) meta.push("path: " + details.path);
          if (details.hint) meta.push("hint: " + details.hint);
          if (details.error) meta.push("error: " + details.error);

          return (
            '<div class="provider-card">' +
              '<div class="provider-title">' +
                "<strong>" + escapeHtml(name) + "</strong>" +
                '<span class="status-pill ' + (available ? "good" : "bad") + '">' +
                  escapeHtml(available ? "Available" : "Unavailable") +
                "</span>" +
              "</div>" +
              '<div class="muted tiny">' + escapeHtml(meta.join(" | ") || "No extra details") + "</div>" +
            "</div>"
          );
        }

        function renderAccountCard(account) {
          return (
            '<div class="account-card">' +
              '<div class="account-title">' +
                "<strong>" + escapeHtml(account.email || "unknown") + "</strong>" +
                '<span class="status-pill ' + (account.available ? "good" : "bad") + '">' +
                  escapeHtml(account.available ? "Ready" : "Cooling Down") +
                "</span>" +
              "</div>" +
              '<div class="muted tiny">' +
                "requests: " + formatNumber(account.totalRequests) +
                " | success: " + formatNumber(account.totalSuccesses) +
                " | failure: " + formatNumber(account.totalFailures) +
                " | expires: " + escapeHtml(formatDate(account.expiresAt)) +
              "</div>" +
              '<div class="muted tiny" style="margin-top:6px;">' +
                "last success: " + escapeHtml(formatDate(account.lastSuccessAt)) +
                " | last failure: " + escapeHtml(formatDate(account.lastFailureAt)) +
                " | last refresh: " + escapeHtml(formatDate(account.lastRefreshAt)) +
              "</div>" +
              (account.lastError
                ? '<div class="muted tiny" style="margin-top:6px;">last error: ' + escapeHtml(account.lastError) + "</div>"
                : "") +
            "</div>"
          );
        }

        function renderCounterTable(title, rows) {
          if (!rows.length) {
            return '<div><h3 style="margin-bottom:12px;">' + escapeHtml(title) + '</h3><div class="empty">No data yet.</div></div>';
          }

          var body = rows
            .map(function (entry) {
              return (
                "<tr>" +
                  "<td><code>" + escapeHtml(entry.name) + "</code></td>" +
                  "<td>" + formatNumber(entry.counter.totalRequests) + "</td>" +
                  "<td>" + formatNumber(entry.counter.successCount) + "</td>" +
                  "<td>" + formatNumber(entry.counter.failureCount) + "</td>" +
                  "<td>" + formatNumber(entry.counter.totalTokens) + "</td>" +
                  "<td>" + escapeHtml(formatDate(entry.counter.lastRequestAt)) + "</td>" +
                "</tr>"
              );
            })
            .join("");

          return (
            "<div>" +
              "<h3 style=\\"margin-bottom:12px;\\">" + escapeHtml(title) + "</h3>" +
              "<table>" +
                "<thead><tr><th>Name</th><th>Requests</th><th>Success</th><th>Failure</th><th>Tokens</th><th>Last Seen</th></tr></thead>" +
                "<tbody>" + body + "</tbody>" +
              "</table>" +
            "</div>"
          );
        }

        function renderRecentTable(items) {
          if (!items.length) {
            return '<div class="empty">No recent traffic yet.</div>';
          }

          return (
            "<table>" +
              "<thead><tr><th>When</th><th>Provider</th><th>Endpoint</th><th>Model</th><th>Status</th><th>Latency</th><th>Tokens</th></tr></thead>" +
              "<tbody>" +
                items.map(function (item) {
                  return (
                    "<tr>" +
                      "<td>" + escapeHtml(formatDate(item.timestamp)) + "</td>" +
                      "<td><code>" + escapeHtml(item.provider || "unknown") + "</code></td>" +
                      "<td><code>" + escapeHtml(item.endpoint || "-") + "</code></td>" +
                      "<td><code>" + escapeHtml(item.model || "-") + "</code></td>" +
                      "<td>" + escapeHtml(String(item.statusCode || "-")) + (item.success ? " ok" : " fail") + "</td>" +
                      "<td>" + formatNumber(item.latencyMs) + " ms</td>" +
                      "<td>" + formatNumber(item.totalTokens) + "</td>" +
                    "</tr>"
                  );
                }).join("") +
              "</tbody>" +
            "</table>"
          );
        }

        function sortCounterEntries(store) {
          return Object.entries(store || {})
            .map(function (entry) {
              return { name: entry[0], counter: entry[1] };
            })
            .sort(function (a, b) {
              return (b.counter.totalRequests || 0) - (a.counter.totalRequests || 0);
            });
        }

        function renderDashboard(accounts, usage, recent) {
          document.getElementById("metric-total-requests").textContent = formatNumber(usage.totals.totalRequests);
          document.getElementById("metric-success-failure").textContent =
            "success " + formatNumber(usage.totals.successCount) + " | failure " + formatNumber(usage.totals.failureCount);

          document.getElementById("metric-total-tokens").textContent = formatNumber(usage.totals.totalTokens);
          document.getElementById("metric-token-breakdown").textContent =
            "input " + formatNumber(usage.totals.inputTokens) + " | output " + formatNumber(usage.totals.outputTokens);

          document.getElementById("metric-recent-count").textContent = formatNumber(usage.recentCount);
          document.getElementById("metric-generated-at").textContent = "usage snapshot " + formatDate(usage.generatedAt);

          document.getElementById("provider-status").innerHTML =
            renderProviderCard("Claude", accounts.claude) +
            renderProviderCard("Codex", accounts.codex);

          var accountCards = (accounts.accounts || []).map(renderAccountCard);
          document.getElementById("account-status").innerHTML = accountCards.length
            ? accountCards.join("")
            : '<div class="empty">No Claude account is loaded.</div>';

          document.getElementById("providers-table").innerHTML =
            renderCounterTable("By Provider", sortCounterEntries(usage.providers));
          document.getElementById("endpoints-table").innerHTML =
            renderCounterTable("By Endpoint", sortCounterEntries(usage.endpoints));
          document.getElementById("models-table").innerHTML =
            renderCounterTable("By Model", sortCounterEntries(usage.models));
          document.getElementById("recent-table").innerHTML =
            renderRecentTable(recent.items || []);

          updatedAt.textContent =
            "accounts " + formatDate(accounts.generated_at) +
            " | recent " + formatDate(recent.generatedAt);
        }

        async function loadDashboard() {
          var apiKey = keyInput.value.trim();
          if (!apiKey) {
            setConnectionStatus(false, "Missing API key");
            statusNote.textContent = "Enter an API key to load live monitoring data.";
            return;
          }

          maybePersistKey(apiKey);
          setConnectionStatus(false, "Loading");
          statusNote.textContent = "Fetching /admin/accounts, /admin/usage, and /admin/usage/recent...";

          try {
            var results = await Promise.all([
              fetchJson(ENDPOINTS.accounts, apiKey),
              fetchJson(ENDPOINTS.usage, apiKey),
              fetchJson(ENDPOINTS.recent, apiKey)
            ]);

            renderDashboard(results[0], results[1], results[2]);
            setConnectionStatus(true, "Live data connected");
            statusNote.textContent = "Dashboard refreshed successfully.";
          } catch (error) {
            setConnectionStatus(false, "Load failed");
            statusNote.textContent = error instanceof Error ? error.message : String(error);
          }
        }

        authForm.addEventListener("submit", function (event) {
          event.preventDefault();
          loadDashboard();
        });

        refreshButton.addEventListener("click", function () {
          loadDashboard();
        });

        var savedKey = localStorage.getItem(STORAGE_KEY);
        if (savedKey) {
          keyInput.value = savedKey;
          rememberInput.checked = true;
        }

        refreshTimer = window.setInterval(function () {
          if (keyInput.value.trim()) {
            loadDashboard();
          }
        }, AUTO_REFRESH_MS);

        window.addEventListener("beforeunload", function () {
          if (refreshTimer) {
            clearInterval(refreshTimer);
          }
        });
      })();
    </script>
  </body>
</html>`;
}
