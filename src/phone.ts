// Minimal E.164 handling. Suppliers do the authoritative operator lookup; this
// only normalises input and maps a dialling code to an ISO country so we can
// enforce the blocklist and shape supplier queries without a heavy dependency.
const CODES: Array<[string, string]> = [
  ["1", "US"], ["7", "RU"], ["20", "EG"], ["27", "ZA"], ["30", "GR"], ["31", "NL"], ["32", "BE"], ["33", "FR"],
  ["34", "ES"], ["36", "HU"], ["39", "IT"], ["40", "RO"], ["41", "CH"], ["43", "AT"], ["44", "GB"], ["45", "DK"],
  ["46", "SE"], ["47", "NO"], ["48", "PL"], ["49", "DE"], ["51", "PE"], ["52", "MX"], ["53", "CU"], ["54", "AR"],
  ["55", "BR"], ["56", "CL"], ["57", "CO"], ["58", "VE"], ["60", "MY"], ["61", "AU"], ["62", "ID"], ["63", "PH"],
  ["64", "NZ"], ["65", "SG"], ["66", "TH"], ["81", "JP"], ["82", "KR"], ["84", "VN"], ["86", "CN"], ["90", "TR"],
  ["91", "IN"], ["92", "PK"], ["93", "AF"], ["94", "LK"], ["95", "MM"], ["98", "IR"], ["211", "SS"], ["212", "MA"],
  ["213", "DZ"], ["216", "TN"], ["218", "LY"], ["220", "GM"], ["221", "SN"], ["223", "ML"], ["224", "GN"],
  ["225", "CI"], ["226", "BF"], ["227", "NE"], ["228", "TG"], ["229", "BJ"], ["230", "MU"], ["231", "LR"],
  ["232", "SL"], ["233", "GH"], ["234", "NG"], ["235", "TD"], ["236", "CF"], ["237", "CM"], ["238", "CV"],
  ["240", "GQ"], ["241", "GA"], ["242", "CG"], ["243", "CD"], ["244", "AO"], ["248", "SC"], ["249", "SD"],
  ["250", "RW"], ["251", "ET"], ["252", "SO"], ["253", "DJ"], ["254", "KE"], ["255", "TZ"], ["256", "UG"],
  ["257", "BI"], ["258", "MZ"], ["260", "ZM"], ["261", "MG"], ["263", "ZW"], ["264", "NA"], ["265", "MW"],
  ["266", "LS"], ["267", "BW"], ["268", "SZ"], ["351", "PT"], ["352", "LU"], ["353", "IE"], ["354", "IS"],
  ["355", "AL"], ["356", "MT"], ["357", "CY"], ["358", "FI"], ["359", "BG"], ["370", "LT"], ["371", "LV"],
  ["372", "EE"], ["373", "MD"], ["374", "AM"], ["375", "BY"], ["376", "AD"], ["380", "UA"], ["381", "RS"],
  ["385", "HR"], ["386", "SI"], ["387", "BA"], ["389", "MK"], ["420", "CZ"], ["421", "SK"], ["501", "BZ"],
  ["502", "GT"], ["503", "SV"], ["504", "HN"], ["505", "NI"], ["506", "CR"], ["507", "PA"], ["509", "HT"],
  ["591", "BO"], ["593", "EC"], ["595", "PY"], ["598", "UY"], ["673", "BN"], ["852", "HK"], ["853", "MO"],
  ["855", "KH"], ["856", "LA"], ["880", "BD"], ["886", "TW"], ["960", "MV"], ["961", "LB"], ["962", "JO"],
  ["963", "SY"], ["964", "IQ"], ["965", "KW"], ["966", "SA"], ["967", "YE"], ["968", "OM"], ["970", "PS"],
  ["971", "AE"], ["972", "IL"], ["973", "BH"], ["974", "QA"], ["975", "BT"], ["976", "MN"], ["977", "NP"],
  ["992", "TJ"], ["993", "TM"], ["994", "AZ"], ["995", "GE"], ["996", "KG"], ["998", "UZ"], ["850", "KP"],
];
// Longest prefix first so "995" wins over "9".
CODES.sort((a, b) => b[0].length - a[0].length);

/** Strip to digits; returns null unless it looks like E.164 (7–15 digits). */
export function normalizeMsisdn(input: string): string | null {
  const digits = String(input ?? "").replace(/[^\d]/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  return digits;
}

export function countryOfMsisdn(msisdn: string): string | null {
  for (const [code, iso] of CODES) if (msisdn.startsWith(code)) return iso;
  return null;
}
