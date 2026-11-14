"use client";
import { useMemo } from "react";
import {
  REGISTERED_LIFETIME_POLICY,
  activation,
} from "../lifetime-points/policy";
import { computeLedger, ownView } from "../lifetime-points/ledger";
import { SAMPLE_ACCOUNT, SAMPLE_INPUT } from "../lifetime-points/sample";
import { displayPoints } from "../points/format";
// gf1 G06: admin-only, read-only inspector of the lifetime-points policy. It shows the registered policy, what the owner
// still has to decide, the fixed structure, and the lifetime ledger's result on SAMPLE data (the weekly ledger above
// is not read, changed or converted; review m11). Operator copy in English and Turkish, like the rest of this internal tool.

const COPY = {
  en: {
    title: "Lifetime points policy (owner decision pending)",
    note: "Read-only. Nothing here awards points, changes the weekly ledger or converts earlier results.",
    version: "Registered policy",
    state: "State",
    missing: "Owner decisions still missing",
    fixed: "Fixed structure",
    fixedItems: [
      "No sign-up or welcome points",
      "Referral: 10% of the invited user's eligible activity points, one level, never on tasks",
      "Weekly results stay as published; conversion is a separate owner decision",
    ],
    sample: "Lifetime ledger on SAMPLE data (not an account)",
    sampleNote:
      "Sample events through the lifetime ledger with invented rates. The weekly ledger is not read or changed.",
    total: "Sample total",
  },
  tr: {
    title: "Ömür boyu puan politikası (sahip kararı bekleniyor)",
    note: "Salt okunur. Buradaki hiçbir şey puan vermez, haftalık defteri değiştirmez ya da eski sonuçları dönüştürmez.",
    version: "Kayıtlı politika",
    state: "Durum",
    missing: "Sahibin henüz vermediği kararlar",
    fixed: "Sabit yapı",
    fixedItems: [
      "Kayıt ya da hoş geldin puanı yok",
      "Davet: davet edilenin uygun işlem puanlarının %10'u, tek seviye, görevlere uygulanmaz",
      "Haftalık sonuçlar yayınlandığı gibi kalır; dönüşüm ayrı bir sahip kararıdır",
    ],
    sample: "ÖRNEK veriyle ömür boyu defter (bir hesap değil)",
    sampleNote:
      "Örnek olaylar uydurma oranlarla ömür boyu defterden geçirildi. Haftalık defter okunmaz ve değiştirilmez.",
    total: "Örnek toplam",
  },
} as const;

export function LifetimePolicyInspector({ lang }: { lang: string }) {
  const c = lang === "tr" ? COPY.tr : COPY.en;
  const policy = REGISTERED_LIFETIME_POLICY;
  const state = activation(policy);
  const sample = useMemo(
    () => ownView(computeLedger(SAMPLE_INPUT), SAMPLE_ACCOUNT),
    [],
  );
  return (
    <section className="card" data-testid="lifetime-policy-inspector">
      <h2>{c.title}</h2>
      <p className="micro">{c.note}</p>
      <dl>
        <div>
          <dt>{c.version}</dt>
          <dd>
            <code dir="ltr">{policy.version}</code>
          </dd>
        </div>
        <div>
          <dt>{c.state}</dt>
          <dd>
            <code dir="ltr">{state.state}</code>
          </dd>
        </div>
      </dl>
      {state.state === "PENDING_OWNER_POLICY" && (
        <>
          <h3>{c.missing}</h3>
          <ul data-testid="lifetime-policy-missing">
            {state.missing.map((m) => (
              <li key={m}>
                <code dir="ltr">{m}</code>
              </li>
            ))}
          </ul>
        </>
      )}
      <h3>{c.fixed}</h3>
      <ul>
        {c.fixedItems.map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>
      {sample.state === "COMPUTED" && (
        <>
          <h3>{c.sample}</h3>
          <p className="micro">{c.sampleNote}</p>
          <p data-testid="lifetime-policy-sample-total">
            {c.total}: {displayPoints(sample.totals.totalUnits, lang)}
          </p>
        </>
      )}
    </section>
  );
}
