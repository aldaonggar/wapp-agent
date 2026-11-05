// Calling code → most populous IANA zone of that country (a guess until the person confirms).
const ZONES: Record<string, string> = {
  "1": "America/New_York", "7": "Europe/Moscow", "77": "Asia/Almaty",
  "20": "Africa/Cairo", "27": "Africa/Johannesburg", "30": "Europe/Athens", "31": "Europe/Amsterdam",
  "32": "Europe/Brussels", "33": "Europe/Paris", "34": "Europe/Madrid", "36": "Europe/Budapest",
  "39": "Europe/Rome", "40": "Europe/Bucharest", "41": "Europe/Zurich", "43": "Europe/Vienna",
  "44": "Europe/London", "45": "Europe/Copenhagen", "46": "Europe/Stockholm", "47": "Europe/Oslo",
  "48": "Europe/Warsaw", "49": "Europe/Berlin", "52": "America/Mexico_City", "54": "America/Argentina/Buenos_Aires",
  "55": "America/Sao_Paulo", "57": "America/Bogota", "60": "Asia/Kuala_Lumpur", "61": "Australia/Sydney",
  "62": "Asia/Jakarta", "63": "Asia/Manila", "64": "Pacific/Auckland", "65": "Asia/Singapore",
  "66": "Asia/Bangkok", "81": "Asia/Tokyo", "82": "Asia/Seoul", "84": "Asia/Ho_Chi_Minh",
  "86": "Asia/Shanghai", "90": "Europe/Istanbul", "91": "Asia/Kolkata", "92": "Asia/Karachi",
  "234": "Africa/Lagos", "254": "Africa/Nairobi", "351": "Europe/Lisbon", "353": "Europe/Dublin",
  "358": "Europe/Helsinki", "374": "Asia/Yerevan", "375": "Europe/Minsk", "380": "Europe/Kyiv",
  "420": "Europe/Prague", "852": "Asia/Hong_Kong", "966": "Asia/Riyadh", "971": "Asia/Dubai",
  "972": "Asia/Jerusalem", "992": "Asia/Dushanbe", "994": "Asia/Baku", "995": "Asia/Tbilisi",
  "996": "Asia/Bishkek", "998": "Asia/Tashkent",
};

export function tzFromPhone(digits: string): string {
  for (let n = 3; n > 0; n--) {
    const zone = ZONES[digits.slice(0, n)];
    if (zone) return zone;
  }
  return "UTC";
}
