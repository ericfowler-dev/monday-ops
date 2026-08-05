# Order Tracker Operations board view

This folder contains a private monday.com board view for the Order Tracker board.
It reads data as the signed-in monday user, calculates the same operational
metrics as the SNAP email report, and renders an interactive dashboard inside
the board.

## Included in the first version

- Active Factory, Field, and intake totals
- New-order counts for the last 7 and 30 calendar days, based on Order Date
- Closed throughput for 7, 14, and 30 calendar days
- Factory and Field status, aging, priority, and attention views
- Recent shipments with links back to individual orders
- Manual refresh and automatic refresh after supported board events
- Monday light/dark theme support
- Activity-history fallback for removed completed items

## Local development

Install the dashboard dependencies once:

```powershell
cd snap-dashboard
npm install
```

Run a browser preview with representative mock data:

```powershell
npm run dev:mock
```

Validate and build the production client:

```powershell
npm test
npm run build
```

The deployable client is written to `snap-dashboard/dist/`. Production builds
do not contain the mock dataset path; the view authenticates through the monday
SDK and uses the permissions of the user viewing the board.

## monday app registration

The private app was created with monday's CLI on July 15, 2026 and most
recently deployed on August 5, 2026:

- App: **Order Tracker Operations** (`11712414`)
- Live version: `16655568` (v6)
- Board view: **Operations Dashboard** (`269944734`)
- Permission: `boards:read`

Note: a live app version pins its board-view feature to a specific CDN URL.
Pushing client code to a *different* version's deployment does not change what
the live view serves. Keep the feature's build URL and the pushed version in
sync (see `monday-manifest.json`).

The feature is intentionally restricted in code to board `18414349860` so it
cannot silently calculate against a board with different groups or columns.

## Deploy the client to monday

Install and initialize monday's CLI if it is not already available:

```powershell
npm install -g @mondaycom/apps-cli
mapps init
```

Build and upload the client-side bundle to the current app version:

```powershell
npm run build
mapps code:push --client-side --directoryPath .\dist --appVersionId 16655568 --force
```

(`--force` is required once the version is live.) The current production
client is hosted by monday at:

`https://v4048abecef92e64145464b273354114c.cdn2.monday.app`

The version has been promoted to live. To make it available to account users,
open the app in Developer Center, select **Distribute → Install app**, and click
**Install App**. Then add **Operations Dashboard** from the plus menu beneath the
Order Tracker board title.

## Required account confirmation

The CLI can create, upload, and promote the app, but monday intentionally requires
an authorized account user to confirm installation through Developer Center.
