# Israeli bank importer

This private worker imports Bank Hapoalim current-account and Visa CAL card
transactions into Actual. It is designed to run as a second Railway service
beside the Actual server.

It uses browser automation, not an official bank API. Bank-site changes,
password changes, and authentication challenges can interrupt synchronization.
Review its logs and keep the Railway volume private.

## Railway service

1. Create another service in the same Railway project from this repository.
2. Set its Dockerfile path to `Dockerfile.importer.railway`.
3. Attach a persistent volume mounted at `/data`.
4. Do not generate a public domain for this worker.
5. Add `ISRAELI_BANK_IMPORTER_CONFIG` as a secret variable. You may set
   `SCHEDULE`, `TZ`, and `DRY_RUN` separately.

The worker runs once at startup. If `SCHEDULE` is configured, it remains active
and runs on that cron schedule. A reasonable starting value is `0 */6 * * *`.
The default timezone is `Asia/Jerusalem`.

## Secret configuration

The value of `ISRAELI_BANK_IMPORTER_CONFIG` is JSON:

```json
{
  "actual": {
    "serverURL": "https://your-actual-server.up.railway.app",
    "password": "actual-server-password",
    "syncId": "actual-budget-sync-id",
    "budgetPassword": "optional-budget-encryption-password"
  },
  "banks": [
    {
      "companyId": "hapoalim",
      "credentials": {
        "userCode": "bank-user-code",
        "password": "bank-password"
      },
      "targets": [
        {
          "actualAccountId": "actual-account-id",
          "sourceAccountNumbers": "all"
        }
      ]
    },
    {
      "companyId": "visaCal",
      "credentials": {
        "username": "cal-username",
        "password": "cal-password"
      },
      "targets": [
        {
          "actualAccountId": "actual-card-account-id",
          "sourceAccountNumbers": ["1234"]
        }
      ]
    }
  ],
  "pendingGraceDays": 7,
  "dryRun": true
}
```

`sourceAccountNumbers` contains Hapoalim account identifiers or CAL card last
four digits returned by the scraper. Use `"all"` for an initial dry run; the
worker logs unmapped source identifiers without printing credentials.

Use `sessionToken` instead of `password` in the `actual` object when the Actual
server is configured for token authentication.

## Safe rollout

1. Start with `"dryRun": true` and confirm both institutions and mappings in
   Railway logs.
2. Change it to `false` and run once with no `SCHEDULE`.
3. Check imported payees, rules, pending entries, and foreign-currency values in
   Actual.
4. Add `SCHEDULE=0 */6 * * *` after the first import looks correct.

Never commit the JSON configuration or paste credentials into source files.
Railway secret variables are exposed to the worker process, while `/data`
contains its downloaded Actual data, Chromium profile, and pending state.

## Transaction behavior

- Completed transactions are cleared and deduplicated with stable import IDs.
- Pending Hapoalim and CAL transactions are uncleared.
- When settlement can be matched, the pending row is updated in place.
- A pending row absent from the source for seven days is removed unless it was
  manually cleared or reconciled.
- USD and EUR purchases use Actual's foreign amount/currency columns and an
  estimated ILS amount while pending.
- Other currencies keep the provisional/final ILS amount in the normal Amount
  column and append the original amount and ISO currency to Notes.
- Actual transaction rules run when a transaction is first imported.

The pending ILS value is an estimate because CAL does not expose a final
conversion until settlement. Settlement replaces it with CAL's final amount.

## Authentication maintenance

The browser profile is persisted under `/data/chrome-data`. If Hapoalim or CAL
requires an interactive challenge that cannot be completed headlessly, pause
the schedule, authenticate with the same importer image in an interactive
environment using the persisted profile, then restore that profile to the
Railway volume. Password changes require updating the Railway secret and
redeploying.
