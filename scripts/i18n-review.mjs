// Explicit semantic corrections from the financial/safety review of offline drafts.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
// balance, spendable reserve, source gas, reverted source, insufficient amount+gas,
// and the distinction between source confirmation and destination delivery.
const reviewed = {
  es: [
    "Saldo",
    "Reserva disponible para pagos",
    "Presupuesto de gas de la red de origen",
    "La transacción de origen revirtió; puede haberse gastado gas",
    "El saldo no alcanza para el importe y el gas de la red de origen.",
    "La confirmación en la red de origen no demuestra la entrega.",
  ],
  "pt-BR": [
    "Saldo",
    "Reserva disponível para pagamentos",
    "Orçamento de gas da rede de origem",
    "A transação de origem reverteu; pode ter consumido gas",
    "Saldo insuficiente para o valor e o gas na rede de origem.",
    "A confirmação na rede de origem não comprova a entrega.",
  ],
  fr: [
    "Solde",
    "Réserve disponible pour les paiements",
    "Budget de gas du réseau source",
    "La transaction source a échoué avec annulation; du gas a pu être consommé",
    "Le solde ne couvre pas le montant et le gas sur le réseau source.",
    "La confirmation sur le réseau source ne prouve pas la livraison.",
  ],
  de: [
    "Guthaben",
    "Für Auszahlungen verfügbare Reserve",
    "Gasbudget im Quellnetzwerk",
    "Die Quelltransaktion wurde rückgängig gemacht; Gas kann verbraucht worden sein",
    "Das Guthaben reicht für den Betrag und das Gas im Quellnetzwerk nicht aus.",
    "Die Bestätigung im Quellnetzwerk belegt keine Auszahlung im Zielnetzwerk.",
  ],
  it: [
    "Saldo",
    "Riserva disponibile per i pagamenti",
    "Budget gas della rete di origine",
    "La transazione di origine è stata annullata dal contratto; potrebbe aver consumato gas",
    "Saldo insufficiente per l'importo e il gas sulla rete di origine.",
    "La conferma sulla rete di origine non prova la consegna.",
  ],
  nl: [
    "Saldo",
    "Voor uitbetalingen beschikbare reserve",
    "Gasbudget op het bronnetwerk",
    "De brontransactie is teruggedraaid; gas kan zijn verbruikt",
    "Het saldo is onvoldoende voor het bedrag en gas op het bronnetwerk.",
    "Bevestiging op het bronnetwerk bewijst geen levering.",
  ],
  pl: [
    "Saldo",
    "Rezerwa dostępna do wypłat",
    "Budżet gas w sieci źródłowej",
    "Transakcja źródłowa została wycofana przez kontrakt; gas mógł zostać zużyty",
    "Saldo nie wystarcza na kwotę i gas w sieci źródłowej.",
    "Potwierdzenie w sieci źródłowej nie dowodzi dostarczenia środków.",
  ],
  ru: [
    "Баланс",
    "Резерв, доступный для выплат",
    "Бюджет Gas в исходной сети",
    "Исходная транзакция отменена контрактом; Gas мог быть потрачен",
    "Недостаточно средств для суммы перевода и Gas в исходной сети.",
    "Подтверждение в исходной сети не доказывает доставку.",
  ],
  uk: [
    "Баланс",
    "Резерв, доступний для виплат",
    "Бюджет Gas у вихідній мережі",
    "Вихідну транзакцію скасовано контрактом; Gas міг бути витрачений",
    "Недостатньо коштів для суми переказу та Gas у вихідній мережі.",
    "Підтвердження у вихідній мережі не доводить доставку.",
  ],
  ar: [
    "الرصيد",
    "الاحتياطي المتاح للدفع",
    "ميزانية Gas في شبكة المصدر",
    "أُلغيت معاملة المصدر بسبب تراجع تنفيذ العقد؛ ربما استُهلكت رسوم Gas",
    "الرصيد غير كافٍ للمبلغ ورسوم Gas في شبكة المصدر.",
    "تأكيد المعاملة في شبكة المصدر لا يثبت التسليم في شبكة الوجهة.",
  ],
  fa: [
    "موجودی",
    "ذخیره قابل استفاده برای پرداخت",
    "بودجه Gas در شبکه مبدأ",
    "تراکنش مبدأ با خطای قرارداد برگشت؛ ممکن است Gas مصرف شده باشد",
    "موجودی برای مبلغ انتقال و Gas در شبکه مبدأ کافی نیست.",
    "تأیید در شبکه مبدأ، تحویل در شبکه مقصد را ثابت نمی‌کند.",
  ],
  he: [
    "יתרה",
    "רזרבה זמינה לתשלומים",
    "תקציב Gas ברשת המקור",
    "עסקת המקור בוטלה עקב חזרה של ביצוע החוזה; ייתכן שנצרך Gas",
    "היתרה אינה מספיקה לסכום ול-Gas ברשת המקור.",
    "אישור ברשת המקור אינו מוכיח מסירה ברשת היעד.",
  ],
  ur: [
    "بیلنس",
    "ادائیگی کے لیے قابل استعمال ذخیرہ",
    "ماخذ نیٹ ورک پر Gas کا بجٹ",
    "ماخذ ٹرانزیکشن معاہدے کی خرابی سے واپس ہوئی؛ Gas خرچ ہو سکتی ہے",
    "منتقلی کی رقم اور ماخذ نیٹ ورک کی Gas کے لیے بیلنس ناکافی ہے۔",
    "ماخذ نیٹ ورک کی تصدیق منزل پر ترسیل کا ثبوت نہیں ہے۔",
  ],
  "zh-CN": [
    "余额",
    "可用于支付的储备",
    "源网络 Gas 预算",
    "源网络交易执行回退；仍可能消耗 Gas",
    "余额不足以支付转账金额和源网络 Gas 费用。",
    "源网络确认不代表目标网络已收到资产。",
  ],
  "zh-TW": [
    "餘額",
    "可用於支付的儲備",
    "來源網路 Gas 預算",
    "來源網路交易執行回退；仍可能消耗 Gas",
    "餘額不足以支付轉帳金額和來源網路 Gas 費用。",
    "來源網路確認不代表目標網路已收到資產。",
  ],
  ja: [
    "残高",
    "支払いに使用可能な準備金",
    "送信元ネットワークの Gas 予算",
    "送信元の取引は実行が取り消されました。Gas が消費された可能性があります",
    "送金額と送信元ネットワークの Gas 手数料に対して残高が不足しています。",
    "送信元での承認だけでは、送信先への資産の到着を証明できません。",
  ],
  ko: [
    "잔액",
    "지급에 사용할 수 있는 준비금",
    "출발 네트워크의 Gas 예산",
    "출발 거래 실행이 되돌려졌습니다. Gas가 소모되었을 수 있습니다",
    "전송 금액과 출발 네트워크의 Gas 수수료를 충당할 잔액이 부족합니다.",
    "출발 네트워크의 확인만으로 도착 네트워크의 자산 수령이 증명되지는 않습니다.",
  ],
  hi: [
    "शेष राशि",
    "भुगतान के लिए उपलब्ध आरक्षित राशि",
    "स्रोत नेटवर्क पर Gas बजट",
    "स्रोत लेन-देन का निष्पादन वापस हुआ; Gas खर्च हो सकती है",
    "हस्तांतरण राशि और स्रोत नेटवर्क की Gas के लिए शेष राशि अपर्याप्त है।",
    "स्रोत नेटवर्क की पुष्टि, गंतव्य पर प्राप्ति का प्रमाण नहीं है।",
  ],
  bn: [
    "ব্যালেন্স",
    "পরিশোধের জন্য ব্যবহারযোগ্য রিজার্ভ",
    "উৎস নেটওয়ার্কের Gas বাজেট",
    "উৎস লেনদেনের নির্বাহ ফিরিয়ে নেওয়া হয়েছে; Gas খরচ হয়ে থাকতে পারে",
    "স্থানান্তরের পরিমাণ এবং উৎস নেটওয়ার্কের Gas-এর জন্য ব্যালেন্স যথেষ্ট নয়।",
    "উৎস নেটওয়ার্কের নিশ্চিতকরণ গন্তব্যে প্রাপ্তির প্রমাণ নয়।",
  ],
  id: [
    "Saldo",
    "Cadangan yang tersedia untuk pembayaran",
    "Anggaran Gas jaringan asal",
    "Transaksi asal dibatalkan oleh eksekusi kontrak; Gas mungkin telah terpakai",
    "Saldo tidak cukup untuk jumlah transfer dan Gas di jaringan asal.",
    "Konfirmasi di jaringan asal bukan bukti penerimaan di jaringan tujuan.",
  ],
  vi: [
    "Số dư",
    "Dự trữ có thể dùng để chi trả",
    "Ngân sách Gas trên mạng nguồn",
    "Giao dịch nguồn bị hoàn tác khi thực thi hợp đồng; Gas có thể đã bị tiêu tốn",
    "Số dư không đủ cho số tiền chuyển và phí Gas trên mạng nguồn.",
    "Xác nhận trên mạng nguồn không chứng minh tài sản đã được nhận trên mạng đích.",
  ],
  th: [
    "ยอดคงเหลือ",
    "เงินสำรองที่พร้อมใช้จ่ายเพื่อชำระ",
    "งบ Gas บนเครือข่ายต้นทาง",
    "การทำงานของธุรกรรมต้นทางถูกย้อนกลับ อาจมีการใช้ Gas ไปแล้ว",
    "ยอดคงเหลือไม่พอสำหรับจำนวนที่โอนและค่า Gas บนเครือข่ายต้นทาง",
    "การยืนยันบนเครือข่ายต้นทางไม่ใช่หลักฐานว่าได้รับสินทรัพย์บนเครือข่ายปลายทางแล้ว",
  ],
};
const substitutions = {
  "pt-BR": [
    ["reservas dispensáveis", "reservas disponíveis para pagamentos"],
    ["Equilíbrio", "Saldo"],
    ["equilíbrio", "saldo"],
    ["gás fonte", "gas da rede de origem"],
  ],
  de: [["Gleichgewicht", "Guthaben"]],
  it: [
    ["Equilibrio", "Saldo"],
    ["equilibrio", "saldo"],
  ],
  pl: [
    ["Równowaga", "Saldo"],
    ["równowaga", "saldo"],
  ],
  ar: [
    ["الميزان", "الرصيد"],
    ["الاقتباس", "تقدير التكلفة"],
    ["اقتباس", "تقدير التكلفة"],
  ],
  fa: [
    ["تعادل", "موجودی"],
    ["نقل قول", "برآورد هزینه"],
  ],
  he: [
    ["איזון", "יתרה"],
    ["ציטוט", "הצעת מחיר"],
  ],
  ur: [
    ["توازن", "بیلنس"],
    ["اقتباس", "لاگت کا تخمینہ"],
  ],
  "zh-CN": [
    ["平衡", "余额"],
    ["天然气", "Gas"],
    ["桥梁服务费", "跨链服务费"],
    ["气源", "源网络 Gas"],
  ],
  "zh-TW": [
    ["平衡", "餘額"],
    ["天然氣", "Gas"],
    ["橋樑服務費", "跨鏈服務費"],
    ["氣源", "來源網路 Gas"],
  ],
  ja: [
    ["バランス", "残高"],
    ["引用", "見積もり"],
    ["原料ガス", "送信元ネットワークの Gas"],
  ],
  ko: [
    ["균형", "잔액"],
    ["교량", "브리지"],
    ["원료가스", "출발 네트워크의 Gas"],
  ],
  hi: [["संतुलन", "शेष राशि"]],
  bn: [["ভারসাম্য", "ব্যালেন্স"]],
  id: [
    ["Keseimbangan", "Saldo"],
    ["keseimbangan", "saldo"],
  ],
  vi: [
    ["nguồn khí", "Gas trên mạng nguồn"],
    ["cầu đường", "cầu nối chuỗi"],
  ],
};
const specific = {
  ar: {
    "product.boundNote":
      "هذا حد محاسبي للقراءة فقط، وليس إثباتًا لاحتياطي متاح للدفع. لم يُتحقق من تطابق شيفرة النشر أو الاحتياطي القابل للإنفاق؛ الإرسال معطّل.",
    "product.riskReview":
      "المستلم هو عنوانك الخاص. تأكيد شبكة المصدر وحده لا يثبت وصول الأصول إلى شبكة الوجهة. قد تتأخر معاملة الجسر أو تُحتجز للمراجعة.",
    "product.erc20": "ERC20 المعتمد",
  },
  fa: {
    "product.erc20": "ERC20 مرجع",
    "product.boundNote":
      "این فقط یک سقف حسابداری است و ذخیره قابل پرداخت را ثابت نمی‌کند. تطابق کد استقرار و ذخیره قابل استفاده هنوز تأیید نشده‌اند؛ ارسال غیرفعال است.",
  },
  he: {
    "product.boundNote":
      "זהו גבול חשבונאי לקריאה בלבד, ולא הוכחה לרזרבה זמינה לתשלום. התאמת קוד הפריסה והרזרבה הזמינה טרם אומתו; השליחה מושבתת.",
  },
  ur: {
    "product.balance": "بیلنس",
    "product.settlementStep": "پل کے ذریعے اثاثوں کی ترسیل",
    "product.boundNote":
      "یہ صرف پڑھنے کے لیے حسابی بالائی حد ہے، قابل ادائیگی ذخیرے کا ثبوت نہیں۔ تعیناتی کے کوڈ کی مطابقت اور قابل استعمال ذخیرہ غیر تصدیق شدہ ہیں؛ بھیجنا بند ہے۔",
  },
  "zh-CN": {
    "product.boundNote":
      "这只是只读的会计上限，不证明储备可用于支付。部署代码的构建一致性和可支付储备尚未验证；发送功能已关闭。",
    "product.riskReview":
      "接收地址是您自己的地址。源网络确认不等于目标网络收到资产。跨链转账可能延迟或被暂扣以供审核。",
  },
  "zh-TW": {
    "product.boundNote":
      "這只是唯讀的會計上限，不證明儲備可用於支付。部署程式碼的建置一致性和可支付儲備尚未驗證；傳送功能已關閉。",
    "product.riskReview":
      "接收地址是您自己的地址。來源網路確認不等於目標網路收到資產。跨鏈轉帳可能延遲或被暫扣以供審核。",
  },
  ja: {
    "product.boundNote":
      "これは読み取り専用の会計上限であり、支払い可能な準備金の証明ではありません。デプロイ済みコードとビルドの一致、および準備金の利用可能性は未確認です。送信は無効です。",
    "product.riskReview":
      "受取先はご自身のアドレスです。送信元の確認だけでは送信先への到着を証明できません。ブリッジ送金は遅延したり、審査のため保留されたりする場合があります。",
  },
  ko: {
    "product.boundNote":
      "이는 읽기 전용 회계 상한이며, 지급 가능한 준비금의 증명이 아닙니다. 배포 코드와 빌드의 일치 및 준비금의 사용 가능성은 확인되지 않았습니다. 전송은 비활성화되어 있습니다.",
  },
  "pt-BR": {
    "product.boundNote":
      "Este é apenas um limite contábil de leitura, sem comprovar reserva disponível para pagamentos. A equivalência do build implantado e a reserva utilizável não foram verificadas; o envio está desabilitado.",
  },
};
const audit = [];
for (const [locale, values] of Object.entries(reviewed)) {
  const path = `src/i18n/locales/${locale}.json`;
  let raw = await readFile(path, "utf8");
  for (const [a, b] of substitutions[locale] ?? []) raw = raw.replaceAll(a, b);
  const d = JSON.parse(raw);
  [
    d.product.balance,
    d.product.reserve,
    d.product.gas,
    d.states.SOURCE_REVERTED,
    d.errors.INSUFFICIENT_GAS_OR_BALANCE,
    d.product.sourceSuccess,
  ] = values;
  for (const [key, value] of Object.entries(specific[locale] ?? {})) {
    const [section, id] = key.split(".");
    d[section][id] = value;
  }
  const output = JSON.stringify(d, null, 2) + "\n";
  await writeFile(path, output);
  audit.push({
    locale,
    sha256: createHash("sha256").update(output).digest("hex"),
    semanticChecks: [
      "negative execution gate",
      "unverified deployment/build and reserve",
      "source confirmation is not delivery",
      "unknown submission must not retry",
      "manual recovery preserves records",
      "gas and token amount separately required",
      "revert is not restored success",
      "service fee does not become Otherbridge fee",
    ],
    review:
      "Model semantic review with explicit corrections; no claim of independent native-speaker certification",
  });
}
const base = `${(await readFile(".otherbridge/v12-evidence-path.txt", "utf8")).trim()}/i18n-authoring`;
await mkdir(base, { recursive: true });
await writeFile(
  `${base}/semantic-review.json`,
  JSON.stringify(
    {
      at: new Date().toISOString(),
      canonical: "en",
      baselineTR: "accepted copy retained except amount syntax",
      drafts: "Offline translation assistance; never a runtime dependency",
      audit,
    },
    null,
    2,
  ),
);
