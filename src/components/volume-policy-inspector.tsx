"use client";
import { useMemo } from "react";
import {
  REGISTERED_VOLUME_POLICY,
  computeVolumeLedger,
  ownVolumeView,
  volumeActivation,
} from "../lifetime-points/volume";
import {
  VOLUME_SAMPLE_ACCOUNT,
  VOLUME_SAMPLE_INPUT,
} from "../lifetime-points/volume-sample";
import { displayPoints } from "../points/format";
// G12 H05: admin-only, read-only inspector of the owner's newer rule (1 point per 100 USD of verified volume). It shows
// the registered policy, every decision the owner still has to make before anything can be activated, and the volume
// ledger's result on SAMPLE data. Nothing here awards points, reads or changes the weekly ledger, or converts earlier
// results. Operator copy in English and Turkish, like the rest of this internal tool.

const COPY = {
  en: {
    title: "Volume points policy: 1 point per 100 USD (owner decision pending)",
    note: "Read-only. Not active: no real point is computed from this policy. Activation is a separate owner step after the policy fields below are decided; the abuse.* and verifier.* items are NOT defended by this build and need their own decision or verifier contract first. This newer rule supersedes the fixed-points draft shown above once the owner confirms it.",
    version: "Registered policy",
    state: "State",
    missing: "Owner decisions still missing",
    reading:
      "Engineering reading to confirm: cumulative verified, settled volume per account; one whole point per full 100 USD; the remainder is kept toward the next point (40 + 60 USD = 1 point; 250 USD = 2 points and 50 USD carried). Referral: 10% of the invited account's activity points, one level; a point completed after the invitation counts whole, even if most of its volume came before.",
    sample: "Volume ledger on SAMPLE data (not an account)",
    total: "Sample total",
  },
  tr: {
    title:
      "Hacim puanı politikası: her 100 USD'ye 1 puan (sahip kararı bekleniyor)",
    note: "Salt okunur. Etkin değil: bu politikadan gerçek puan hesaplanmaz. Etkinleştirme, aşağıdaki politika alanları kararlaştırıldıktan sonra ayrı bir sahip adımıdır; abuse.* ve verifier.* maddeleri bu sürümde SAVUNULMUYOR ve önce kendi kararını ya da doğrulayıcı sözleşmesini gerektirir. Bu yeni kural, sahip onaylayınca yukarıdaki sabit puan taslağının yerini alır.",
    version: "Kayıtlı politika",
    state: "Durum",
    missing: "Sahibin henüz vermediği kararlar",
    reading:
      "Onaylanacak mühendislik yorumu: hesap başına birikimli doğrulanmış ve sonuçlanmış hacim; her tam 100 USD'ye bir tam puan; artan kısım sonraki puana taşınır (40 + 60 USD = 1 puan; 250 USD = 2 puan ve 50 USD taşınır). Davet: davet edilen hesabın işlem puanlarının %10'u, tek seviye; davetten sonra tamamlanan puan, hacminin çoğu önceden gelmiş olsa bile tam sayılır.",
    sample: "ÖRNEK veriyle hacim defteri (bir hesap değil)",
    total: "Örnek toplam",
  },
} as const;

export function VolumePolicyInspector({ lang }: { lang: string }) {
  const c = lang === "tr" ? COPY.tr : COPY.en;
  const policy = REGISTERED_VOLUME_POLICY;
  const state = volumeActivation(policy);
  const sample = useMemo(
    () =>
      ownVolumeView(
        computeVolumeLedger(VOLUME_SAMPLE_INPUT),
        VOLUME_SAMPLE_ACCOUNT,
      ),
    [],
  );
  return (
    <section className="card" data-testid="volume-policy-inspector">
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
      <p className="micro">{c.reading}</p>
      {state.state === "PENDING_OWNER_POLICY" && (
        <>
          <h3>{c.missing}</h3>
          <ul data-testid="volume-policy-missing">
            {state.missing.map((m) => (
              <li key={m}>
                <code dir="ltr">{m}</code>
              </li>
            ))}
          </ul>
        </>
      )}
      {sample.state === "COMPUTED" && (
        <>
          <h3>{c.sample}</h3>
          <p data-testid="volume-policy-sample-total">
            {c.total}: {displayPoints(sample.totals.totalUnits, lang)}
          </p>
        </>
      )}
    </section>
  );
}
