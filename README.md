# OpenHands Apps

> [!WARNING]
> This project is in the **Alpha** phase. It may be vibecoded, untested, or out of date. OpenHands takes no responsibility for the code or its support. [Learn more](https://github.com/OpenHands/incubator-program).

[![Project Status: Alpha](https://img.shields.io/badge/status-alpha-yellow)](https://github.com/OpenHands/incubator-program)

Apps are a way of extending [OpenHands](https://github.com/OpenHands/OpenHands) with custom UIs and backends.
This is still an experimental project; expect breaking API changes.

You can install these Apps by going to Customize -> Apps -> Add App, then setting `https://github.com/OpenHands/canvas-apps`
as the source, and the name of the app you want to install as the path.

## Kanban Manager moved to extensions

Kanban Manager is maintained in
[`OpenHands/extensions/apps/kanban-manager`](https://github.com/OpenHands/extensions/tree/main/apps/kanban-manager).
In Canvas **Customize -> Apps -> Add app**, use source
`https://github.com/OpenHands/extensions` and path `apps/kanban-manager`, at a
reviewed revision that contains the app. It is a beta App; installation leaves
it disabled until you choose to enable trusted code.

Existing installed copies are not deleted by this repository change. Their
Update action still targets the old source coordinates, so switch deliberately:
disable the old App, uninstall its package, install from the new source on the
same backend, and enable it. Keep the name `kanban-manager` and preserve
`~/.openhands/vibe-manager/`; do not delete board data or existing manager
automations. The old source remains available at
[`b83068fdce5ec7f85c07b8aefa15d413982059d0`](https://github.com/OpenHands/canvas-apps/tree/b83068fdce5ec7f85c07b8aefa15d413982059d0/kanban-manager)
for a pinned rollback.

This move covers the merged file-backed Kanban only. The separate
[React/FastAPI/SQLite rewrite in PR #21](https://github.com/OpenHands/canvas-apps/pull/21)
is not migrated or deleted from its branch; a future port needs a separate
review and data plan.
