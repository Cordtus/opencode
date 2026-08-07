import * as i18n from "@solid-primitives/i18n"
import {
  DESKTOP_NATIVE_LOCALES,
  detectDesktopNativeLocale,
  type DesktopNativeLocale,
} from "../../../../app/src/i18n/desktop-native"

import { dict as desktopEn } from "./en"
import { dict as appEn } from "../../../../app/src/i18n/en"
import { dict as desktopZh } from "./zh"
import { dict as desktopZht } from "./zht"
import { dict as desktopKo } from "./ko"
import { dict as desktopDe } from "./de"
import { dict as desktopEs } from "./es"
import { dict as desktopFr } from "./fr"
import { dict as desktopDa } from "./da"
import { dict as desktopJa } from "./ja"
import { dict as desktopPl } from "./pl"
import { dict as desktopRu } from "./ru"
import { dict as desktopUk } from "./uk"
import { dict as desktopAr } from "./ar"
import { dict as desktopNo } from "./no"
import { dict as desktopBr } from "./br"
import { dict as desktopBs } from "./bs"
import { dict as desktopTr } from "./tr"
import { dict as desktopHi } from "./hi"
import { dict as desktopNl } from "./nl"
import { dict as desktopId } from "./id"
import { dict as desktopVi } from "./vi"
import { dict as desktopIt } from "./it"
import { dict as desktopUr } from "./ur"
import { dict as desktopPa } from "./pa"
import { dict as desktopAz } from "./az"
import { dict as desktopFi } from "./fi"
import { dict as desktopSv } from "./sv"
import { dict as desktopTh } from "./th"

import { dict as desktopAm } from "./am"
import { dict as desktopBg } from "./bg"
import { dict as desktopBn } from "./bn"
import { dict as desktopCa } from "./ca"
import { dict as desktopCs } from "./cs"
import { dict as desktopDv } from "./dv"
import { dict as desktopDz } from "./dz"
import { dict as desktopEl } from "./el"
import { dict as desktopEt } from "./et"
import { dict as desktopFa } from "./fa"
import { dict as desktopFo } from "./fo"
import { dict as desktopHr } from "./hr"
import { dict as desktopHu } from "./hu"
import { dict as desktopHy } from "./hy"
import { dict as desktopIs } from "./is"
import { dict as desktopKa } from "./ka"
import { dict as desktopKm } from "./km"
import { dict as desktopLo } from "./lo"
import { dict as desktopLt } from "./lt"
import { dict as desktopLv } from "./lv"
import { dict as desktopMk } from "./mk"
import { dict as desktopMn } from "./mn"
import { dict as desktopMs } from "./ms"
import { dict as desktopMy } from "./my"
import { dict as desktopNe } from "./ne"
import { dict as desktopRo } from "./ro"
import { dict as desktopSi } from "./si"
import { dict as desktopSk } from "./sk"
import { dict as desktopSl } from "./sl"
import { dict as desktopSq } from "./sq"
import { dict as desktopSr } from "./sr"
import { dict as desktopTg } from "./tg"
import { dict as desktopTk } from "./tk"
import { dict as desktopUz } from "./uz"

export type Locale = DesktopNativeLocale

type RawDictionary = typeof appEn & typeof desktopEn
type Dictionary = Record<keyof i18n.Flatten<RawDictionary>, string>

function detectLocale(): Locale {
  if (typeof navigator !== "object") return "en"
  return detectDesktopNativeLocale(navigator.languages?.length ? navigator.languages : [navigator.language])
}

function parseLocale(value: unknown): Locale | null {
  if (!value) return null
  if (typeof value !== "string") return null
  if ((DESKTOP_NATIVE_LOCALES as readonly string[]).includes(value)) return value as Locale
  return null
}

function parseRecord(value: unknown) {
  if (!value || typeof value !== "object") return null
  if (Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function parseStored(value: unknown) {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

function pickLocale(value: unknown): Locale | null {
  const direct = parseLocale(value)
  if (direct) return direct

  const record = parseRecord(value)
  if (!record) return null

  return parseLocale(record.locale)
}

const base = i18n.flatten({ ...appEn, ...desktopEn })

const loaders = {
  zh: () => Promise.all([import("../../../../app/src/i18n/zh"), import("./zh")]),
  zht: () => Promise.all([import("../../../../app/src/i18n/zht"), import("./zht")]),
  ko: () => Promise.all([import("../../../../app/src/i18n/ko"), import("./ko")]),
  de: () => Promise.all([import("../../../../app/src/i18n/de"), import("./de")]),
  es: () => Promise.all([import("../../../../app/src/i18n/es"), import("./es")]),
  fr: () => Promise.all([import("../../../../app/src/i18n/fr"), import("./fr")]),
  da: () => Promise.all([import("../../../../app/src/i18n/da"), import("./da")]),
  ja: () => Promise.all([import("../../../../app/src/i18n/ja"), import("./ja")]),
  pl: () => Promise.all([import("../../../../app/src/i18n/pl"), import("./pl")]),
  ru: () => Promise.all([import("../../../../app/src/i18n/ru"), import("./ru")]),
  uk: () => Promise.all([import("../../../../app/src/i18n/uk"), import("./uk")]),
  ar: () => Promise.all([import("../../../../app/src/i18n/ar"), import("./ar")]),
  no: () => Promise.all([import("../../../../app/src/i18n/no"), import("./no")]),
  br: () => Promise.all([import("../../../../app/src/i18n/br"), import("./br")]),
  bs: () => Promise.all([import("../../../../app/src/i18n/bs"), import("./bs")]),
  tr: () => Promise.all([import("../../../../app/src/i18n/tr"), import("./tr")]),
  hi: () => Promise.all([import("../../../../app/src/i18n/hi"), import("./hi")]),
  nl: () => Promise.all([import("../../../../app/src/i18n/nl"), import("./nl")]),
  id: () => Promise.all([import("../../../../app/src/i18n/id"), import("./id")]),
  vi: () => Promise.all([import("../../../../app/src/i18n/vi"), import("./vi")]),
  it: () => Promise.all([import("../../../../app/src/i18n/it"), import("./it")]),
  ur: () => Promise.all([import("../../../../app/src/i18n/ur"), import("./ur")]),
  pa: () => Promise.all([import("../../../../app/src/i18n/pa"), import("./pa")]),
  az: () => Promise.all([import("../../../../app/src/i18n/az"), import("./az")]),
  fi: () => Promise.all([import("../../../../app/src/i18n/fi"), import("./fi")]),
  sv: () => Promise.all([import("../../../../app/src/i18n/sv"), import("./sv")]),
  th: () => Promise.all([import("../../../../app/src/i18n/th"), import("./th")]),
}

async function build(locale: Locale): Promise<Dictionary> {
  if (locale === "en") return base
  if (
    locale === "zh" ||
    locale === "zht" ||
    locale === "ko" ||
    locale === "de" ||
    locale === "es" ||
    locale === "fr" ||
    locale === "da" ||
    locale === "ja" ||
    locale === "pl" ||
    locale === "ru" ||
    locale === "uk" ||
    locale === "ar" ||
    locale === "no" ||
    locale === "br" ||
    locale === "bs" ||
    locale === "tr" ||
    locale === "hi" ||
    locale === "nl" ||
    locale === "id" ||
    locale === "vi" ||
    locale === "it" ||
    locale === "ur" ||
    locale === "pa" ||
    locale === "az" ||
    locale === "fi" ||
    locale === "sv" ||
    locale === "th"
  ) {
    const dictionaries = await loaders[locale]()
    return { ...base, ...i18n.flatten(dictionaries[0].dict), ...i18n.flatten(dictionaries[1].dict) }
  }
  if (locale === "am") return { ...base, ...i18n.flatten(desktopAm) }
  if (locale === "bg") return { ...base, ...i18n.flatten(desktopBg) }
  if (locale === "bn") return { ...base, ...i18n.flatten(desktopBn) }
  if (locale === "ca") return { ...base, ...i18n.flatten(desktopCa) }
  if (locale === "cs") return { ...base, ...i18n.flatten(desktopCs) }
  if (locale === "dv") return { ...base, ...i18n.flatten(desktopDv) }
  if (locale === "dz") return { ...base, ...i18n.flatten(desktopDz) }
  if (locale === "el") return { ...base, ...i18n.flatten(desktopEl) }
  if (locale === "et") return { ...base, ...i18n.flatten(desktopEt) }
  if (locale === "fa") return { ...base, ...i18n.flatten(desktopFa) }
  if (locale === "fo") return { ...base, ...i18n.flatten(desktopFo) }
  if (locale === "hr") return { ...base, ...i18n.flatten(desktopHr) }
  if (locale === "hu") return { ...base, ...i18n.flatten(desktopHu) }
  if (locale === "hy") return { ...base, ...i18n.flatten(desktopHy) }
  if (locale === "is") return { ...base, ...i18n.flatten(desktopIs) }
  if (locale === "ka") return { ...base, ...i18n.flatten(desktopKa) }
  if (locale === "km") return { ...base, ...i18n.flatten(desktopKm) }
  if (locale === "lo") return { ...base, ...i18n.flatten(desktopLo) }
  if (locale === "lt") return { ...base, ...i18n.flatten(desktopLt) }
  if (locale === "lv") return { ...base, ...i18n.flatten(desktopLv) }
  if (locale === "mk") return { ...base, ...i18n.flatten(desktopMk) }
  if (locale === "mn") return { ...base, ...i18n.flatten(desktopMn) }
  if (locale === "ms") return { ...base, ...i18n.flatten(desktopMs) }
  if (locale === "my") return { ...base, ...i18n.flatten(desktopMy) }
  if (locale === "ne") return { ...base, ...i18n.flatten(desktopNe) }
  if (locale === "ro") return { ...base, ...i18n.flatten(desktopRo) }
  if (locale === "si") return { ...base, ...i18n.flatten(desktopSi) }
  if (locale === "sk") return { ...base, ...i18n.flatten(desktopSk) }
  if (locale === "sl") return { ...base, ...i18n.flatten(desktopSl) }
  if (locale === "sq") return { ...base, ...i18n.flatten(desktopSq) }
  if (locale === "sr") return { ...base, ...i18n.flatten(desktopSr) }
  if (locale === "tg") return { ...base, ...i18n.flatten(desktopTg) }
  if (locale === "tk") return { ...base, ...i18n.flatten(desktopTk) }
  if (locale === "uz") return { ...base, ...i18n.flatten(desktopUz) }
  return { ...base, ...i18n.flatten(desktopKo) }
}

const state = {
  locale: detectLocale(),
  dict: base as Dictionary,
  init: undefined as Promise<Locale> | undefined,
}

const translate = i18n.translator(() => state.dict, i18n.resolveTemplate)

export function t(key: keyof Dictionary, params?: Record<string, string | number>) {
  return translate(key, params)
}

export function initI18n(): Promise<Locale> {
  const cached = state.init
  if (cached) return cached

  const promise = (async () => {
    const raw = await window.api.storeGet("opencode.global.dat", "language").catch(() => null)
    const value = parseStored(raw)
    const next = pickLocale(value) ?? state.locale

    state.locale = next
    state.dict = await build(next)
    return next
  })().catch(() => state.locale)

  state.init = promise
  return promise
}
