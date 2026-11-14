// Two new navigation/brand strings; existing financial and coverage copy is retained.
import { readFileSync, writeFileSync } from "node:fs";
const copy = {
  en: ["Overview", "Intelligence across\nevery network."],
  tr: ["Genel bakış", "Her ağda\nakıllı bağlantılar."],
  es: ["Resumen", "Inteligencia en\ncada red."],
  "pt-BR": ["Visão geral", "Inteligência em\ncada rede."],
  fr: ["Vue d’ensemble", "L’intelligence à travers\nchaque réseau."],
  de: ["Übersicht", "Intelligenz über\nalle Netzwerke."],
  it: ["Panoramica", "Intelligenza in\nogni rete."],
  nl: ["Overzicht", "Intelligentie in\nelk netwerk."],
  pl: ["Przegląd", "Inteligencja w\nkażdej sieci."],
  ru: ["Обзор", "Интеллект в\nкаждой сети."],
  uk: ["Огляд", "Інтелект у\nкожній мережі."],
  ar: ["نظرة عامة", "ذكاء عبر\nكل شبكة."],
  fa: ["نمای کلی", "هوشمندی در\nهر شبکه."],
  he: ["סקירה כללית", "תבונה בכל\nרשת."],
  ur: ["مجموعی جائزہ", "ہر نیٹ ورک میں\nذہانت۔"],
  "zh-CN": ["概览", "智慧连接\n每一个网络。"],
  "zh-TW": ["總覽", "智慧連結\n每一個網路。"],
  ja: ["概要", "あらゆるネットワークに\nインテリジェンスを。"],
  ko: ["개요", "모든 네트워크를 잇는\n인텔리전스."],
  hi: ["अवलोकन", "हर नेटवर्क में\nबुद्धिमत्ता।"],
  bn: ["সারসংক্ষেপ", "প্রতিটি নেটওয়ার্কে\nবুদ্ধিমত্তা।"],
  id: ["Ringkasan", "Kecerdasan di\nsetiap jaringan."],
  vi: ["Tổng quan", "Trí tuệ trên\nmọi mạng lưới."],
  th: ["ภาพรวม", "ความอัจฉริยะใน\nทุกเครือข่าย"],
};
for (const [locale, [overview, intelligence]] of Object.entries(copy)) {
  const path = `src/i18n/locales/${locale}.json`;
  const dictionary = JSON.parse(readFileSync(path, "utf8"));
  dictionary.v119 = { overview, intelligence };
  writeFileSync(path, JSON.stringify(dictionary, null, 2) + "\n");
}
