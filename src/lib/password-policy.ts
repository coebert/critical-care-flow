/**
 * NHS DTAC — password policy.
 *
 * NCSC guidance (Password administration for system owners, 2018) plus
 * Supabase Auth's HIBP check (enabled at the project level). We surface
 * clear rules to users up front rather than only after a rejected submit.
 */

export const PASSWORD_MIN_LENGTH = 12;

export interface PasswordCheckResult {
  ok: boolean;
  problems: string[];
}

export function checkPassword(password: string): PasswordCheckResult {
  const problems: string[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) {
    problems.push(`Use at least ${PASSWORD_MIN_LENGTH} characters.`);
  }
  const classes = [
    /[a-z]/.test(password),
    /[A-Z]/.test(password),
    /[0-9]/.test(password),
    /[^A-Za-z0-9]/.test(password),
  ].filter(Boolean).length;
  if (classes < 3) {
    problems.push("Mix at least three of: lower-case, upper-case, digits, symbols.");
  }
  if (/^(.)\1+$/.test(password)) {
    problems.push("Don't use a single repeated character.");
  }
  return { ok: problems.length === 0, problems };
}

export const PASSWORD_RULES_HINT =
  `At least ${PASSWORD_MIN_LENGTH} characters, mixing letters, numbers and symbols. ` +
  `Your password is also checked against known breach lists — if it's been leaked ` +
  `elsewhere, you'll be asked to pick a different one.`;
