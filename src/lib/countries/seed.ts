// Pre-filled translations for the most common origin/customer countries.
// Languages we ship translations for here match the care-label-02 language
// set: en, da, de, fi, no, sv, nl, fr, pl.
//
// Adding a new country here = adding a row to the seed list. Adding a new
// language = adding a key to each row's `nameTranslations` map. The seed
// is idempotent — running it twice doesn't overwrite, only fills in
// missing rows.

export type CountrySeed = {
  code: string;          // ISO 3166-1 alpha-2
  nameEn: string;
  languageCode: string;  // ISO 639-1
  nameTranslations: Record<string, string>;
};

export const STANDARD_COUNTRIES: CountrySeed[] = [
  {
    code: "DK",
    nameEn: "Denmark",
    languageCode: "da",
    nameTranslations: {
      en: "Denmark", da: "Danmark", de: "Dänemark", fi: "Tanska",
      no: "Danmark", sv: "Danmark", nl: "Denemarken", fr: "Danemark", pl: "Dania",
    },
  },
  {
    code: "DE",
    nameEn: "Germany",
    languageCode: "de",
    nameTranslations: {
      en: "Germany", da: "Tyskland", de: "Deutschland", fi: "Saksa",
      no: "Tyskland", sv: "Tyskland", nl: "Duitsland", fr: "Allemagne", pl: "Niemcy",
    },
  },
  {
    code: "GB",
    nameEn: "United Kingdom",
    languageCode: "en",
    nameTranslations: {
      en: "United Kingdom", da: "Storbritannien", de: "Vereinigtes Königreich",
      fi: "Yhdistynyt kuningaskunta", no: "Storbritannia", sv: "Storbritannien",
      nl: "Verenigd Koninkrijk", fr: "Royaume-Uni", pl: "Wielka Brytania",
    },
  },
  {
    code: "US",
    nameEn: "United States",
    languageCode: "en",
    nameTranslations: {
      en: "United States", da: "USA", de: "USA", fi: "Yhdysvallat",
      no: "USA", sv: "USA", nl: "Verenigde Staten", fr: "États-Unis", pl: "Stany Zjednoczone",
    },
  },
  {
    code: "FR",
    nameEn: "France",
    languageCode: "fr",
    nameTranslations: {
      en: "France", da: "Frankrig", de: "Frankreich", fi: "Ranska",
      no: "Frankrike", sv: "Frankrike", nl: "Frankrijk", fr: "France", pl: "Francja",
    },
  },
  {
    code: "NL",
    nameEn: "Netherlands",
    languageCode: "nl",
    nameTranslations: {
      en: "Netherlands", da: "Holland", de: "Niederlande", fi: "Alankomaat",
      no: "Nederland", sv: "Nederländerna", nl: "Nederland", fr: "Pays-Bas", pl: "Holandia",
    },
  },
  {
    code: "PL",
    nameEn: "Poland",
    languageCode: "pl",
    nameTranslations: {
      en: "Poland", da: "Polen", de: "Polen", fi: "Puola",
      no: "Polen", sv: "Polen", nl: "Polen", fr: "Pologne", pl: "Polska",
    },
  },
  {
    code: "SE",
    nameEn: "Sweden",
    languageCode: "sv",
    nameTranslations: {
      en: "Sweden", da: "Sverige", de: "Schweden", fi: "Ruotsi",
      no: "Sverige", sv: "Sverige", nl: "Zweden", fr: "Suède", pl: "Szwecja",
    },
  },
  {
    code: "NO",
    nameEn: "Norway",
    languageCode: "no",
    nameTranslations: {
      en: "Norway", da: "Norge", de: "Norwegen", fi: "Norja",
      no: "Norge", sv: "Norge", nl: "Noorwegen", fr: "Norvège", pl: "Norwegia",
    },
  },
  {
    code: "FI",
    nameEn: "Finland",
    languageCode: "fi",
    nameTranslations: {
      en: "Finland", da: "Finland", de: "Finnland", fi: "Suomi",
      no: "Finland", sv: "Finland", nl: "Finland", fr: "Finlande", pl: "Finlandia",
    },
  },
  {
    code: "IT",
    nameEn: "Italy",
    languageCode: "it",
    nameTranslations: {
      en: "Italy", da: "Italien", de: "Italien", fi: "Italia",
      no: "Italia", sv: "Italien", nl: "Italië", fr: "Italie", pl: "Włochy",
    },
  },
  {
    code: "ES",
    nameEn: "Spain",
    languageCode: "es",
    nameTranslations: {
      en: "Spain", da: "Spanien", de: "Spanien", fi: "Espanja",
      no: "Spania", sv: "Spanien", nl: "Spanje", fr: "Espagne", pl: "Hiszpania",
    },
  },
  {
    code: "CN",
    nameEn: "China",
    languageCode: "zh",
    nameTranslations: {
      en: "China", da: "Kina", de: "China", fi: "Kiina",
      no: "Kina", sv: "Kina", nl: "China", fr: "Chine", pl: "Chiny",
    },
  },
  {
    code: "BD",
    nameEn: "Bangladesh",
    languageCode: "bn",
    nameTranslations: {
      en: "Bangladesh", da: "Bangladesh", de: "Bangladesch", fi: "Bangladesh",
      no: "Bangladesh", sv: "Bangladesh", nl: "Bangladesh", fr: "Bangladesh", pl: "Bangladesz",
    },
  },
  {
    code: "IN",
    nameEn: "India",
    languageCode: "hi",
    nameTranslations: {
      en: "India", da: "Indien", de: "Indien", fi: "Intia",
      no: "India", sv: "Indien", nl: "India", fr: "Inde", pl: "Indie",
    },
  },
  {
    code: "TR",
    nameEn: "Turkey",
    languageCode: "tr",
    nameTranslations: {
      en: "Turkey", da: "Tyrkiet", de: "Türkei", fi: "Turkki",
      no: "Tyrkia", sv: "Turkiet", nl: "Turkije", fr: "Turquie", pl: "Turcja",
    },
  },
];
