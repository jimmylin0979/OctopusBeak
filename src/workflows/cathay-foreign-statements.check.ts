import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import {
  admitForeignCurrencyDepositCapture,
} from "../ledger/canonical/foreign-currency-deposit-admission.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./cathay-statements.js")
      return nextResolve("./cathay-statements.ts", context);
    return nextResolve(specifier, context);
  },
});

// The run's collection period reaches the builder as explicit dates, so the
// historical fixture stays inside its range whatever day the check runs.
const oneWeek = { startDate: "2026-08-17", endDate: "2026-08-24" };

const {
  buildCathayForeignCurrencyCaptureInput,
  createCathayForeignCanonicalCaptureCollector,
  deriveCathayForeignAccountNumberEvidence,
  parseCathayApiJson,
} = await import("./cathay-foreign-statements.ts");

const capture = buildCathayForeignCurrencyCaptureInput(
  { account: "CATHAY-FOREIGN-133" },
  "USD",
  oneWeek,
  {
    currencyCode: "USD",
    transferInfos: [
      {
        sequenceNumber: "1",
        transferDate: "2026-08-23",
        debitCreditType: "C",
        amount: "10.00",
        balance: "110.00",
        exRate: "31.50",
        memo: "foreign deposit",
      },
    ],
  },
  "2026-08-24T12:00:00+08:00",
  "cathay-foreign-check-observation-1",
);

assert.equal(capture.accountType, "depository");
assert.equal(capture.accountNo, "CATHAY-FOREIGN-133");
assert.equal(capture.accountNumber, null);
assert.equal(capture.records[0]!.currencyEvidence.currency, "USD");
assert.equal(capture.records[0]!.sourceReportedRate?.baseCurrency, "USD");
assert.equal(capture.records[0]!.sourceReportedRate?.quoteCurrency, "TWD");
assert.equal(capture.records[0]!.sourceReportedRate?.rate, "31.50");
assert.deepEqual(
  admitForeignCurrencyDepositCapture(capture).records[0]!.conversionEvidence
    ?.sourceReportedRate?.amount,
  { coefficient: "315", scale: 1 },
);

// The observed transfer endpoint shape carries numeric JSON tokens in
// content.transferDetails[].transferInfos[].  Parsing those tokens with the
// ordinary JSON parser loses lexical zeroes before canonical admission.
const observedNumericCathayResponse = parseCathayApiJson<{
  content: {
    transferDetails: Array<{
      currencyCode: string;
      transferInfos: Array<Record<string, unknown>>;
    }>;
  };
}>(
  '{"success":true,"content":{"transferDetails":[{"currencyCode":"USD","transferInfos":[{"sequenceNumber":"1","transferDate":"2026-08-23","debitCreditType":"C","amount":10.00,"balance":110.00,"exRate":31.50}]}]}}',
  );
assert.equal(
  observedNumericCathayResponse.content.transferDetails[0]!.transferInfos[0]!
    .amount,
  "10.00",
);
assert.equal(
  observedNumericCathayResponse.content.transferDetails[0]!.transferInfos[0]!
    .balance,
  "110.00",
);
assert.equal(
  observedNumericCathayResponse.content.transferDetails[0]!.transferInfos[0]!
    .exRate,
  "31.50",
);
const numericJsonCapture = buildCathayForeignCurrencyCaptureInput(
  { account: "CATHAY-FOREIGN-133" },
  "USD",
  oneWeek,
  observedNumericCathayResponse.content.transferDetails[0]!,
  "2026-08-24T12:00:00+08:00",
  "cathay-foreign-check-numeric-json",
);
assert.equal(numericJsonCapture.records[0]!.amount, "10.00");
assert.deepEqual(
  admitForeignCurrencyDepositCapture(numericJsonCapture).records[0]!
    .conversionEvidence?.sourceReportedRate?.amount,
  { coefficient: "315", scale: 1 },
);
const collector = createCathayForeignCanonicalCaptureCollector(
  oneWeek,
  "00000000-0000-4000-8000-000000000133",
  () => "2026-08-24T12:00:00+08:00",
);
const syntheticCathayForeignAccountNumber = ["0012", "3456", "7890"].join("");
collector.onStatement(
  { account: syntheticCathayForeignAccountNumber },
  "USD",
  {
    currencyCode: "USD",
    transferInfos: [
      {
        sequenceNumber: "1",
        transferDate: "2026-08-23",
        debitCreditType: "C",
        amount: "10.00",
        balance: "110.00",
        exRate: "31.50",
      },
    ],
  },
);
assert.equal(collector.captures.length, 1);
assert.deepEqual(collector.captures[0]!.accountNumber, {
  value: syntheticCathayForeignAccountNumber,
  kind: "depository-account",
  evidenceVersion: "cathay/foreign-account/account-number-v1",
  sourceField: "R_ACCT_Q_DetailAccount content.detailAccounts[].account",
});
assert.equal(
  collector.captures[0]!.captureOccurrenceId,
  "00000000-0000-4000-8000-000000000133:USD",
);
assert.deepEqual(deriveCathayForeignAccountNumberEvidence("００１２３４５６７８９０"), {
  value: syntheticCathayForeignAccountNumber,
  kind: "depository-account",
  evidenceVersion: "cathay/foreign-account/account-number-v1",
  sourceField: "R_ACCT_Q_DetailAccount content.detailAccounts[].account",
});
assert.equal(deriveCathayForeignAccountNumberEvidence("****7890"), null);
collector.reset();
assert.equal(collector.captures.length, 0);

for (const missingOccurrence of [undefined, "   "] as const) {
  assert.throws(
    () =>
      buildCathayForeignCurrencyCaptureInput(
        { account: "CATHAY-FOREIGN-133" },
        "USD",
        oneWeek,
        {
          currencyCode: "USD",
          transferInfos: [{
            sequenceNumber: "missing-occurrence",
            transferDate: "2026-08-23",
            debitCreditType: "C",
            amount: "10.00",
            balance: "110.00",
          }],
        },
        "2026-08-24T12:00:00+08:00",
        missingOccurrence,
      ),
    /capture occurrence identity/i,
  );
}
assert.throws(
  () =>
    buildCathayForeignCurrencyCaptureInput(
      { account: "CATHAY-FOREIGN-133" },
      "USD",
      oneWeek,
      {
        currencyCode: "USD",
        transferInfos: [
          {
            sequenceNumber: 9007199254740993,
            transferDate: "2026-08-23",
            debitCreditType: "C",
            amount: "10.00",
            balance: "110.00",
          },
        ],
      },
      "2026-08-24T12:00:00+08:00",
      "cathay-foreign-check-unsafe-sequence",
    ),
  /sequence.*(safe|exact)|safe.*sequence/i,
);
assert.throws(
  () =>
    buildCathayForeignCurrencyCaptureInput(
      { account: "CATHAY-FOREIGN-133" },
      "USD",
      oneWeek,
      {
        currencyCode: "USD",
        transferInfos: [
          {
            sequenceNumber: "2",
            transferDate: "2026-08-23",
            debitCreditType: "C",
            amount: 10,
            balance: "110.00",
          },
        ],
      },
      "2026-08-24T12:00:00+08:00",
      "cathay-foreign-check-observation-invalid",
    ),
  /exact decimal string/i,
);
assert.throws(
  () =>
    buildCathayForeignCurrencyCaptureInput(
      { account: "CATHAY-FOREIGN-133" },
      "USD",
      oneWeek,
      {
        currencyCode: "USD",
        transferInfos: [
          {
            sequenceNumber: "3",
            transferDate: "2026-08-23",
            debitCreditType: "C",
            amount: "1,2",
            balance: "110.00",
          },
        ],
      },
      "2026-08-24T12:00:00+08:00",
      "cathay-foreign-check-invalid-grouping",
    ),
  /exact decimal/i,
);

const emptyCathayCapture = buildCathayForeignCurrencyCaptureInput(
  { account: "CATHAY-FOREIGN-EMPTY-133" },
  "USD",
  oneWeek,
  { currencyCode: "USD", transferInfos: [] },
  "2026-08-24T12:00:00+08:00",
  "cathay-foreign-check-empty-observation",
  "provider-explicit-no-data",
);
assert.equal(emptyCathayCapture.zeroResultAuthority, "provider-explicit-no-data");
assert.equal(emptyCathayCapture.records.length, 0);
assert.throws(
  () =>
    buildCathayForeignCurrencyCaptureInput(
      { account: "CATHAY-FOREIGN-AMBIGUOUS-133" },
      "USD",
      oneWeek,
      { currencyCode: "USD", transferInfos: [] },
      "2026-08-24T12:00:00+08:00",
      "cathay-foreign-check-ambiguous-empty",
    ),
  /no-data|empty|terminal/i,
);

// ADR 0147: the foreign statements page is an expected page state. A manual
// run whose page never gets there pauses for the person, and after Hand back
// collection goes on from the page they left; a scheduled run fails the step
// with a step-wait timeout.
{
  const { collectCathayForeignFinancialCaptures } = await import("./cathay-foreign-statements.ts");
  const { FrameScopeTimeoutError } = await import("./frame-scope.ts");
  const { sourceReader } = await import("./provider-response-reader.ts");
  const { strictSourceText } = await import("../lib/automation/source-text.ts");
  type Collect = Parameters<typeof collectCathayForeignFinancialCaptures>;
  type Intervention = Collect[5]["source"]["intervention"];
  const ACCOUNTS_READ = new Error("synthetic stop after the account list was asked for");

  /** A signed-in page that stays on the home page, whatever it is asked to open, until the person moves it. */
  const stuckPage = () => {
    let url = "https://www.cathaybk.com.tw/MyBank/";
    return {
      page: {
        url: () => url,
        goto: async () => null,
        evaluate: async () => "complete",
      } as unknown as Collect[0],
      moveTo: (to: string) => { url = to; },
    };
  };
  const collect = (page: Collect[0], intervention: Intervention) => {
    let accountsRead = 0;
    const run = collectCathayForeignFinancialCaptures(page, oneWeek, [], [], {} as Collect[4], {
      source: {
        reader: sourceReader({ now: () => "2026-08-24T04:00:00.000Z", text: strictSourceText }),
        signal: new AbortController().signal,
        ...(intervention ? { intervention } : {}),
      },
      pageTimeoutMs: 300,
      client: {
        fetchForeignAccounts: async () => { accountsRead += 1; throw ACCOUNTS_READ; },
        fetchTransferDetails: async () => [],
      },
    });
    return { run, accountsRead: () => accountsRead };
  };

  const manual = stuckPage();
  let deadlines = 0;
  const handsBack = collect(manual.page, {
    safePoint: async () => "none",
    deadlineExpired: async () => {
      deadlines += 1;
      manual.moveTo("https://www.cathaybk.com.tw/OnlineBanking/FAcctInq/R0102_FAcctDtlInq_Qry");
      return "handed-back";
    },
  });
  await assert.rejects(handsBack.run, (error: unknown) => error === ACCOUNTS_READ);
  assert.equal(deadlines, 1);
  assert.equal(handsBack.accountsRead(), 1, "after Hand back collection reads the accounts");

  for (const intervention of [{ safePoint: async () => "none" as const, deadlineExpired: async () => "none" as const }, undefined]) {
    const scheduled = collect(stuckPage().page, intervention);
    await assert.rejects(
      scheduled.run,
      (error: unknown) => error instanceof FrameScopeTimeoutError && /foreign statements page/u.test(error.message),
    );
    assert.equal(scheduled.accountsRead(), 0, "a page that never arrived is never read");
  }
}
