# `wip web`

[← Back to the README](../README.md)

```sh
wip web            # http://localhost:33333/, or the next free port up to 33352
wip web --port N   # exactly on port N
wip web --local    # only on 127.0.0.1
wip web --open     # and open http://localhost:<port>/ in the browser
wip web status     # this project's servers: port, PID and URL
wip web stop       # stop this project's servers (--port N: only that one)
wip web log -n 20  # the last lines of its log; --follow keeps printing
```

A read-only kanban of the project, served from the binary with nothing external: one board per flow (columns by
`stage` or by phase; each stage in one blue, more transparent stage after stage, with readable text in the light and
dark themes, and no colour for a phase without a stage), «Your turn», open gates, running agents, the history with archived items, each item's runs,
gates and artifacts (Markdown rendered; every artifact is served with a `sandbox` CSP). The item panel also shows
its totals as a compact table, a label on the left and its value on the right: «Clock time», from its creation to
its archive, or to now while it is open; «Work time», its local days with activity at 8 h each, the day of the
archive or the current one counting from 08:00 local; «Agents», the sum of the finished agent runs; and «Waiting on
you», the time an open gate has been waiting. Hovering a label says what the metric measures. A footer closes the
table with the runs —and how many are running— and the gates. An item open all day adds up to 8 h, work before
08:00 adds to the clock but not to work, a day without activity adds nothing, and an archived item keeps both
totals fixed while one in a terminal phase that is not archived keeps counting. The boards follow the
project's flow order (`.wip/config.json`; see [Flows](flows.md#the-order-of-the-flows-on-the-board)). Each flow can be collapsed
from its header, which keeps showing its open items and how many wait on you; the browser remembers the choice
(`localStorage`), and History keeps its `Flow` filter. Requests with a foreign
`Host` header are rejected. Without `--port`, running it again for the same project reports the running one and
exits 0 (with `--open`, it opens the browser on it); otherwise it serves on 33333 and, when something already
accepts connections there (on `127.0.0.1` or `[::1]`) or the port does not bind, tries 33334, 33335… up to 33352,
and exits 3 when all twenty are taken. `WIP_WEB_PORT` moves the first port of that range. `--port N` serves on
exactly N: this project's `wip web` there exits 0, another project's or another program exits 3. Ctrl-C or
`wip web stop` stops it. If no browser opens (`open`, `xdg-open` or `start` fails), `--open` prints a warning and the
server keeps serving.

In `localhost`, `wip web` keeps one tab per origin: the first page of an origin takes a Web Locks lock and keeps it
until it closes. A new page that opens an item (`?item=<flow>/<ID>`, for example from the Kanban) asks the open tab
to hand the origin over; the open tab yields, confirms and tries to close itself, so the user stays in the tab they
just opened. Closing the old tab is best-effort: when the browser refuses, it stays with the notice «This project
moved to another tab.» and no ownership. Every view of the board shows the padlock and the poll status in the
top-left of its header, where the project title used to be; the project name is only the browser tab title. The
padlock is open by default: open means another tab may take the origin over and close this one; clicking it closes
the padlock, and that tab then refuses the takeover, keeps its item and is never closed automatically. The tab that
asked shows its item without focus and the notice «This project is locked in another tab.», and stays open. The
padlock is kept in this tab's history entry, so reloading the tab keeps it closed; a new tab (including one opened
with `window.open`) starts open, the state is not shared with other tabs, and a duplicated tab may inherit it when
the browser copies the history entry. It only blocks the automatic close, and closing the tab by hand always works
(whether `window.close()` works at all still depends on the browser). A new page with no item does not take over: it
only tries to close itself and, if refused, shows «This project is open in another tab.». Origins are scheme, host
and port, so another port has its own tab. The artifact page (`/view/item/.../artifact/...`) is deliberately outside:
it opens in its own tab, with no padlock. On the LAN (`http://<ip>`, where Web Locks is unavailable) and in browsers
without Web Locks every tab is its own page, as before: no deduplication, no message, no notice, and the padlock has
no effect.

While it serves, each server records its PID and port in `.wip/web/<port>.json`, and `.wip/logs/web.log` gets the
start with its addresses, every port skipped, every response with status ≥ 400, every error and the stop; past 1 MB
the log moves to `web.log.1`. `status` and `stop` read only that registry (and a `.wip/web.pid` from an older build):
each entry is checked on its own port through `/health`, which names the project and the PID, and an entry whose
process is gone or whose port answers for someone else is removed. No other port is asked. A project folder moved
while its server runs leaves that server unrecorded: stop it by hand.

Exit codes:

- `wip web status`: 0 at least one server of this project answers · 1 none. It lists one line per server, by port:
  port, PID, `Local:` and `LAN:` URLs (`not answering` for one that accepts connections but does not answer).
- `wip web stop`: 0 stopped (SIGTERM to each, then it waits up to 10 s) · 1 none was running · 3 one did not stop.
  Without `--port` it stops every server of this project; with `--port N`, only the one recorded on N. It never
  signals a process whose `/health` does not name this project and that PID.
- `wip web log`: 0 · 4 no log yet.

**LAN:** without `--local`, `wip web` also listens on your private LAN address and prints it as `LAN:`. Anyone on
that network can then read the board and the item artifacts, with no authentication. Use `--local` on networks you
do not trust.

The optional Claude Code pane is installed by `wip init`: see [The Kanban mod](init.md#the-kanban-mod---kanban) and its
own reference, [`mods/wip-kanban/README.md`](../mods/wip-kanban/README.md). The rest of the command table is in
[Commands](commands.md).
