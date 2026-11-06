'use strict';

/**
 * Password strength estimation.
 *
 * Shared by the renderer (live meter while typing) and the main process (vault
 * health scoring), so it must run in both — hence the dual export at the bottom.
 *
 * This is a rough entropy estimate, not a substitute for a full cracking model.
 * It exists to steer users away from obviously bad passwords.
 */

(function (root) {
  const COMMON = new Set([
    'password', 'password1', 'passw0rd', '123456', '1234567', '12345678', '123456789',
    '1234567890', 'qwerty', 'qwerty123', 'letmein', 'welcome', 'admin', 'admin123',
    'iloveyou', 'monkey', 'dragon', 'football', 'baseball', 'abc123', 'sunshine',
    'princess', 'login', 'master', 'trustno1', 'starwars', 'whatever', 'changeme',
  ]);

  const SEQUENCES = [
    'abcdefghijklmnopqrstuvwxyz',
    '0123456789',
    'qwertyuiop',
    'asdfghjkl',
    'zxcvbnm',
  ];

  const LABELS = ['Very weak', 'Weak', 'Fair', 'Strong', 'Excellent'];

  /** Size of the character pool the password draws from. */
  function poolSize(pw) {
    let pool = 0;
    if (/[a-z]/.test(pw)) pool += 26;
    if (/[A-Z]/.test(pw)) pool += 26;
    if (/[0-9]/.test(pw)) pool += 10;
    if (/[^A-Za-z0-9]/.test(pw)) pool += 33;
    return pool || 1;
  }

  /** True if the password contains a run of 4+ keyboard/alphabet neighbours. */
  function hasSequence(pw) {
    const low = pw.toLowerCase();
    for (const seq of SEQUENCES) {
      for (let i = 0; i + 4 <= seq.length; i++) {
        const chunk = seq.slice(i, i + 4);
        if (low.includes(chunk)) return true;
        if (low.includes([...chunk].reverse().join(''))) return true;
      }
    }
    return false;
  }

  /** Number of distinct characters relative to length — catches "aaaaaaaa". */
  function repetitionPenalty(pw) {
    if (!pw) return 1;
    const unique = new Set(pw).size;
    const ratio = unique / pw.length;
    if (ratio < 0.35) return 0.4;
    if (ratio < 0.55) return 0.7;
    return 1;
  }

  /**
   * @returns {{score: 0|1|2|3|4, label: string, bits: number, entropy: number}}
   */
  function estimate(password) {
    const pw = String(password || '');
    if (!pw) return { score: 0, label: 'Empty', bits: 0, entropy: 0 };

    const base = pw.length * Math.log2(poolSize(pw));
    let bits = base * repetitionPenalty(pw);

    // A password that is only a common word/number (ignoring trivial leetspeak)
    // is guessed from a dictionary, not by brute force.
    const stripped = pw.toLowerCase().replace(/[!@#$%^&*_.\-]/g, '');
    if (COMMON.has(stripped)) bits = Math.min(bits, 12);
    if (hasSequence(pw)) bits *= 0.65;
    if (/^\d+$/.test(pw)) bits *= 0.6;

    // "Summer2024!", "Fluffy99" — one capitalised word, some digits, maybe a
    // trailing symbol. Brute-force math flatters this shape badly; a real
    // cracker walks a wordlist with those mangles applied and gets it fast.
    if (/^[A-Z]?[a-z]{3,}[0-9]{1,4}[!@#$%^&*.?_-]{0,2}$/.test(pw)) bits *= 0.45;

    let score;
    if (bits < 28) score = 0;
    else if (bits < 42) score = 1;
    else if (bits < 60) score = 2;
    else if (bits < 84) score = 3;
    else score = 4;

    // Nothing short is ever called strong, however exotic the characters.
    if (pw.length < 8) score = Math.min(score, 1);
    else if (pw.length < 12) score = Math.min(score, 2);

    return { score, label: LABELS[score], bits: Math.round(bits), entropy: Math.round(bits) };
  }

  /** Bar fill percentage for a given score. */
  function widthFor(score) {
    return [8, 28, 52, 78, 100][score] ?? 0;
  }

  const api = { estimate, widthFor, LABELS };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OneKeyStrength = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
