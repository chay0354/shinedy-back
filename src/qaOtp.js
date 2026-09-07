import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const file = join(tmpdir(), 'shinedy-qa-otp.json');

export function isQaOtpEnabled() {
  return process.env.NODE_ENV !== 'production';
}

export function rememberQaOtp(channel, dest, code) {
  if (!isQaOtpEnabled()) return;
  const row = {
    channel,
    dest,
    code,
    at: new Date().toISOString(),
  };
  let prev = {};
  try {
    prev = JSON.parse(process.env.__QA_OTP_CACHE || '{}');
  } catch {
    prev = {};
  }
  prev[`${channel}:${dest}`] = row;
  prev.last = row;
  process.env.__QA_OTP_CACHE = JSON.stringify(prev);
  try {
    writeFileSync(file, JSON.stringify(prev, null, 2));
  } catch (e) {
    console.error('qa otp write:', e.message || e);
  }
  console.log(`[qa] ${channel} code for ${dest}: ${code}`);
}
