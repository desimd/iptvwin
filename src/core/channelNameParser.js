// Best-effort split of a raw channel name into a clean display name plus a country/language code
// and a quality tag (port of ChannelNameParser.kt). Display only: channel.name itself is untouched.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ChannelNameParser = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Curated whitelist (not full ISO) to keep false positives like "ABC: NEWS" / "USA TODAY" away.
  const COUNTRY_CODES = new Set([
    'AF', 'AFG', 'AL', 'ALB', 'AM', 'ARM', 'AR', 'ARG', 'AS', 'ASIA', 'AT', 'AUT', 'AU', 'AUS', 'AZ', 'AZE',
    'BA', 'BD', 'BGD', 'BE', 'BEL', 'BG', 'BGR', 'BIH', 'BR', 'BRA',
    'CA', 'CAN', 'CB', 'CH', 'CHE', 'CL', 'CHL', 'CN', 'CHN', 'CO', 'COL', 'CR', 'CRB', 'CZ', 'CZE',
    'DE', 'DEU', 'DK', 'DNK', 'DZ', 'DZA',
    'EE', 'EG', 'EGY', 'EN', 'ENG', 'ES', 'ESP', 'EST', 'EU', 'EXYU',
    'FI', 'FIN', 'FR', 'FRA',
    'GB', 'GBR', 'GER', 'GH', 'GHA', 'GR', 'GRC',
    'HK', 'HKG', 'HR', 'HRV', 'HU', 'HUN',
    'ID', 'IDN', 'IE', 'IRL', 'IL', 'ISR', 'IN', 'IND', 'IQ', 'IRQ', 'IR', 'IRN', 'IT', 'ITA',
    'JAM', 'JM', 'JP', 'JPN',
    'KR', 'KOR', 'KW', 'KWT', 'KZ', 'KAZ',
    'LA', 'LAT', 'LB', 'LBN', 'LT', 'LTU', 'LU', 'LUX', 'LV', 'LVA',
    'MA', 'MAR', 'MD', 'MDA', 'ME', 'MK', 'MKD', 'MNE', 'MX', 'MEX', 'MY', 'MYS',
    'NG', 'NIG', 'NL', 'NLD', 'NO', 'NOR', 'NZ', 'NZL',
    'PAK', 'PH', 'PHL', 'PK', 'PL', 'POL', 'PT', 'PRT',
    'RO', 'ROU', 'RS', 'RU', 'RUS',
    'SA', 'SAU', 'SE', 'SWE', 'SG', 'SGP', 'SI', 'SK', 'SVK', 'SVN', 'SPN', 'SPA',
    'TH', 'THA', 'TN', 'TUN', 'TR', 'TUR', 'TW', 'TWN',
    'UA', 'UKR', 'UK', 'US', 'USA',
    'VOD', 'VIP',
    'VN', 'VNM',
    'ZA', 'ZAF'
  ]);

  // Only brackets/parens or one of : - | ┃ │ ｜ ● • · – — — never a bare space.
  const COUNTRY_PREFIX = /^\s*(?:\[([A-Za-z]{2,4})\]|\(([A-Za-z]{2,4})\)|([A-Za-z]{2,4})\s*[:\-|\u2503\u2502\uFF5C\u25CF\u2022\u00B7\u2013\u2014])\s*(.+)$/;

  const QUALITY_SRC = '\\b(4K|UHD|FHD|HD|SD|2160P?|1080P?I?|720P?|50FPS|60FPS)\\b';
  const QUALITY_FIRST = new RegExp(QUALITY_SRC, 'i');
  const QUALITY_ALL = new RegExp(QUALITY_SRC, 'ig');
  const HIDDEN_TAG = /\b(HEVC|H\.?265|H\.?264|AV1|AAC|AC3|RAW|BACKUP|ALT|LOCAL|CATCHUP|LQ|HQ|BKUP|BKP)\b/ig;
  // TEST / MULTI only stripped when bracketed or as MULTI-AUDIO/SUB/LANG, so "Test Cricket" survives.
  const HIDDEN_BRACKETED = /[\[(]\s*(?:TEST|MULTI(?:[ -]?(?:AUDIO|SUB|LANG\w*))?|LQ|HQ|BKUP|BKP)\s*[\])]/ig;
  const HIDDEN_MULTI = /\bMULTI[ -]?(?:AUDIO|SUB|LANG\w*)\b/ig;

  // Superscript marks providers use for quality (ᴴᴰ, ᶠᴴᴰ, ⁴ᴷ, ᴿᴬᵂ ...) -> plain ASCII.
  const SUPER_FROM = '\u1D2C\u1D2E\u1D30\u1D31\u1D33\u1D34\u1D35\u1D36\u1D37\u1D38\u1D39\u1D3A\u1D3C\u1D3E\u1D3F\u1D40\u1D41\u2C7D\u1D42\u1D43\u1D47\u1D9C\u1D48\u1D49\u1DA0\u1D4D\u02B0\u2071\u02B2\u1D4F\u02E1\u1D50\u207F\u1D52\u1D56\u02B3\u02E2\u1D57\u1D58\u1D5B\u02B7\u02E3\u02B8\u1DBB\u2070\u00B9\u00B2\u00B3\u2074\u2075\u2076\u2077\u2078\u2079';
  const SUPER_TO = 'ABDEGHIJKLMNOPRTUVWabcdefghijklmnoprstuvwxyz0123456789';

  function normalizeSuperscripts(s) {
    let plain = true;
    for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) >= 0xB2) { plain = false; break; }
    if (plain) return s; // fast path: nearly every name
    let out = '';
    let prevSuper = false;
    for (const c of s) {
      const i = SUPER_FROM.indexOf(c);
      if (i >= 0) {
        if (!prevSuper && out.length && /[\p{L}\p{N}]/u.test(out[out.length - 1])) out += ' ';
        out += SUPER_TO[i];
        prevSuper = true;
      } else {
        out += c;
        prevSuper = false;
      }
    }
    return out;
  }

  const TRIM_CHARS = ' \\-|:\\u2503\\u2502\\uFF5C\\u25CF\\u2022\\u00B7\\u2013\\u2014';
  const TRIM_RE = new RegExp('^[' + TRIM_CHARS + ']+|[' + TRIM_CHARS + ']+$', 'g');

  // -> { displayName, tag, country, quality }
  function parse(rawName) {
    let name = normalizeSuperscripts(String(rawName).trim());
    let country = null;

    const m = COUNTRY_PREFIX.exec(name);
    if (m) {
      const code = (m[1] || m[2] || m[3] || '').toUpperCase();
      if (code && COUNTRY_CODES.has(code)) { country = code; name = m[4].trim(); }
    }

    const q = QUALITY_FIRST.exec(name);
    const quality = q ? q[0].toUpperCase() : null;
    name = name.replace(QUALITY_ALL, ''); // strip every match, not just the shown one
    name = name.replace(HIDDEN_BRACKETED, '').replace(HIDDEN_MULTI, '').replace(HIDDEN_TAG, '');

    name = name
      .replace(/[\[(]\s*[\])]/g, '') // leftover empty brackets
      .replace(/\s{2,}/g, ' ')
      .replace(TRIM_RE, '')
      .trim();

    const tag = [country, quality].filter(Boolean).join(' \u00B7 ') || null;
    return { displayName: name || String(rawName), tag, country, quality };
  }

  return { parse, COUNTRY_CODES, _superTablesOk: SUPER_FROM.length === SUPER_TO.length };
});
