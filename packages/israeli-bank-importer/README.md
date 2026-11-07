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
4. Generate a public domain only when Hapoalim SMS approval is needed.
5. Add `ISRAELI_BANK_IMPORTER_CONFIG` as a secret variable. You may set
   `SCHEDULE`, `TZ`, `DRY_RUN`, and `OTP_SUBMISSION_TOKEN` separately.

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
  "importFromDate": "2026-11-05",
  "pendingGraceDays": 7,
  "dryRun": true
}
```

`importFromDate` is optional. Set it to the first date you want imported, as
`YYYY-MM-DD`. The worker asks the bank for transactions from that date and
skips anything older, including on later redeploys. Omit it to keep the default
window of about two years. Changing this value does not delete transactions
already stored in Actual.

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
- Transactions dated before `importFromDate` are ignored. Completed transactions
  already in Actual remain until you delete them.
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

The browser profile is persisted under `/data/chrome-data`. Hapoalim may send
an SMS when it does not recognize that browser. To handle this:

1. Generate a strong secret, for example with `openssl rand -hex 32`, and set it
   as the Railway variable `OTP_SUBMISSION_TOKEN`.
2. Generate a Railway public domain for the importer service.
3. When the log contains `"event":"hapoalim_otp_required"`, submit the SMS code:

```sh
curl -X POST https://your-importer.up.railway.app/otp \
  -H "Authorization: Bearer YOUR_OTP_SUBMISSION_TOKEN" \
  -d "code=123456"
```

The endpoint accepts a code only while Hapoalim is waiting for one and never
logs or stores it. It waits for five minutes. The successful browser profile is
kept on the Railway volume, so Hapoalim may skip SMS approval on later runs.

`GET /health` reports whether the importer is currently waiting for a code.
Keep the public domain and submission token private. Password changes require
updating the Railway secret and redeploying.
