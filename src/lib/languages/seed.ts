// The canonical language set the system ships with.
// Order matches the user's spec — `sortOrder` here drives the default
// column order in every translation editor. Admins can reorder later.
//
// Codes follow BCP 47:
//   - Pure language code where possible: "en", "da", "de"
//   - Regional variants where the label isn't a pure language:
//     "de-AT" Austrian, "de-CH" Swiss, "nl-BE" Belgian (Flemish),
//     "ro-MD" Moldovan (the Romanian variant)
//   - "nl" for Dutch (Netherlands)
//
// The `name` is the English label shown in admin lists.
// `nativeName` is the endonym, displayed alongside for disambiguation.

export type LanguageSeed = {
  code: string;
  name: string;
  nativeName: string;
  sortOrder: number;
};

export const STANDARD_LANGUAGES: LanguageSeed[] = [
  { code: "en",    name: "English",            nativeName: "English",          sortOrder: 1 },
  { code: "da",    name: "Danish",             nativeName: "Dansk",            sortOrder: 2 },
  { code: "sv",    name: "Swedish",            nativeName: "Svenska",          sortOrder: 3 },
  { code: "no",    name: "Norwegian",          nativeName: "Norsk",            sortOrder: 4 },
  { code: "fi",    name: "Finnish",            nativeName: "Suomi",            sortOrder: 5 },
  { code: "de",    name: "German",             nativeName: "Deutsch",          sortOrder: 6 },
  { code: "pl",    name: "Polish",             nativeName: "Polski",           sortOrder: 7 },
  { code: "hr",    name: "Croatian",           nativeName: "Hrvatski",         sortOrder: 8 },
  { code: "sl",    name: "Slovenian",          nativeName: "Slovenščina",      sortOrder: 9 },
  { code: "cs",    name: "Czech",              nativeName: "Čeština",          sortOrder: 10 },
  { code: "sk",    name: "Slovak",             nativeName: "Slovenčina",       sortOrder: 11 },
  { code: "hu",    name: "Hungarian",          nativeName: "Magyar",           sortOrder: 12 },
  { code: "de-AT", name: "Austrian",           nativeName: "Österreichisch",   sortOrder: 13 },
  { code: "de-CH", name: "Swiss",              nativeName: "Schwiizerdütsch",  sortOrder: 14 },
  { code: "it",    name: "Italian",            nativeName: "Italiano",         sortOrder: 15 },
  { code: "ro",    name: "Romanian",           nativeName: "Română",           sortOrder: 16 },
  { code: "nl",    name: "Dutch (Netherlands)", nativeName: "Nederlands",      sortOrder: 17 },
  { code: "fr",    name: "French",             nativeName: "Français",         sortOrder: 18 },
  { code: "es",    name: "Spanish",            nativeName: "Español",          sortOrder: 19 },
  { code: "bg",    name: "Bulgarian",          nativeName: "Български",        sortOrder: 20 },
  { code: "mk",    name: "Macedonian",         nativeName: "Македонски",       sortOrder: 21 },
  { code: "tr",    name: "Turkish",            nativeName: "Türkçe",           sortOrder: 22 },
  { code: "is",    name: "Icelandic",          nativeName: "Íslenska",         sortOrder: 23 },
  { code: "el",    name: "Greek",              nativeName: "Ελληνικά",         sortOrder: 24 },
  { code: "ga",    name: "Irish",              nativeName: "Gaeilge",          sortOrder: 25 },
  { code: "pt",    name: "Portuguese",         nativeName: "Português",        sortOrder: 26 },
  { code: "ro-MD", name: "Moldovan",           nativeName: "Moldovenească",    sortOrder: 27 },
  { code: "nl-BE", name: "Belgian",            nativeName: "Vlaams",           sortOrder: 28 },
];
