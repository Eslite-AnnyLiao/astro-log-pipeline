'use strict';

function parseUA(ua) {
  if (!ua) return { browser: 'Unknown', os: 'Unknown' };
  let browser = 'Unknown';
  if (ua.includes('Chrome/') && !ua.includes('Edg/')) {
    const m = ua.match(/Chrome\/([\d.]+)/);
    browser = m ? `Chrome ${m[1]}` : 'Chrome';
  } else if (ua.includes('Firefox/')) {
    const m = ua.match(/Firefox\/([\d.]+)/);
    browser = m ? `Firefox ${m[1]}` : 'Firefox';
  } else if (ua.includes('Safari/') && !ua.includes('Chrome/')) {
    const m = ua.match(/Version\/([\d.]+).*Safari/);
    browser = m ? `Safari ${m[1]}` : 'Safari';
  } else if (ua.includes('Edg/')) {
    const m = ua.match(/Edg\/([\d.]+)/);
    browser = m ? `Edge ${m[1]}` : 'Edge';
  } else if (ua.includes('StatusCake')) {
    browser = 'StatusCake Bot';
  }
  let os = 'Unknown';
  if (ua.includes('Windows NT 10.0')) os = 'Windows 10/11';
  else if (ua.includes('Windows NT 6.1')) os = 'Windows 7';
  else if (ua.includes('Windows NT')) os = 'Windows';
  // iPhone/iPad UA 字串一律含有字面上的 "like Mac OS X"，必須先判斷才不會被下面的
  // Mac OS X 分支誤判成桌面版 macOS
  else if (ua.includes('iPhone')) os = 'iOS (iPhone)';
  else if (ua.includes('iPad')) os = 'iOS (iPad)';
  else if (ua.includes('Mac OS X')) {
    const m = ua.match(/Mac OS X ([\d_]+)/);
    os = m ? `macOS ${m[1].replace(/_/g, '.')}` : 'macOS';
  } else if (ua.includes('Android')) {
    const m = ua.match(/Android ([\d.]+)/);
    os = m ? `Android ${m[1]}` : 'Android';
  } else if (ua.includes('Linux')) os = 'Linux';
  return { browser, os };
}

function pct(sorted, p) {
  if (!sorted.length) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] * (1 - (idx - lo)) + sorted[hi] * (idx - lo);
}

module.exports = { parseUA, pct };
